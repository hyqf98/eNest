/** Lifecycle and host event forwarding, including Promise-settled save/close ACKs. */
import { ipcRenderer } from 'electron'
import { BEFORE_CLOSE_ACK_LOCAL_CAP_MS, SAVE_REQUEST_ACK_LOCAL_CAP_MS } from '@shared/constants'
import type { SaveRequestedEvent, SaveRequestedData } from '@shared/types/notice'
import * as IpcChannels from '@shared/types/ipc'
import { type PluginEventPayload } from '@shared/types/ipc'
import type { PluginLifecycleMessage, PluginLaunchMode } from '@shared/types/plugin'
import type {
  Listener,
  PluginEnterEvent,
  PluginOutEvent,
  PluginBeforeCloseEvent,
  PluginModeChangeEvent,
  PluginHotkeyEvent,
  PluginLocaleChangeEvent,
  NetDataEvent,
  NetCloseEvent,
  NetChunkEvent
} from '@shared/types/pluginApi'
import { launchModeFromQuery } from './pluginRpc'

/** 当前启动方式（mode-change 事件实时更新；缺省按 URL ?mode=，再缺省 shell） */
let currentLaunchMode: PluginLaunchMode | null = null

const listeners = new Map<string, Set<Listener>>()

function emit(event: string, data: unknown): void {
  const set = listeners.get(event)
  if (!set) return
  for (const cb of set) {
    try {
      cb(data)
    } catch {
      // 插件回调抛错不应影响其它监听器
    }
  }
}

/**
 * 派发事件并收集监听器返回的 thenable（Promise）。
 * 同步抛错转为失败结果；返回非 Promise 的监听器不参与等待。
 */
function emitAndCollectPromises(event: string, data: unknown): Promise<unknown>[] {
  const set = listeners.get(event)
  if (!set) return []
  const pending: Promise<unknown>[] = []
  for (const cb of set) {
    try {
      const ret = cb(data) as unknown
      if (
        ret !== null &&
        typeof ret === 'object' &&
        typeof (ret as Promise<unknown>).then === 'function'
      ) {
        pending.push(Promise.resolve(ret))
      }
    } catch (error) {
      pending.push(Promise.reject(error))
    }
  }
  return pending
}

/** 发送 beforeClose / save-requested ack；通道可能已随销毁关闭，失败静默（主进程有超时兜底） */
function sendBeforeCloseAck(event: 'beforeClose' | 'beforeSuspend' | 'save-requested', operationId: string, success = true): void {
  try {
    ipcRenderer.send(IpcChannels.PluginLifecycleAck, { event, operationId, success })
  } catch {
    // 通道可能已随销毁关闭
  }
}

export function onPluginEvent(event: string, cb: Listener): void {
    if (!listeners.has(event)) listeners.set(event, new Set())
    listeners.get(event)!.add(cb)
  }

export function offPluginEvent(event: string, cb: Listener): void {
    listeners.get(event)?.delete(cb)
  }

export function getLaunchMode(): PluginLaunchMode {
  return currentLaunchMode ?? launchModeFromQuery() ?? 'shell'
}

export function bindPluginEventBridge(): void {
  ipcRenderer.on(IpcChannels.PluginLifecycle, (_e, message: PluginLifecycleMessage) => {
    if (!message || typeof message !== 'object') return
    switch (message.event) {
      case 'enter':
        emit('enter', {
          tabId: message.tabId,
          mode: message.mode ?? 'shell',
          code: message.code,
          type: message.type,
          payload: message.payload,
          input: message.input
        } satisfies PluginEnterEvent)
        break
      case 'out':
        emit('out', { isKill: false } satisfies PluginOutEvent)
        break
      case 'beforeSuspend':
      case 'beforeClose': {
        // 等插件回调返回的 Promise settle 后再 ack；无监听器 / 纯同步回调时
        // 用微任务确认（同步 IPC 已按序发出），避免隐藏页 timer 节流。主进程另有超时兜底。
        const pending = emitAndCollectPromises(message.event, message.event === 'beforeClose' ? { reason: message.reason } satisfies PluginBeforeCloseEvent : undefined)
        let acked = false
        const ackOnce = (success = true) => {
          if (acked) return
          acked = true
          sendBeforeCloseAck(message.event, message.operationId, success)
        }
        if (pending.length > 0) {
          // 任一 handler 返回 Promise 即等待全部 settle；本地 cap 防悬挂
          const cap = setTimeout(() => ackOnce(false), BEFORE_CLOSE_ACK_LOCAL_CAP_MS)
          Promise.allSettled(pending).then((results) => {
            clearTimeout(cap)
            ackOnce(results.every((result) => result.status === 'fulfilled'))
          })
        } else {
          queueMicrotask(() => ackOnce())
        }
        break
      }
      case 'destroy':
        emit('destroy', undefined)
        break
    }
  })
  ipcRenderer.on(IpcChannels.PluginEvent, (_e, payload: PluginEventPayload) => {
    if (!payload || typeof payload !== 'object') return
    switch (payload.type) {
      case 'backend.event':
      case 'background.event': {
        emit(payload.type, { event: payload.event, data: payload.data })
        break
      }
      case 'auxiliary.message': {
        emit(payload.type, { windowId: payload.windowId, data: payload.data })
        break
      }
      case 'auxiliary.closed': {
        emit(payload.type, { windowId: payload.windowId })
        break
      }
      case 'auxiliary.changed': {
        emit(payload.type, { windowId: payload.windowId, state: payload.state })
        break
      }
      case 'quick-input-change': {
        emit(payload.type, payload.value)
        break
      }
      case 'quick-input-action': {
        emit(payload.type, payload.action)
        break
      }
      case 'settings-change': {
        emit(payload.type, { key: payload.key, value: payload.value })
        break
      }
      case 'deadline-task-change': {
        emit(payload.type, { taskId: payload.taskId })
        break
      }
      case 'theme-change': {
        emit('theme-change', { mode: payload.mode, tokens: payload.tokens })
        break
      }
      case 'appearance-change': {
        emit('appearance-change', { appearance: payload.appearance })
        break
      }
      case 'hotkey': {
        emit('hotkey', { accelerator: payload.accelerator } satisfies PluginHotkeyEvent)
        break
      }
      case 'locale-change': {
        emit('locale-change', { locale: payload.locale } satisfies PluginLocaleChangeEvent)
        break
      }
      case 'mode-change': {
        // 启动方式变更（quick ↔ shell 迁移不重载）：更新真值并通知插件切换入口样式
        currentLaunchMode = payload.mode
        emit('mode-change', { mode: payload.mode } satisfies PluginModeChangeEvent)
        break
      }
      case 'quick-query': {
        // Quick 搜索 provider 查询：enest.contribute.onQuickQuery / enest.on('quick-query')
        emit('quick-query', { reqId: payload.reqId, query: payload.query })
        break
      }
      case 'quick-query-cancel': {
        emit('quick-query-cancel', { reqId: payload.reqId })
        break
      }
      case 'net.data': {
        // net.socket 数据分片：enest.net.onNetData / enest.on('net.data')
        emit('net.data', { socketId: payload.socketId, chunk: payload.chunk } satisfies NetDataEvent)
        break
      }
      case 'net.close': {
        // net.socket 关闭：enest.net.onNetClose / enest.on('net.close')
        emit('net.close', { socketId: payload.socketId, reason: payload.reason } satisfies NetCloseEvent)
        break
      }
      case 'net.chunk': {
        // net.fetch 流式分片 / SSE 行：enest.net.onChunk / enest.on('net.chunk')
        emit('net.chunk', {
          reqId: payload.reqId,
          chunk: payload.chunk,
          ...(payload.done !== undefined ? { done: payload.done } : {}),
          ...(payload.error !== undefined ? { error: payload.error } : {})
        } satisfies NetChunkEvent)
        break
      }
      case 'shell-notice': {
        // 壳统一通知：enest.onNotice / enest.on('shell-notice')；save.requested 带确认语义
        emit('shell-notice', payload.notice)
        if (payload.notice?.topic === 'save.requested') {
          const data = payload.notice.data as SaveRequestedData
          // 与 beforeClose 同款 ack：等 save-requested 回调返回的 Promise settle 后上报
          const pending = emitAndCollectPromises('save-requested', {
            reason: data.reason,
            deadlineMs: data.deadlineMs,
            operationId: data.operationId
          } satisfies SaveRequestedEvent)
          let acked = false
          const ackOnce = (success = true) => {
            if (acked) return
            acked = true
            sendBeforeCloseAck('save-requested', data.operationId, success)
          }
          if (pending.length > 0) {
            const cap = setTimeout(() => ackOnce(false), SAVE_REQUEST_ACK_LOCAL_CAP_MS)
            Promise.allSettled(pending).then((results) => {
              clearTimeout(cap)
              ackOnce(results.every((result) => result.status === 'fulfilled'))
            })
          } else {
            queueMicrotask(() => ackOnce())
          }
        }
        break
      }
      case 'net.websocket.message':
        emit(payload.type, { socketId: payload.socketId, data: payload.data, binary: payload.binary })
        break
      case 'net.websocket.close':
        emit(payload.type, { socketId: payload.socketId, code: payload.code, reason: payload.reason })
        break
      default: {
        // Every declared host event must have a bridge; unknown runtime payloads are ignored.
        const unhandled: never = payload
        void unhandled
      }
    }
  })
}
