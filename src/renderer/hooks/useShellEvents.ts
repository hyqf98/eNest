/**
 * useShellEvents — 订阅主进程 shell 事件
 * 将 IPC 事件（插件变更/Tab 关闭/插件错误/设置分组等）派发到 shellStore 与 toast。
 * 依赖：shellApi.onEvent、shellStore、toastStore。
 */
import { useEffect } from 'react'
import type { ShellEventPayload } from '@shared/types/ipc'
import { shellApi } from '../services/shellApi'
import { useShellStore } from '../stores/shellStore'
import { toastStore } from './useToast'

function handleEvent(payload: ShellEventPayload): void {
  const store = useShellStore.getState()
  switch (payload.type) {
    case 'plugins-changed':
      void store.refreshPlugins()
      break
    case 'tab-closed':
      store.removeTabLocal(payload.tabId)
      break
    case 'plugin-error':
      store.setPluginError(payload.message)
      store.appendLog('warn', `[plugin] ${payload.pluginId}: ${payload.message}`)
      toastStore.getState().push(`插件错误：${payload.message}`)
      break
    case 'plugin-toast':
      toastStore.getState().push(payload.message, payload.toastType ?? 'info')
      break
    case 'theme-changed':
      /* useTheme owns DOM apply; event is informational */
      break
    case 'settings-sections':
      store.appendLog('info', `[settings] sections updated (${(payload.sections as unknown[]).length})`)
      break
    case 'install-result':
      // 统一 shell toast：成功/失败都带插件名，失败附错误信息
      if (payload.ok) {
        toastStore.getState().push(`插件「${payload.name}」安装成功`)
      } else {
        toastStore.getState().push(
          `插件「${payload.name}」安装失败：${payload.error ?? '未知错误'}`
        )
      }
      void store.refreshPlugins()
      break
    case 'uninstall-result':
      // 与 install-result 同级：成功/失败都 toast，并刷新插件列表
      if (payload.ok) {
        toastStore.getState().push(`插件「${payload.name}」已卸载`, 'success')
      } else {
        toastStore.getState().push(
          `插件「${payload.name}」卸载失败：${payload.error ?? '未知错误'}`,
          'error'
        )
      }
      void store.refreshPlugins()
      break
    case 'quick-hotkey-failed':
      toastStore
        .getState()
        .push(
          payload.failed.length > 0
            ? `快捷键占用：${payload.failed.join('、')}${payload.registered.length ? `（已启用 ${payload.registered.join('、')}）` : ''}`
            : '快捷键注册失败',
          'warn'
        )
      break
    case 'quick-open-view':
      store.setView(payload.view)
      break
    case 'quick-config-changed':
      store.appendLog('info', `[quick] hotkeys: ${payload.hotkeys.join(', ') || '(none)'}`)
      break
  }
}

/** 在 ShellLayout 挂载时注册 IPC 事件监听，卸载时取消订阅 */
export function useShellEvents(): void {
  useEffect(() => {
    const off = shellApi.onEvent(handleEvent)
    return off
  }, [])
}
