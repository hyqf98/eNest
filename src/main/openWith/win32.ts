import { existsSync } from 'node:fs'
import { win32 } from 'node:path'
import { app, shell } from 'electron'
import { validOpenWithValue, type OpenWithStatus } from '@shared/types/openWith'
import { registrationAvailable, run, type OpenWithKind, type OpenWithRegistrar } from './registrar'

const capabilities = 'Software\\eNest\\Capabilities'
const registeredApps = 'Software\\RegisteredApplications'
const settingsHint = '已注册为候选，请在 Windows「设置 → 应用 → 默认应用」中选择 eNest。'

function systemTool(...parts: string[]): string {
  return win32.join(process.env.SystemRoot || 'C:\\Windows', 'System32', ...parts)
}

function powerShell(): string { return systemTool('WindowsPowerShell', 'v1.0', 'powershell.exe') }

function supports(kind: OpenWithKind, value: string): boolean {
  return registrationAvailable() && !process.windowsStore && typeof value === 'string' && validOpenWithValue(kind, value)
}

function available(kind: OpenWithKind, value: string): boolean {
  return supports(kind, value) && existsSync(powerShell()) && existsSync(systemTool('reg.exe'))
}

function association(kind: OpenWithKind, value: string) {
  return kind === 'ext'
    ? { type: 0, name: `.${value}`, progId: `eNest.${value}`, group: 'FileAssociations' }
    : { type: 1, name: value, progId: 'eNest.Url.Handler', group: 'URLAssociations' }
}

async function writeValue(key: string, name: string | null, data: string): Promise<void> {
  const result = await run(systemTool('reg.exe'), ['add', `HKCU\\${key}`, ...(name === null ? ['/ve'] : ['/v', name]), '/t', 'REG_SZ', '/d', data, '/f'])
  if (result.code !== 0) throw new Error(result.stderr.trim() || '无法注册 Windows 打开方式候选')
}

async function registerCandidate(kind: OpenWithKind, value: string): Promise<void> {
  const row = association(kind, value)
  const handler = `Software\\Classes\\${row.progId}`
  const exe = app.getPath('exe')
  await writeValue(handler, null, `eNest ${kind === 'ext' ? value.toUpperCase() : 'URL'}`)
  if (kind === 'scheme') await writeValue(handler, 'URL Protocol', '')
  await writeValue(`${handler}\\DefaultIcon`, null, `"${exe}",0`)
  await writeValue(`${handler}\\shell\\open\\command`, null, `"${exe}" -- "%1"`)
  if (kind === 'ext') await writeValue(`Software\\Classes\\${row.name}\\OpenWithProgids`, row.progId, '')
  await writeValue(capabilities, 'ApplicationName', 'eNest')
  await writeValue(capabilities, 'ApplicationDescription', 'eNest desktop shell')
  await writeValue(`${capabilities}\\${row.group}`, row.name, row.progId)
  await writeValue(registeredApps, 'eNest', capabilities)
}

const queryAssociation = String.raw`
$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = [Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$row = [Console]::In.ReadToEnd() | ConvertFrom-Json
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Text;
[ComImport, Guid("4e530b0a-e611-4c77-a3ac-9031d022281b"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IApplicationAssociationRegistration {
  [PreserveSig] int QueryCurrentDefault([MarshalAs(UnmanagedType.LPWStr)] string name, int type, int level, [MarshalAs(UnmanagedType.LPWStr)] out string progId);
}
public static class ShellAssociation {
  const int AL_EFFECTIVE = 1, NO_ASSOCIATION = unchecked((int)0x80070483), NOT_FOUND = unchecked((int)0x80070002);
  const uint ASSOCF_INIT_FIXED_PROGID = 0x800, ASSOCSTR_EXECUTABLE = 2;
  [DllImport("shlwapi.dll", CharSet = CharSet.Unicode, ExactSpelling = true)]
  static extern int AssocQueryStringW(uint flags, uint query, string progId, string verb, StringBuilder result, ref uint size);
  [DllImport("shell32.dll")] public static extern void SHChangeNotify(int change, uint flags, IntPtr first, IntPtr second);
  public static string Current(string name, int type) {
    var registration = (IApplicationAssociationRegistration)Activator.CreateInstance(Type.GetTypeFromCLSID(new Guid("591209c7-767b-42b2-9fba-44ee4615f2c7")));
    string progId;
    int result = registration.QueryCurrentDefault(name, type, AL_EFFECTIVE, out progId);
    if (result == NO_ASSOCIATION || result == NOT_FOUND) return null;
    Marshal.ThrowExceptionForHR(result);
    return progId;
  }
  public static string Executable(string progId) {
    if (String.IsNullOrEmpty(progId)) return null;
    uint size = 32768;
    var path = new StringBuilder((int)size);
    return AssocQueryStringW(ASSOCF_INIT_FIXED_PROGID, ASSOCSTR_EXECUTABLE, progId, null, path, ref size) == 0 ? path.ToString() : null;
  }
}
'@
if ($row.notify) { [ShellAssociation]::SHChangeNotify(0x08000000, 0, [IntPtr]::Zero, [IntPtr]::Zero) }
$current = [ShellAssociation]::Current($row.name, $row.type)
$selected = [ShellAssociation]::Executable($current)
$choices = @()
$registered = [Microsoft.Win32.Registry]::GetValue(('HKEY_CURRENT_USER\' + $row.registeredApps), 'eNest', $null)
if ($registered -eq $row.capabilities) {
  $handler = [Microsoft.Win32.Registry]::GetValue(('HKEY_CURRENT_USER\' + $registered + '\' + $row.group), $row.name, $null)
  if ($handler -eq $row.progId) { $choices += $handler }
}
if ($row.type -eq 0) {
  $key = [Microsoft.Win32.Registry]::ClassesRoot.OpenSubKey(($row.name + '\OpenWithProgids'))
  if ($key) {
    try { $choices += $key.GetValueNames() } finally { $key.Dispose() }
  }
}
$candidates = @($choices | Select-Object -Unique | ForEach-Object { [ShellAssociation]::Executable($_) } | Where-Object { $_ })
@{ selected = $selected; resolved = (-not $current -or [bool]$selected); candidates = $candidates } | ConvertTo-Json -Compress
`

async function detect(kind: OpenWithKind, value: string, notify = false): Promise<OpenWithStatus | undefined> {
  if (!supports(kind, value)) return undefined
  const input = { ...association(kind, value), capabilities, registeredApps, notify }
  const result = await run(powerShell(), ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(queryAssociation, 'utf16le').toString('base64')], 8000, JSON.stringify(input))
  if (result.code !== 0) return undefined
  try {
    const answer = JSON.parse(result.stdout)
    if (!answer || (answer.selected !== null && typeof answer.selected !== 'string') || typeof answer.resolved !== 'boolean'
      || !Array.isArray(answer.candidates) || answer.candidates.some((path: unknown) => typeof path !== 'string')) return undefined
    const exe = win32.toNamespacedPath(app.getPath('exe')).toLowerCase()
    const ours = (path: string | null) => Boolean(path && win32.isAbsolute(path) && win32.toNamespacedPath(path).toLowerCase() === exe)
    return ours(answer.selected) ? 'default' : answer.candidates.some(ours) ? 'candidate' : answer.resolved ? 'unregistered' : undefined
  } catch { return undefined }
}

export const win32Registrar: OpenWithRegistrar = {
  caps(kind, value) { return { canSetDefault: false, needsSystemSettings: available(kind, value) } },

  async setDefault(kind, value) {
    if (!available(kind, value)) return { ok: false, error: '当前类型或安装环境不支持 Windows 候选注册' }
    try { await registerCandidate(kind, value) }
    catch (error) { return { ok: false, error: error instanceof Error ? error.message : 'Windows 候选注册失败' } }
    const status = await detect(kind, value, true)
    if (status === 'default') return { ok: true, status }
    if (status === 'candidate') return { ok: true, status, hint: settingsHint }
    return { ok: false, status, error: '未能从 Windows 确认 eNest 的打开方式；请检查系统默认应用设置' }
  },

  detect,
  async openSystemSettings() { await shell.openExternal('ms-settings:defaultapps') }
}
