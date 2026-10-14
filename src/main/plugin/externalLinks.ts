/**
 * externalLinks — 插件页外链引流
 * 职责：拦截插件 webContents 的 window.open / will-navigate，把站外链接
 *       经完整门禁（协议白名单 + manifest 声明 + 壳层 grant 弹窗）后交
 *       shell.openExternal 在默认浏览器打开，插件页内不跳转。
 * 被 PluginHost（创建 WebContentsView 处）调用。
 * 关键依赖：pluginRegistry（manifest）、pluginHandlers 的门禁实现。
 */
import type { PluginManifest } from '@shared/types/plugin'
import { EXTERNAL_URL_PROTOCOLS } from '@shared/constants'
import { pluginRegistry } from '@main/plugin/PluginRegistry'
import { assertPermission } from '@main/plugin/PluginPermissions'
import { permissionService } from '@main/plugin/PermissionService'
import { logInfo, logWarn } from '@main/logs/logService'
import { shell } from 'electron'
import { getRuntimeScope } from '@main/plugin/PluginRuntimeScope'

/**
 * 引流一条站外 URL：
 * - 协议不在 http/https/mailto/tel → 忽略并记日志（javascript: 等危险协议）；
 * - manifest 未声明 shell.openExternal → 记日志拒绝（无弹窗，声明是前置）；
 * - 壳层 grant='ask' → 弹窗询问（与 plugin:call 同一 PermissionService 队列）；
 * - 通过后 shell.openExternal。
 */
export async function routeExternal(pluginId: string, rawUrl: string): Promise<void> {
  const scope = getRuntimeScope(pluginId)
  if (!scope || scope.signal.aborted) return
  const url = String(rawUrl ?? '')
  let protocol: string
  try {
    protocol = new URL(url).protocol
  } catch {
    logWarn('external', `${pluginId}: ignore unparseable url ${url.slice(0, 120)}`)
    return
  }
  if (!EXTERNAL_URL_PROTOCOLS.has(protocol)) {
    logWarn('external', `${pluginId}: ignore non-routable scheme ${protocol}`)
    return
  }
  const manifest: PluginManifest | null = pluginRegistry.getManifest(pluginId)
  if (!manifest) {
    logWarn('external', `${pluginId}: manifest missing, refuse external nav`)
    return
  }
  try {
    assertPermission(manifest, 'shell.openExternal')
  } catch {
    logWarn('external', `${pluginId}: shell.openExternal not declared, refuse nav`)
    return
  }
  const grant = await permissionService.request(
    pluginId,
    'shell.openExternal',
    `shell.openExternal ${url.slice(0, 120)}`
  )
  if (!scope.isCurrent() || scope.signal.aborted) return
  if (!grant) {
    logInfo('external', `${pluginId}: user denied external nav ${url.slice(0, 120)}`)
    return
  }
  await shell.openExternal(url).catch((err: Error) => {
    logWarn('external', `openExternal failed: ${err.message}`)
  })
}

/** Navigation remains in this plugin, or its explicitly registered development origin. */
export function isInternalNavigation(url: string, pluginId: string): boolean {
  try {
    const target = new URL(url)
    if (target.protocol === 'enest:') return target.hostname === 'plugin' && target.pathname.split('/')[1] === pluginId
    const devUrl = pluginRegistry.get(pluginId)?.devUrl
    return !!devUrl && target.origin === new URL(devUrl).origin
  } catch { return false }
}
