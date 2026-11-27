# Fixed JSON-line icon extractor for local app shortcuts.
# stdin:  {"id":1,"file":"C:\\App\\app.exe","index":0}   index=-1 → associated icon
# stdout: {"id":1,"icon":"<base64 png>"} / {"id":1,"error":"..."}
# ExtractIconEx honors the shortcut's IconLocation index; ExtractAssociatedIcon
# covers paths without an explicit icon. Exits when the parent closes stdin.
$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = New-Object System.Text.UTF8Encoding($false)
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
Add-Type -AssemblyName System.Drawing
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class ENestIconNative {
  [DllImport("shell32.dll", CharSet = CharSet.Unicode)]
  public static extern uint ExtractIconEx(string file, int index, IntPtr[] large, IntPtr[] small, uint count);
  [DllImport("user32.dll")]
  public static extern bool DestroyIcon(IntPtr handle);
}
'@
function Convert-IconToBase64([System.Drawing.Icon]$icon) {
  $bitmap = $icon.ToBitmap()
  $stream = New-Object System.IO.MemoryStream
  try {
    $bitmap.Save($stream, [System.Drawing.Imaging.ImageFormat]::Png)
    return [Convert]::ToBase64String($stream.ToArray())
  } finally {
    $stream.Dispose(); $bitmap.Dispose()
  }
}
while ($null -ne ($line = [Console]::ReadLine())) {
  $requestId = 0
  try {
    if ($line.Length -gt 4096) { throw 'Request too large' }
    $request = $line | ConvertFrom-Json
    $requestId = [int]$request.id
    $file = [string]$request.file
    $index = if ($null -ne $request.index) { [int]$request.index } else { -1 }
    if (-not $file -or -not (Test-Path -LiteralPath $file)) { throw 'file not found' }
    $icon = $null
    if ($index -ge 0) {
      $large = New-Object IntPtr[] 1
      $small = New-Object IntPtr[] 1
      $count = [ENestIconNative]::ExtractIconEx($file, $index, $large, $small, 1)
      if ($count -gt 0 -and $large[0] -ne [IntPtr]::Zero) {
        try {
          $handleIcon = [System.Drawing.Icon]::FromHandle($large[0])
          $icon = Convert-IconToBase64 $handleIcon
          $handleIcon.Dispose()
        } finally { [ENestIconNative]::DestroyIcon($large[0]) | Out-Null }
      }
    }
    if (-not $icon) {
      $associated = [System.Drawing.Icon]::ExtractAssociatedIcon($file)
      if (-not $associated) { throw 'no icon' }
      try { $icon = Convert-IconToBase64 $associated } finally { $associated.Dispose() }
    }
    $result = @{ id = $requestId; icon = $icon } | ConvertTo-Json -Compress
  } catch {
    $result = @{ id = $requestId; error = $_.Exception.Message } | ConvertTo-Json -Compress
  }
  [Console]::Out.WriteLine($result)
  [Console]::Out.Flush()
}
