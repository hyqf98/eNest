import { homedir } from 'node:os'
import { posix, win32 } from 'node:path'

export interface LocalUserPathOptions {
  /** Required: relative input must never silently inherit Node's current directory. */
  baseDir: string
  homeDir?: string
  platform?: NodeJS.Platform
}

function fullyQualifiedWindowsPath(value: string): boolean {
  return /^[a-z]:[\\/]/i.test(value) || /^[\\/]{2}[^\\/]+[\\/][^\\/]+(?:[\\/]|$)/.test(value)
}

/** Unlike win32.isAbsolute, a root-relative path still needs an explicit drive. */
export function isAbsoluteLocalUserPath(value: string, platform: NodeJS.Platform = process.platform): boolean {
  if (typeof value !== 'string' || value.includes('\0') || /^[\\/]{2}[?.][\\/]/.test(value)) return false
  return platform === 'win32' ? fullyQualifiedWindowsPath(value) : posix.isAbsolute(value)
}

/**
 * Resolve a local, user-entered filesystem path, without invoking a shell.
 * Only ~ and ~/ expand to the current user's home (~\\ also works on Windows).
 * URLs, SSH/scp targets, ~otheruser, and ambiguous Windows C:relative paths fail.
 * This is lexical normalization, not a filesystem permission or containment check.
 * Callers still own realpath, file-handle ownership, and allowed-root validation.
 */
export function resolveLocalUserPath(input: string, options: LocalUserPathOptions): string {
  if (typeof input !== 'string' || !input.trim()) throw new Error('本地路径不能为空')
  if (input.includes('\0')) throw new Error('本地路径不能包含空字符')
  const windows = (options.platform ?? process.platform) === 'win32'
  const paths = windows ? win32 : posix
  const validBase = isAbsoluteLocalUserPath(options.baseDir, options.platform ?? process.platform)
  if (!validBase || options.baseDir.includes('\0')) throw new Error('本地路径需要明确的绝对基准目录')
  if (/^[\\/]{2}[?.][\\/]/.test(input)) throw new Error('不支持设备命名空间路径')

  const value = input
  if (value.startsWith('~')) {
    if (value !== '~' && !value.startsWith('~/') && !(windows && value.startsWith('~\\'))) {
      throw new Error('仅支持当前用户的 ~ 或 ~/ 路径')
    }
    const home = options.homeDir ?? homedir()
    if (!isAbsoluteLocalUserPath(home, options.platform ?? process.platform)) {
      throw new Error('当前用户目录不是有效的绝对路径')
    }
    // join keeps ~/ anchored at home even if the user repeats a separator.
    return paths.resolve(paths.join(home, value.slice(2)))
  }

  const drivePrefix = /^[a-z]:/i.test(value)
  if (drivePrefix) {
    if (!windows) throw new Error('当前系统不支持 Windows 盘符路径')
    if (!/^[a-z]:[\\/]/i.test(value)) throw new Error('请使用包含盘符的绝对路径，例如 C:\\目录')
  } else if (/^[a-z][a-z0-9+.-]*:/i.test(value) || /^[^/\\\s]+@[^/\\\s]+:/.test(value)) {
    throw new Error('这里需要本地路径，不能使用网址或 SSH 远端路径')
  }
  if (!windows && /^\\\\/.test(value)) throw new Error('当前系统不支持 Windows UNC 路径')
  if (windows && /^[\\/]{2}/.test(value) && !fullyQualifiedWindowsPath(value)) {
    throw new Error('UNC 路径需要服务器和共享目录')
  }
  return paths.resolve(options.baseDir, value)
}
