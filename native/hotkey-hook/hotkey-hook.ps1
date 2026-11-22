# Low-level keyboard hook helper for force-overriding occupied global shortcuts.
# Protocol: stdin lines configure the intercepted set (RESET / "<vk> <ctrl> <alt> <shift> <win>"),
# stdout emits one JSON object per event ({"event":"ready"} / {"event":"fire","vk":N}).
# Matched chords are swallowed with WH_KEYBOARD_LL, so the app that originally
# registered them never receives the key. Exit when the parent process disappears.
param([Parameter(Mandatory = $true)][int]$ParentPid)
$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = New-Object System.Text.UTF8Encoding($false)
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
Add-Type -AssemblyName System.Windows.Forms
Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Threading;

public static class ENestHotkeyHook {
  private const int WH_KEYBOARD_LL = 13;
  private const int WM_KEYDOWN = 0x0100, WM_KEYUP = 0x0101, WM_SYSKEYDOWN = 0x0104, WM_SYSKEYUP = 0x0105;
  private const int VK_SHIFT = 0x10, VK_CONTROL = 0x11, VK_MENU = 0x12, VK_LWIN = 0x5B, VK_RWIN = 0x5C;

  [DllImport("user32.dll", SetLastError = true)]
  private static extern IntPtr SetWindowsHookEx(int idHook, LowLevelKeyboardProc lpfn, IntPtr hMod, uint dwThreadId);
  [DllImport("user32.dll", SetLastError = true)]
  private static extern bool UnhookWindowsHookEx(IntPtr hhk);
  [DllImport("user32.dll")]
  private static extern IntPtr CallNextHookEx(IntPtr hhk, int nCode, IntPtr wParam, IntPtr lParam);
  [DllImport("user32.dll")]
  private static extern short GetKeyState(int nVirtKey);
  [DllImport("kernel32.dll", CharSet = CharSet.Auto)]
  private static extern IntPtr GetModuleHandle(string lpModuleName);

  [StructLayout(LayoutKind.Sequential)]
  private struct KBDLLHOOKSTRUCT { public uint vkCode, scanCode, flags, time; public UIntPtr extraInfo; }

  private delegate IntPtr LowLevelKeyboardProc(int nCode, IntPtr wParam, IntPtr lParam);

  private sealed class Item { public uint Vk; public bool Ctrl, Alt, Shift, Win; }

  private static readonly List<Item> items = new List<Item>();
  private static readonly HashSet<uint> swallowed = new HashSet<uint>();
  // The unmanaged side keeps a function pointer; the managed delegate must stay reachable.
  private static LowLevelKeyboardProc proc;
  private static IntPtr hook = IntPtr.Zero;

  private static bool Down(int vk) { return (GetKeyState(vk) & 0x8000) != 0; }

  public static void Start(int parentPid) {
    proc = Callback;
    hook = SetWindowsHookEx(WH_KEYBOARD_LL, proc, GetModuleHandle(null), 0);
    if (hook == IntPtr.Zero) throw new Exception("hook install failed (" + Marshal.GetLastWin32Error() + ")");
    new Thread(ReadConfig) { IsBackground = true }.Start();
    // A killed parent closes the stdin pipe; this watchdog also covers abnormal pipe states.
    new Thread(() => {
      while (true) {
        Thread.Sleep(2000);
        try { Process.GetProcessById(parentPid); } catch { Environment.Exit(0); }
      }
    }) { IsBackground = true }.Start();
  }

  private static void ReadConfig() {
    try {
      string line;
      while ((line = Console.In.ReadLine()) != null) {
        line = line.Trim();
        if (line.Length == 0) continue;
        if (line == "RESET") { lock (items) items.Clear(); continue; }
        string[] parts = line.Split(' ');
        uint vk;
        if (parts.Length != 5 || !uint.TryParse(parts[0], out vk) || vk == 0 || vk > 0xFF) continue;
        Item item = new Item { Vk = vk, Ctrl = parts[1] == "1", Alt = parts[2] == "1", Shift = parts[3] == "1", Win = parts[4] == "1" };
        lock (items) items.Add(item);
      }
    } catch { }
    Environment.Exit(0);
  }

  private static IntPtr Callback(int nCode, IntPtr wParam, IntPtr lParam) {
    try {
      if (nCode >= 0) {
        int msg = wParam.ToInt32();
        bool down = msg == WM_KEYDOWN || msg == WM_SYSKEYDOWN;
        bool up = msg == WM_KEYUP || msg == WM_SYSKEYUP;
        if (down || up) {
          KBDLLHOOKSTRUCT info = (KBDLLHOOKSTRUCT)Marshal.PtrToStructure(lParam, typeof(KBDLLHOOKSTRUCT));
          // A swallowed key's release always belongs to us, even if the config changed meanwhile.
          if (up) {
            bool wasSwallowed;
            lock (swallowed) wasSwallowed = swallowed.Remove(info.vkCode);
            if (wasSwallowed) return (IntPtr)1;
          }
          bool ctrl = Down(VK_CONTROL), alt = Down(VK_MENU), shift = Down(VK_SHIFT);
          bool win = Down(VK_LWIN) || Down(VK_RWIN);
          bool matched = false;
          if (down) {
            lock (items) {
              foreach (Item item in items) {
                if (item.Vk != info.vkCode || item.Ctrl != ctrl || item.Alt != alt
                    || item.Shift != shift || item.Win != win) continue;
                matched = true;
                break;
              }
            }
          }
          if (matched) {
            bool first;
            lock (swallowed) first = swallowed.Add(info.vkCode);
            if (first) {
              Console.Out.WriteLine("{\"event\":\"fire\",\"vk\":" + info.vkCode + "}");
              Console.Out.Flush();
            }
            return (IntPtr)1;
          }
        }
      }
    } catch { }
    return CallNextHookEx(hook, nCode, wParam, lParam);
  }
}
'@
[ENestHotkeyHook]::Start($ParentPid)
[Console]::Out.WriteLine('{"event":"ready"}')
[Console]::Out.Flush()
$context = New-Object System.Windows.Forms.ApplicationContext
[System.Windows.Forms.Application]::Run($context)
