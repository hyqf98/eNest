/**
 * pluginHandlers — 插件 IPC 调用分发器
 * 职责：接收插件 preload 发起的 `plugin:call`，校验发送者身份与权限，按 method 分发到具体实现；
 *       转发 `plugin:lifecycle-ack`（beforeClose 确认）到 PluginHost。
 * 被 registerPluginHandlers 在 index.ts 中注册。
 * 关键依赖：PluginHost（识别 sender）、PluginPermissions（权限断言）、SettingsStore、
 * PluginSettingsBridge、themePacks、pathsService（插件 storage 落盘位置）。
 */
import { clipboard, ipcMain, Notification, shell } from 'electron'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { dirname } from 'node:path'
import { toTabId } from '@shared/constants'
import type { PluginCallRequest, PluginCallResult } from '@shared/types/ipc'
import { IpcChannels } from '@shared/types/ipc'
import type { PluginManifest, PluginPermission, ThemePack } from '@shared/types/plugin'
import { resolvePluginUi } from '@shared/types/plugin'
import { pluginStorageFile } from '../paths/pathsService'
import { assertPermission } from '../plugin/PluginPermissions'
import { pluginHost } from '../plugin/PluginHost'
import { pluginRegistry } from '../plugin/PluginRegistry'
import { sessionBag } from '../plugin/PluginSessionStore'
import { resolveThemeTokens } from '../theme/resolveThemeCss'
import { pluginSettingsBridge } from '../settings/PluginSettingsBridge'
import { settingsStore } from '../settings/SettingsStore'
import { themePackRegistry } from '../theme/themePacks'
import { sendShellEvent } from '../window/createShellWindow'

/** 插件数据持久化文件路径：~/eNest/data/plugin-storage/{pluginId}.json */
function storageFile(pluginId: string): string {
  return pluginStorageFile(pluginId)
}

async function readStorage(pluginId: string): Promise<Record<string, unknown>> {
  const file = storageFile(pluginId)
  if (!existsSync(file)) return {}
  try {
    return JSON.parse(await readFile(file, 'utf-8'))
  } catch {
    return {}
  }
}

async function writeStorage(pluginId: string, data: Record<string, unknown>): Promise<void> {
  const file = storageFile(pluginId)
  await mkdir(dirname(file), { recursive: true })
  await writeFile(file, JSON.stringify(data, null, 2), 'utf-8')
}

/** method → 所需权限映射；null 表示无需权限（settings.get/set 由 Bridge 管控，theme.register 暂不设权限） */
const METHOD_PERMISSION: Record<string, PluginPermission | null> = {
  'ui.setTitle': 'ui.setTitle',
  'ui.setIcon': 'ui.setIcon',
  'ui.setBadge': 'ui.setBadge',
  'ui.resize': 'ui.resize',
  'ui.toast': 'ui.toast',
  'settings.register': 'settings.register',
  'settings.get': null,
  'settings.set': null,
  'storage.get': 'storage.local',
  'storage.set': 'storage.local',
  'storage.remove': 'storage.local',
  'storage.clear': 'storage.local',
  // 会话态存储：权限复用 storage.local（弱于持久化，无需单独声明）
  'storage.session.get': 'storage.local',
  'storage.session.set': 'storage.local',
  'storage.session.remove': 'storage.local',
  'storage.session.clear': 'storage.local',
  'clipboard.readText': 'clipboard.read',
  'clipboard.writeText': 'clipboard.write',
  'shell.openExternal': 'shell.openExternal',
  notify: 'notify',
  'theme.register': null,
  // 主题 Token 读取：所有插件可用（无需权限声明），用于主题感知绘制
  'theme.getTokens': null
}

/** 按 method 分发到具体实现，权限已在调用前校验 */
async function dispatch(
  pluginId: string,
  method: string,
  args: unknown[]
): Promise<unknown> {
  switch (method) {
    case 'ui.setTitle': {
      const title = String(args[0] ?? '')
      sendShellEvent({ type: 'plugin-title', tabId: toTabId(pluginId), title })
      return true
    }
    case 'ui.setIcon': {
      const icon = String(args[0] ?? '')
      sendShellEvent({ type: 'plugin-icon', tabId: toTabId(pluginId), icon })
      return true
    }
    case 'ui.setBadge': {
      const badge = (args[0] ?? '') as string | number
      sendShellEvent({ type: 'plugin-badge', tabId: toTabId(pluginId), badge })
      return true
    }
    case 'ui.resize': {
      return true
    }
    case 'ui.toast': {
      const payload = (args[0] ?? {}) as { message?: string; type?: string }
      const message = String(payload.message ?? '')
      if (!message) throw new Error('toast message required')
      const toastType = payload.type
      sendShellEvent({
        type: 'plugin-toast',
        pluginId,
        message,
        toastType:
          toastType === 'success' || toastType === 'warn' || toastType === 'error'
            ? toastType
            : 'info'
      })
      return true
    }
    case 'settings.register': {
      const section = args[0] as {
        id: string
        title: string
        items: Array<{
          key: string
          type: string
          label: string
          default?: unknown
        }>
      }
      if (!section?.id || !section.title) throw new Error('invalid settings section')
      pluginSettingsBridge.register(pluginId, {
        id: section.id,
        title: section.title,
        items: section.items ?? []
      })
      return true
    }
    case 'settings.get': {
      const key = String(args[0] ?? '')
      const fromBridge = pluginSettingsBridge.get(pluginId, key)
      if (fromBridge !== undefined) return fromBridge
      return settingsStore.getPluginSettings(pluginId)[key]
    }
    case 'settings.set': {
      const key = String(args[0] ?? '')
      const value = args[1]
      pluginSettingsBridge.set(pluginId, key, value)
      await settingsStore.setPluginSetting(pluginId, key, value)
      return true
    }
    case 'storage.get': {
      const key = String(args[0] ?? '')
      const bag = await readStorage(pluginId)
      return bag[key]
    }
    case 'storage.set': {
      const key = String(args[0] ?? '')
      const value = args[1]
      const bag = await readStorage(pluginId)
      bag[key] = value
      await writeStorage(pluginId, bag)
      return true
    }
    case 'storage.remove': {
      const key = String(args[0] ?? '')
      const bag = await readStorage(pluginId)
      delete bag[key]
      await writeStorage(pluginId, bag)
      return true
    }
    case 'storage.clear': {
      await writeStorage(pluginId, {})
      return true
    }
    case 'storage.session.get': {
      const key = String(args[0] ?? '')
      return sessionBag(pluginId).get(key)
    }
    case 'storage.session.set': {
      const key = String(args[0] ?? '')
      sessionBag(pluginId).set(key, args[1])
      return true
    }
    case 'storage.session.remove': {
      const key = String(args[0] ?? '')
      sessionBag(pluginId).delete(key)
      return true
    }
    case 'storage.session.clear': {
      sessionBag(pluginId).clear()
      return true
    }
    case 'clipboard.readText': {
      return clipboard.readText()
    }
    case 'clipboard.writeText': {
      clipboard.writeText(String(args[0] ?? ''))
      return true
    }
    case 'shell.openExternal': {
      const url = String(args[0] ?? '')
      // 仅允许 http(s) 协议，防止 file:// 或自定义协议注入
      if (!/^https?:\/\//i.test(url)) throw new Error('only http(s) urls allowed')
      await shell.openExternal(url)
      return true
    }
    case 'notify': {
      const payload = (args[0] ?? {}) as { title?: string; body?: string }
      new Notification({
        title: payload.title ?? 'eNest',
        body: payload.body ?? ''
      }).show()
      return true
    }
    case 'theme.register': {
      const pack = args[0] as ThemePack
      const saved = await themePackRegistry.register({
        ...pack,
        source: pack?.source || pluginId
      })
      sendShellEvent({ type: 'theme-packs-changed' })
      return saved
    }
    case 'theme.getTokens': {
      // 按插件 manifest.ui.preferredColorScheme 解析最终 Token
      const manifest = pluginRegistry.getManifest(pluginId)
      const ui = resolvePluginUi(manifest?.ui)
      return resolveThemeTokens(ui.preferredColorScheme)
    }
    default:
      throw new Error(`unknown method: ${method}`)
  }
}

/**
 * 注册 plugin:call IPC 处理器：校验 sender 身份、pluginId 匹配与权限后分发；
 * 另注册 plugin:lifecycle-ack，供插件确认 beforeClose（可选，Host 侧 300ms 超时兜底）。
 */
export function registerPluginHandlers(): void {
  ipcMain.handle(
    IpcChannels.PluginCall,
    async (event, request: PluginCallRequest): Promise<PluginCallResult> => {
      try {
        const senderId = event.sender.id
        // 仅允许 PluginHost 管理的 WebContents 发起调用
        const hostPluginId = pluginHost.getPluginIdByWebContentsId(senderId)
        if (!hostPluginId) {
          return { ok: false, error: 'unauthorized sender' }
        }
        // 防止插件伪造其他插件身份发起调用
        if (request.pluginId && request.pluginId !== hostPluginId) {
          return { ok: false, error: 'plugin id mismatch' }
        }
        const manifest: PluginManifest | null = pluginHost.getManifestForWebContents(senderId)
        if (!manifest) {
          return { ok: false, error: 'manifest not found' }
        }
        const { method, args = [] } = request
        // 权限为 null 表示该方法无需 manifest 声明（settings 由 Bridge 管控）
        const required = METHOD_PERMISSION[method]
        if (required === undefined) {
          return { ok: false, error: `unknown method: ${method}` }
        }
        if (required) {
          assertPermission(manifest, required)
        }
        const data = await dispatch(hostPluginId, method, args)
        return { ok: true, data }
      } catch (err) {
        return { ok: false, error: (err as Error).message }
      }
    }
  )

  // beforeClose ack：插件 preload 在收到 beforeClose 后可回 ack，Host 解除等待
  ipcMain.on(
    IpcChannels.PluginLifecycleAck,
    (event, payload?: { event?: string }) => {
      const hostPluginId = pluginHost.getPluginIdByWebContentsId(event.sender.id)
      if (!hostPluginId) return
      if (payload?.event === 'beforeClose') {
        pluginHost.ackBeforeClose(hostPluginId)
      }
    }
  )
}
