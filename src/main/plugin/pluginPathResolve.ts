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
import { isAbsoluteLocalUserPath, resolveLocalUserPath } from '@main/paths/userPath'
import type { PluginPathBase, PluginPathResolveInput, PluginPathResolveResult } from '@shared/types/plugin'
import { pluginDataDir } from './pluginPrivatePaths'

function baseDir(base: PluginPathBase, pluginId: string): string {
  if (base === 'data') return pluginDataDir(pluginId)
  if (base === 'cwd') return process.cwd()
  return homedir()
}

/**
 * 解析插件填写的本地路径。
 * 失败时不抛错，返回 `{ path: null, error }`，让插件可以直接把 error 展示给用户。
 */
export function resolvePluginPath(pluginId: string, input: PluginPathResolveInput): PluginPathResolveResult {
  const base = baseDir(input?.base ?? 'home', pluginId)
  const raw = typeof input?.input === 'string' ? input.input : ''
  const fail = (error: string): PluginPathResolveResult => ({ path: null, absolute: false, base, exists: false, error })
  if (input?.base !== undefined && !['home', 'data', 'cwd'].includes(input.base)) return fail('无效的路径基准目录')

  let resolved: string
  try {
    resolved = resolveLocalUserPath(raw, { baseDir: base })
  } catch (error) {
    return fail(error instanceof Error ? error.message : '路径无法解析')
  }

  let exists = false
  try { exists = existsSync(resolved) } catch { exists = false }
  return { path: resolved, absolute: raw.startsWith('~') || isAbsoluteLocalUserPath(raw), base, exists }
}
