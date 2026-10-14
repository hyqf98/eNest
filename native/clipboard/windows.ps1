# Fixed JSON-line protocol. User clipboard contents never become PowerShell code.
$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = New-Object System.Text.UTF8Encoding($false)
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
Add-Type -AssemblyName System.Windows.Forms
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class ENestClipboard {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern IntPtr GetClipboardOwner();
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);
  [StructLayout(LayoutKind.Sequential)] public struct INPUT { public uint type; public UNION data; }
  [StructLayout(LayoutKind.Explicit)] public struct UNION { [FieldOffset(0)] public KEYBDINPUT keyboard; [FieldOffset(0)] public MOUSEINPUT mouse; }
  [StructLayout(LayoutKind.Sequential)] public struct KEYBDINPUT { public ushort key, scan; public uint flags, time; public UIntPtr extra; }
  [StructLayout(LayoutKind.Sequential)] public struct MOUSEINPUT { public int x,y; public uint mouseData,flags,time; public UIntPtr extra; }
  [DllImport("user32.dll", SetLastError=true)] public static extern uint SendInput(uint n, INPUT[] inputs, int size);
  public static bool Paste() {
    INPUT[] inputs = new INPUT[4];
    for (int i=0;i<4;i++) { inputs[i].type=1; inputs[i].data.keyboard.key=(ushort)((i==0||i==3)?0x11:0x56); inputs[i].data.keyboard.flags=(uint)(i>=2?2:0); }
    return SendInput(4, inputs, Marshal.SizeOf(typeof(INPUT)))==4;
  }
}
'@
$capturedTarget = $null
while ($null -ne ($line = [Console]::ReadLine())) {
  $requestId = 0
  try {
    if ($line.Length -gt 1048576) { throw 'Request too large' }
    $request = $line | ConvertFrom-Json
    $requestId = $request.id
    $result = $null
    switch ($request.command) {
      'capabilities' { $result = @{files=$true;sourceApp=$true;paste=$true;permissionRequired=$false} }
      'requestPermission' { $result = @{files=$true;sourceApp=$true;paste=$true;permissionRequired=$false} }
      'target' {
        $window = [ENestClipboard]::GetForegroundWindow(); [uint32]$ownerPid = 0
        [void][ENestClipboard]::GetWindowThreadProcessId($window,[ref]$ownerPid)
        $capturedTarget = $null
        if ($ownerPid -gt 0) { $proc = Get-Process -Id $ownerPid; $token = [Guid]::NewGuid().ToString(); $capturedTarget = @{token=$token;window=$window;owner=$ownerPid;start=$proc.StartTime.Ticks}; $result = @{token=$token;name=$proc.ProcessName} }
      }
      'source' {
        $window = [ENestClipboard]::GetClipboardOwner(); [uint32]$ownerPid = 0
        [void][ENestClipboard]::GetWindowThreadProcessId($window,[ref]$ownerPid)
        if ($ownerPid -gt 0) { $proc = Get-Process -Id $ownerPid; $result = @{name=$proc.ProcessName;id=$proc.Path;evidence='owner'} }
      }
      'readFiles' { $result = @([Windows.Forms.Clipboard]::GetFileDropList() | ForEach-Object { [string]$_ }) }
      'writeFiles' {
        $files = New-Object System.Collections.Specialized.StringCollection
        if (@($request.paths).Count -eq 0 -or @($request.paths).Count -gt 1000) { throw 'Invalid files' }
        foreach ($item in $request.paths) { if (![IO.Path]::IsPathRooted($item) -or !(Test-Path -LiteralPath $item)) { throw 'File no longer exists' }; [void]$files.Add($item) }
        [Windows.Forms.Clipboard]::SetFileDropList($files); $result = $true
      }
      'paste' {
        if ($null -eq $capturedTarget -or $request.target -ne $capturedTarget.token) { throw 'Invalid target' }
        $window = $capturedTarget.window; [uint32]$expectedPid = $capturedTarget.owner; [uint32]$ownerPid = 0
        if ((Get-Process -Id $expectedPid).StartTime.Ticks -ne $capturedTarget.start) { throw '原应用已关闭' }
        [void][ENestClipboard]::GetWindowThreadProcessId($window,[ref]$ownerPid)
        if (![ENestClipboard]::IsWindow($window) -or $ownerPid -ne $expectedPid) { throw '原应用已关闭' }
        if ([ENestClipboard]::IsIconic($window)) { [void][ENestClipboard]::ShowWindow($window,9) }
        [void][ENestClipboard]::SetForegroundWindow($window)
        for ($i=0; $i -lt 30; $i++) { if ([ENestClipboard]::GetForegroundWindow() -eq $window) { break }; Start-Sleep -Milliseconds 10 }
        if ([ENestClipboard]::GetForegroundWindow() -ne $window) { throw '无法恢复原应用焦点' }
        if (![ENestClipboard]::Paste()) { throw '系统拒绝输入，目标应用可能以管理员身份运行' }
        $result = @{pasted=$true}
      }
      default { throw 'Unknown command' }
    }
    [Console]::WriteLine((@{id=$requestId;result=$result} | ConvertTo-Json -Depth 8 -Compress))
  } catch { [Console]::WriteLine((@{id=$requestId;error=$_.Exception.Message} | ConvertTo-Json -Compress)) }
}
