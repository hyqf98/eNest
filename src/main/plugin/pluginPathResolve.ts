/**
 * pluginPathResolve — 插件路径输入的统一解析（`shell.resolvePath`）。
 *
 * 职责：把插件设置里手写的路径（`~/Pictures`、`./assets`、裸相对路径、绝对路径）
 * 归一化成绝对路径，跨平台一致；宿主与插件共用同一套规则，插件不再各写一份。
 *
 * 边界：
 *  - 只做词法归一化 + 只读存在性探测，不创建目录、不做权限授予；
 *    解析成功不代表可读写，真实文件访问仍需 localFiles 句柄或插件自有 backend。
 *  - 拒绝 URL / SSH 远端路径 / 设备命名空间 / 其它用户的 `~user`，避免把非本地路径当目录用。
 */
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { posix, win32 } from 'node:path'
import type { PluginPathBase, PluginPathResolveInput, PluginPathResolveResult } from '@shared/types/plugin'
import { pluginDataDir } from './pluginPrivatePaths'

function baseDir(base: PluginPathBase, pluginId: string): string {
  if (base === 'data') return pluginDataDir(pluginId)
  if (base === 'cwd') return process.cwd()
  return homedir()
}

function fullyQualifiedWindowsPath(value: string): boolean {
  return /^[a-z]:[\\/]/i.test(value) || /^[\\/]{2}[^\\/]+[\\/][^\\/]+(?:[\\/]|$)/.test(value)
}

/**
 * 解析插件填写的本地路径。
 * 失败时不抛错，返回 `{ path: null, error }`，让插件可以直接把 error 展示给用户。
 */
export function resolvePluginPath(pluginId: string, input: PluginPathResolveInput): PluginPathResolveResult {
  const base = baseDir(input?.base ?? 'home', pluginId)
  const raw = typeof input?.input === 'string' ? input.input.trim() : ''
  const fail = (error: string): PluginPathResolveResult => ({ path: null, absolute: false, base, exists: false, error })

  if (!raw) return fail('路径不能为空')
  if (raw.includes('\0')) return fail('路径不能包含空字符')

  const windows = process.platform === 'win32'
  const paths = windows ? win32 : posix

  // 设备命名空间（\\?\ 与 //?/）与其它用户的 ~user 一律拒绝：它们不是用户能直接理解的目录。
  if (/^[\\/]{2}[?.][\\/]/.test(raw)) return fail('不支持设备命名空间路径')
  if (raw.startsWith('~') && raw !== '~' && !raw.startsWith('~/') && !(windows && raw.startsWith('~\\'))) {
    return fail('仅支持当前用户的 ~ 或 ~/ 路径')
  }
  // 网址 / SSH 远端：这类输入不属于本地路径。
  const withoutTilde = raw.startsWith('~') ? raw.slice(1) : raw
  if (!raw.startsWith('~') && (/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) || /^[^/\\\s]+@[^/\\\s]+:/.test(raw))) {
    return fail('这里需要本地路径，不能使用网址或 SSH 远端路径')
  }
  if (!windows && /^\\\\/.test(raw)) return fail('当前系统不支持 Windows UNC 路径')
  if (windows && /^[\\/]{2}/.test(raw) && !fullyQualifiedWindowsPath(raw)) return fail('UNC 路径需要服务器和共享目录')

  const absolute = raw.startsWith('~')
    || (windows ? fullyQualifiedWindowsPath(raw) : posix.isAbsolute(raw))
  if (windows && /^[a-z]:/i.test(raw) && !/^[a-z]:[\\/]/i.test(raw)) {
    return fail('请使用包含盘符的绝对路径，例如 C:\\目录')
  }
  if (windows && !absolute && /^[a-z]:/i.test(raw)) return fail('请使用包含盘符的绝对路径，例如 C:\\目录')
  if (!windows && /^[a-z]:/i.test(withoutTilde)) return fail('当前系统不支持 Windows 盘符路径')

  let resolved: string
  try {
    if (raw.startsWith('~')) {
      const home = homedir()
      if (!home || home.includes('\0')) return fail('当前用户目录不可用')
      resolved = paths.resolve(paths.join(home, raw.slice(2)))
    } else resolved = paths.resolve(base, raw)
  } catch {
    return fail('路径无法解析')
  }

  let exists = false
  try { exists = existsSync(resolved) } catch { exists = false }
  return { path: resolved, absolute, base, exists }
}
