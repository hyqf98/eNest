/**
 * forceHotkey — 「强制覆盖」被占用的全局快捷键。
 *
 * 平台调研结论（2026-11）：
 * - Windows：RegisterHotKey 无法抢占已被其他进程注册的键；唯一可行方案是
 *   WH_KEYBOARD_LL 低级键盘钩子，在系统把按键分发给 hotkey 之前吞掉事件。
 *   本模块通过 native/hotkey-hook/hotkey-hook.ps1 辅助进程实现（无需管理员）。
 * - macOS：需要 CGEventTap + 辅助功能（TCC）授权，Electron 无内置能力；
 *   当前版本不提供，返回明确原因。
 * - Linux(X11)：XGrabKey 对已被其他客户端 grab 的键返回 BadAccess，无法抢占；
 *   设备级拦截（evdev/uinput）需要 root，当前版本不提供。
 *   Wayland 只能走 portal，更无抢占可能。
 *
 * OS 保留键（Win+L、Alt+Tab 等）由系统在钩子之前处理，一律不可接管。
 * 被吞掉的组合键只有本应用能收到；卸载钩子即恢复原程序。
 */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { normalizeAccelerator } from '@shared/accelerator'
import { logWarn } from '@main/logs/logService'

export interface ForceHotkeyEntry { accelerator: string; onFire(): void }
export interface ForceHotkeyAvailability { ok: boolean; reason?: string }
export interface ForceHotkeyStatus { ready: boolean; error?: string }

/** VK 码表，键名与 shared/accelerator.ts 的规范化输出一致。 */
const VK_BY_KEY: Record<string, number> = {
  Space: 0x20, Tab: 0x09, Capslock: 0x14, Numlock: 0x90, Scrolllock: 0x91,
  Backspace: 0x08, Delete: 0x2E, Insert: 0x2D, Return: 0x0D, Escape: 0x1B,
  Up: 0x26, Down: 0x28, Left: 0x25, Right: 0x27, Home: 0x24, End: 0x23,
  PageUp: 0x21, PageDown: 0x22, PrintScreen: 0x2C,
  '`': 0xC0, '-': 0xBD, '=': 0xBB, '[': 0xDB, ']': 0xDD, '\\': 0xDC,
  ';': 0xBA, "'": 0xDE, ',': 0xBC, '.': 0xBE, '/': 0xBF,
  num0: 0x60, num1: 0x61, num2: 0x62, num3: 0x63, num4: 0x64,
  num5: 0x65, num6: 0x66, num7: 0x67, num8: 0x68, num9: 0x69,
  numdec: 0x6E, numadd: 0x6B, numsub: 0x6D, nummult: 0x6A, numdiv: 0x6F,
  VolumeUp: 0xAF, VolumeDown: 0xAE, VolumeMute: 0xAD, MediaNextTrack: 0xB0,
  MediaPreviousTrack: 0xB1, MediaStop: 0xB2, MediaPlayPause: 0xB3, MediaSelect: 0xB5
}
for (let code = 0x41; code <= 0x5A; code++) VK_BY_KEY[String.fromCharCode(code)] = code
for (let digit = 0; digit <= 9; digit++) VK_BY_KEY[String(digit)] = 0x30 + digit
for (let fn = 1; fn <= 24; fn++) VK_BY_KEY[`F${fn}`] = 0x6F + fn

/** 系统在钩子分发之前处理的组合键，任何方案都无法接管。 */
const RESERVED = new Set([
  'Super+L', 'Alt+Tab', 'Super+Tab', 'Control+Escape', 'Alt+Escape', 'Control+Alt+Delete'
])

interface ParsedAccelerator { vk: number; ctrl: boolean; alt: boolean; shift: boolean; win: boolean }

function parseAccelerator(acc: string): ParsedAccelerator | undefined {
  const parts = acc.split('+')
  const key = parts.pop()
  if (!key) return undefined
  const mods = new Set(parts)
  // Command 只在 macOS 有意义；Windows 下的 Super=Win 键。
  if (mods.has('Command')) return undefined
  const altGr = mods.has('AltGr')
  const vk = VK_BY_KEY[key]
  if (!vk) return undefined
  return {
    vk,
    ctrl: mods.has('Control') || altGr,
    alt: mods.has('Alt') || altGr,
    shift: mods.has('Shift'),
    win: mods.has('Super')
  }
}

let helperDir: string | undefined
let child: ChildProcessWithoutNullStreams | null = null
let ready = false
let lastError: string | undefined
/** vk → 当前接管条目（同一时刻只有 Quick 的一个生效键，按 vk 索引足够）。 */
let entries = new Map<number, { accelerator: string; onFire(): void }>()
const listeners = new Set<() => void>()

function changed(): void {
  for (const listener of listeners) {
    try { listener() } catch (error) { logWarn('hotkey', `force status listener failed: ${String(error)}`) }
  }
}

export function onForceHotkeyStatusChange(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** 主进程启动时注入辅助程序目录（打包前后路径不同）。 */
export function initForceHotkeys(dir: string): void { helperDir = dir }

function platformReason(): string | undefined {
  if (process.platform === 'win32') return helperDir ? undefined : '强制接管服务未初始化'
  if (process.platform === 'darwin') return 'macOS 需要辅助功能授权的事件监听，当前版本暂不支持强制覆盖'
  return 'Linux 无法抢占已被其他程序注册的组合键（需要 root 级设备权限）'
}

export function canForceHotkey(value: string): ForceHotkeyAvailability {
  const platform = platformReason()
  if (platform) return { ok: false, reason: platform }
  const acc = normalizeAccelerator(value, process.platform)
  if (!acc) return { ok: false, reason: '组合键无效' }
  if (RESERVED.has(acc)) return { ok: false, reason: '该组合键由系统保留（如锁屏、任务切换），无法接管' }
  if (!parseAccelerator(acc)) return { ok: false, reason: '该按键暂不支持强制接管' }
  return { ok: true }
}

function ensureChild(): ChildProcessWithoutNullStreams {
  if (child && child.exitCode === null && !child.killed) return child
  if (!helperDir) throw new Error('强制接管服务未初始化')
  const file = join(helperDir, 'hotkey-hook.ps1')
  if (!existsSync(file)) throw new Error('强制接管辅助程序未构建，请重新运行 npm run dev')
  const spawned = spawn('powershell.exe',
    ['-NoLogo', '-NoProfile', '-NonInteractive', '-STA', '-ExecutionPolicy', 'Bypass', '-File', file, '-ParentPid', String(process.pid)],
    { windowsHide: true, stdio: 'pipe' })
  child = spawned
  ready = false
  lastError = undefined
  createInterface({ input: spawned.stdout }).on('line', line => {
    if (line.length > 4096) return
    try {
      const message = JSON.parse(line) as { event?: string; vk?: number }
      if (message.event === 'ready') { ready = true; lastError = undefined; changed() }
      else if (message.event === 'fire' && typeof message.vk === 'number') {
        try { entries.get(message.vk)?.onFire() } catch (error) { logWarn('hotkey', `force callback failed: ${String(error)}`) }
      }
    } catch { /* 非协议输出忽略 */ }
  })
  spawned.stderr.resume()
  const close = (): void => {
    if (child === spawned) { child = null; ready = false }
    lastError = '强制接管服务已退出'
    changed()
  }
  spawned.on('error', close)
  spawned.on('exit', close)
  return spawned
}

function writeConfig(target: ChildProcessWithoutNullStreams): void {
  const lines = ['RESET', ...[...entries.values()].map(entry => {
    const parsed = parseAccelerator(entry.accelerator)!
    return `${parsed.vk} ${parsed.ctrl ? 1 : 0} ${parsed.alt ? 1 : 0} ${parsed.shift ? 1 : 0} ${parsed.win ? 1 : 0}`
  })]
  target.stdin.write(`${lines.join('\n')}\n`)
}

/** 用给定条目替换接管集合；空集合卸载钩子并恢复原程序。 */
export function applyForceHotkeys(list: ForceHotkeyEntry[]): { ok: boolean; error?: string } {
  const next = new Map<number, { accelerator: string; onFire(): void }>()
  for (const entry of list) {
    const acc = normalizeAccelerator(entry.accelerator, process.platform)
    if (!acc) return { ok: false, error: '组合键无效' }
    const availability = canForceHotkey(acc)
    if (!availability.ok) return { ok: false, error: availability.reason }
    const parsed = parseAccelerator(acc)!
    next.set(parsed.vk, { accelerator: acc, onFire: entry.onFire })
  }
  if (!next.size) { stopForceHotkeys(); return { ok: true } }
  try {
    const target = ensureChild()
    entries = next
    writeConfig(target)
    return { ok: true }
  } catch (error) {
    entries = new Map()
    lastError = error instanceof Error ? error.message : String(error)
    return { ok: false, error: lastError }
  }
}

export function isForceRegistered(value: string): boolean {
  const acc = normalizeAccelerator(value, process.platform)
  if (!acc || !ready) return false
  return [...entries.values()].some(entry => entry.accelerator === acc)
}

export function hasForceHotkeys(): boolean { return entries.size > 0 }

export function getForceHotkeyStatus(): ForceHotkeyStatus {
  return { ready, ...(lastError ? { error: lastError } : {}) }
}

export function stopForceHotkeys(): void {
  entries = new Map()
  ready = false
  const current = child
  child = null
  if (current && current.exitCode === null) {
    try { current.kill() } catch { /* 已退出 */ }
  }
}

export function disposeForceHotkeys(): void {
  stopForceHotkeys()
  listeners.clear()
}
