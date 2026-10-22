/**
 * useShellEvents — 订阅主进程 shell 事件
 * 将 IPC 事件（插件变更/Tab 关闭/插件错误/设置分组等）派发到 shellStore 与 toast。
 * 依赖：shellApi.onEvent、shellStore、toastStore。
 */
import { useEffect } from 'react'
import type { ShellEventPayload } from '@shared/types/ipc'
import { shellApi } from '@renderer/services/shellApi'
import { useShellStore } from '@renderer/stores/shellStore'
import { toastStore } from '@renderer/hooks/useToast'
import { notify } from '@renderer/services/notifyService'

function handleEvent(payload: ShellEventPayload): void {
  const store = useShellStore.getState()
  switch (payload.type) {
    case 'preview-splash':
      window.dispatchEvent(new Event('enest:preview-splash'))
      break
    case 'plugin-log':
      store.appendLog(payload.level, `[${payload.pluginId}] ${payload.message}`)
      break
    case 'plugin-open-settings':
      store.setSettingsTab(`p:${payload.pluginId}`)
      store.setView('settings')
      break
    case 'plugins-changed':
      void store.refreshPlugins()
      break
    case 'tab-closed':
      // 主进程紧接着发布 plugin-tabs；不使用旧事件猜测接班项。
      break
    case 'plugin-error':
      if (store.activeTabId === `t-${payload.pluginId}`) store.setPluginError(payload.message)
      store.appendLog('warn', `[plugin] ${payload.pluginId}: ${payload.message}`)
      toastStore.getState().push(`插件错误：${payload.message}`)
      break
    case 'plugin-toast':
      notify.custom(payload.notification ?? { body: payload.message ?? '', level: payload.toastType ?? 'info' })
      break
    case 'go-home':
      store.goHome()
      break
    case 'set-view':
      if (payload.sectionId) store.setSettingsTab(payload.sectionId)
      store.applyView(payload.view)
      break
    case 'settings-sections':
      store.appendLog('info', `[settings] sections updated (${(payload.sections as unknown[]).length})`)
      break
    case 'install-result':
      // The installation panel owns completion/errors; avoid duplicate toast stacks.
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
