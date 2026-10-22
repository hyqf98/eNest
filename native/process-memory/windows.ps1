# One fixed, read-only CIM query. Only identity and byte counters are serialized.
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)

function Get-ByteCount($Value) {
  if ($null -eq $Value) { return $null }
  try {
    $number = [decimal]$Value
    if ($number -lt 0 -or $number -gt 9007199254740991 -or [decimal]::Truncate($number) -ne $number) { return $null }
    return [long]$number
  } catch { return $null }
}

try {
  $properties = @('ProcessId', 'ParentProcessId', 'CreationDate', 'PrivatePageCount', 'WorkingSetSize')
  $processes = Get-CimInstance -ClassName Win32_Process -Property $properties -ErrorAction Stop
  $rows = New-Object 'System.Collections.Generic.List[object]'
  foreach ($entry in $processes) {
    $processId = [long]$entry.ProcessId
    if ($processId -le 0) { continue }
    $parentId = if ($null -eq $entry.ParentProcessId) { 0 } else { [long]$entry.ParentProcessId }
    $startedAt = 0L
    if ($null -ne $entry.CreationDate) {
      try {
        $created = $entry.CreationDate
        if ($created -isnot [DateTime]) {
          $created = [System.Management.ManagementDateTimeConverter]::ToDateTime([string]$created)
        }
        $startedAt = ([DateTimeOffset]($created.ToUniversalTime())).ToUnixTimeMilliseconds()
      } catch { $startedAt = 0L }
    }
    $privateBytes = Get-ByteCount $entry.PrivatePageCount
    $residentBytes = Get-ByteCount $entry.WorkingSetSize
    [void]$rows.Add([object[]]@($processId, $parentId, $startedAt, $privateBytes, $residentBytes))
  }
  # -InputObject and the array type preserve the outer array for empty/singleton snapshots.
  [object[]]$wireRows = $rows.ToArray()
  $json = ConvertTo-Json -InputObject $wireRows -Depth 3 -Compress
  if ([Text.Encoding]::UTF8.GetByteCount($json) + 2 -gt 2097152) { throw 'Process snapshot too large' }
  [Console]::WriteLine($json)
} catch {
  # Nonzero exit lets the caller discard partial/failed data instead of reporting zero usage.
  [Console]::Error.WriteLine('Process memory snapshot unavailable')
  exit 1
}
