import { forwardRef, useImperativeHandle, useLayoutEffect, useRef, useState } from 'react'
import type { QuickCommandKind } from '@shared/types/quick'
import type {
  QuickThemeAction,
  QuickThemeActionResult,
  QuickThemeConfig,
  QuickThemeSnapshot
} from '@shared/types/quickTheme'
import './QuickThemeSurface.css'

export interface QuickThemeSurfaceProps {
  config: QuickThemeConfig
  snapshot: QuickThemeSnapshot
  onAction: (action: QuickThemeAction) => Promise<QuickThemeActionResult>
  onReady: (ready: boolean) => void
  onFailure: () => void
}

export interface QuickThemeSurfaceHandle {
  focus(selectAll?: boolean): void
}

type HostMessage =
  | { type: 'state'; state: QuickThemeSnapshot }
  | { type: 'focus'; selectAll: boolean }
  | { type: 'action-result'; id: string; result: QuickThemeActionResult }

interface ThemeBridge {
  publishState(): void
  flushFocus(): void
}

const READY_TIMEOUT_MS = 8_000
const MESSAGE_LIMIT = 120
const REQUEST_ID_LIMIT = 128
const ITEM_ID_LIMIT = 256
const PENDING_ACTION_LIMIT = 32
const RECENT_ACTION_LIMIT = 256

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function hasOnlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).every(key => keys.includes(key))
}

function isString(value: unknown, limit: number, allowEmpty = false): value is string {
  return typeof value === 'string' && (allowEmpty || value.length > 0) && value.length <= limit
}

function isKind(value: unknown): value is QuickCommandKind {
  return value === 'app' || value === 'plugin' || value === 'action'
}

function readAction(value: unknown): QuickThemeAction | null {
  if (!isRecord(value)) return null
  switch (value.type) {
    case 'query':
      return hasOnlyKeys(value, ['type', 'query']) && isString(value.query, 4_096, true)
        ? { type: 'query', query: value.query } : null
    case 'filter':
      return hasOnlyKeys(value, ['type', 'kind']) && (value.kind === null || isKind(value.kind))
        ? { type: 'filter', kind: value.kind } : null
    case 'select':
      return hasOnlyKeys(value, ['type', 'id']) && isString(value.id, ITEM_ID_LIMIT)
        ? { type: 'select', id: value.id } : null
    case 'composition':
      return hasOnlyKeys(value, ['type', 'active']) && typeof value.active === 'boolean'
        ? { type: 'composition', active: value.active } : null
    case 'results': {
      if (!hasOnlyKeys(value, ['type', 'catalogRevision', 'queryRevision', 'items', 'selectedId', 'hiddenCount', 'emptyMarket', 'expanded'])
        || !Number.isSafeInteger(value.catalogRevision) || !Number.isSafeInteger(value.queryRevision)
        || !Array.isArray(value.items) || value.items.length > 100) return null
      const items: Array<{ id: string; title?: string; group?: string }> = []
      const seen = new Set<string>()
      for (const item of value.items) {
        if (!isRecord(item) || !hasOnlyKeys(item, ['id', 'title', 'group']) || !isString(item.id, ITEM_ID_LIMIT)
          || seen.has(item.id) || (item.title !== undefined && !isString(item.title, 256))
          || (item.group !== undefined && !isString(item.group, 64, true))) return null
        seen.add(item.id)
        items.push({ id: item.id, ...(typeof item.title === 'string' ? { title: item.title } : {}),
          ...(typeof item.group === 'string' ? { group: item.group } : {}) })
      }
      if (value.selectedId !== undefined && value.selectedId !== null && (!isString(value.selectedId, ITEM_ID_LIMIT) || !seen.has(value.selectedId))) return null
      if (value.hiddenCount !== undefined && (!Number.isSafeInteger(value.hiddenCount) || Number(value.hiddenCount) < 0 || Number(value.hiddenCount) > 8_192)) return null
      if (value.emptyMarket !== undefined && typeof value.emptyMarket !== 'boolean') return null
      if (value.expanded !== undefined && typeof value.expanded !== 'boolean') return null
      return { type: 'results', catalogRevision: Number(value.catalogRevision), queryRevision: Number(value.queryRevision), items,
        ...(value.selectedId !== undefined ? { selectedId: value.selectedId as string | null } : {}),
        ...(value.hiddenCount !== undefined ? { hiddenCount: Number(value.hiddenCount) } : {}),
        ...(typeof value.emptyMarket === 'boolean' ? { emptyMarket: value.emptyMarket } : {}),
        ...(typeof value.expanded === 'boolean' ? { expanded: value.expanded } : {}) }
    }
    case 'open':
      if (!hasOnlyKeys(value, ['type', 'id', 'container']) || !isString(value.id, ITEM_ID_LIMIT)) return null
      if (value.container === undefined) return { type: 'open', id: value.id }
      return value.container === 'quick' || value.container === 'shell'
        ? { type: 'open', id: value.id, container: value.container } : null
    case 'expand':
      return hasOnlyKeys(value, ['type', 'expanded']) && typeof value.expanded === 'boolean'
        ? { type: 'expand', expanded: value.expanded } : null
    case 'open-market':
    case 'open-settings':
    case 'refresh-apps':
    case 'retry':
    case 'hide':
    case 'plugin-back':
    case 'plugin-pin':
    case 'plugin-focus':
    case 'plugin-detach':
      return hasOnlyKeys(value, ['type']) ? { type: value.type } : null
    case 'layout':
      return hasOnlyKeys(value, ['type', 'columns', 'height'])
        && typeof value.columns === 'number' && Number.isInteger(value.columns)
        && value.columns >= 1 && value.columns <= 8
        && typeof value.height === 'number' && Number.isFinite(value.height)
        && value.height >= 64 && value.height <= 545
        ? { type: 'layout', columns: value.columns, height: value.height } : null
    case 'key': {
      if (!hasOnlyKeys(value, ['type', 'key', 'shift', 'meta', 'ctrl', 'alt']) || !isString(value.key, 32)) return null
      const action: Extract<QuickThemeAction, { type: 'key' }> = { type: 'key', key: value.key }
      for (const name of ['shift', 'meta', 'ctrl', 'alt'] as const) {
        const modifier = value[name]
        if (modifier === undefined) continue
        if (typeof modifier !== 'boolean') return null
        action[name] = modifier
      }
      return action
    }
    default:
      return null
  }
}

function readResult(value: unknown): QuickThemeActionResult {
  if (!isRecord(value) || typeof value.ok !== 'boolean') return { ok: false, error: '主题操作未能完成。' }
  return typeof value.error === 'string'
    ? { ok: value.ok, error: value.error.slice(0, 512) }
    : { ok: value.ok }
}

const QuickThemeFrame = forwardRef<QuickThemeSurfaceHandle, QuickThemeSurfaceProps>(function QuickThemeFrame(
  { config, snapshot, onAction, onReady, onFailure }, ref
) {
  const [session] = useState(() => {
    const generation = crypto.randomUUID()
    return { key: config.key, generation, src: `${config.url}#generation=${generation}` }
  })
  const [phase, setPhase] = useState<'loading' | 'ready' | 'failed'>('loading')
  const frameRef = useRef<HTMLIFrameElement>(null)
  const bridgeRef = useRef<ThemeBridge | null>(null)
  const pendingFocusRef = useRef<boolean | null>(false)
  const latestRef = useRef({ snapshot, onAction, onReady, onFailure })

  useLayoutEffect(() => {
    latestRef.current = { snapshot, onAction, onReady, onFailure }
  })

  useImperativeHandle(ref, () => ({
    focus(selectAll = false) {
      pendingFocusRef.current = selectAll
      bridgeRef.current?.flushFocus()
    }
  }), [])

  useLayoutEffect(() => {
    const frame = frameRef.current
    if (!frame) return
    let disposed = false
    let ready = false
    let connected = false
    let loads = 0
    let generation: string | null = session.generation
    let port: MessagePort | null = null
    let untransferredPort: MessagePort | null = null
    let timer: number | undefined
    const messageTimes: number[] = []
    const pendingActions = new Set<string>()
    const recentActions = new Set<string>()

    function dispose() {
      if (disposed) return
      disposed = true
      generation = null
      window.clearTimeout(timer)
      window.removeEventListener('message', receiveConnect)
      window.removeEventListener('messageerror', receiveWindowError)
      frame!.removeEventListener('load', receiveLoad)
      frame!.removeEventListener('error', fail)
      if (port) {
        port.onmessage = null
        port.onmessageerror = null
        port.close()
        port = null
      }
      untransferredPort?.close()
      untransferredPort = null
      pendingActions.clear()
      recentActions.clear()
      messageTimes.length = 0
      if (bridgeRef.current === bridge) bridgeRef.current = null
    }

    function fail() {
      if (disposed) return
      ready = false
      frame!.style.visibility = 'hidden'
      frame!.style.pointerEvents = 'none'
      frame!.setAttribute('aria-hidden', 'true')
      dispose()
      pendingFocusRef.current = null
      setPhase('failed')
      try { latestRef.current.onReady(false) }
      finally { latestRef.current.onFailure() }
    }

    function acceptMessage(): boolean {
      const now = performance.now()
      while (messageTimes.length && messageTimes[0] <= now - 1_000) messageTimes.shift()
      if (messageTimes.length >= MESSAGE_LIMIT) { fail(); return false }
      messageTimes.push(now)
      return true
    }

    function rejectTransferredPorts(event: MessageEvent<unknown>): boolean {
      if (!event.ports.length) return false
      for (const receivedPort of event.ports) receivedPort.close()
      fail()
      return true
    }

    function send(message: HostMessage) {
      if (disposed || !port || !generation) return
      try { port.postMessage({ ...message, generation }) }
      catch { fail() }
    }

    async function runAction(id: string, action: QuickThemeAction) {
      try {
        // A key request is not proof of a trusted gesture; the host callback authorizes actions.
        const result = await latestRef.current.onAction(action)
        if (!disposed) send({ type: 'action-result', id, result: readResult(result) })
      } catch {
        if (!disposed) send({ type: 'action-result', id, result: { ok: false, error: '主题操作未能完成。' } })
      } finally {
        pendingActions.delete(id)
      }
    }

    function receivePort(event: MessageEvent<unknown>) {
      if (disposed || !acceptMessage() || rejectTransferredPorts(event)) return
      const message = event.data
      if (!isRecord(message) || message.generation !== generation) { fail(); return }
      if (message.type === 'ready' && hasOnlyKeys(message, ['type', 'generation'])) {
        if (ready) return
        ready = true
        frame!.style.visibility = 'visible'
        frame!.style.pointerEvents = 'auto'
        frame!.removeAttribute('aria-hidden')
        window.clearTimeout(timer)
        setPhase('ready')
        latestRef.current.onReady(true)
        return
      }
      if (message.type !== 'action' || !hasOnlyKeys(message, ['type', 'generation', 'id', 'action'])
        || !isString(message.id, REQUEST_ID_LIMIT)) { fail(); return }
      const id = message.id
      if (pendingActions.has(id) || recentActions.has(id)) { fail(); return }
      recentActions.add(id)
      if (recentActions.size > RECENT_ACTION_LIMIT) {
        const oldest = recentActions.values().next().value
        if (oldest !== undefined) recentActions.delete(oldest)
      }
      const action = readAction(message.action)
      if (!action) {
        send({ type: 'action-result', id, result: { ok: false, error: '无效的主题操作。' } })
        return
      }
      if (pendingActions.size >= PENDING_ACTION_LIMIT) {
        send({ type: 'action-result', id, result: { ok: false, error: '主题操作过于频繁，请稍后重试。' } })
        return
      }
      pendingActions.add(id)
      void runAction(id, action)
    }

    function receiveConnect(event: MessageEvent<unknown>) {
      const target = frame!.contentWindow
      // The sandbox has an opaque origin: bind the channel to the frame and nonce, never origin "null".
      if (disposed || !target || event.source !== target) return
      if (!acceptMessage() || rejectTransferredPorts(event)) return
      const message = event.data
      if (!isRecord(message) || message.type !== 'enest-quick:connect') return
      if (connected || !hasOnlyKeys(message, ['type', 'key', 'generation'])
        || message.key !== session.key || message.generation !== generation) { fail(); return }
      connected = true
      try {
        const channel = new MessageChannel()
        port = channel.port1
        untransferredPort = channel.port2
        port.onmessage = receivePort
        port.onmessageerror = fail
        port.start()
        target.postMessage({ type: 'enest-quick:port', key: session.key, generation }, '*', [untransferredPort])
        untransferredPort = null
        bridge.publishState()
      } catch { fail() }
    }

    function receiveWindowError(event: MessageEvent<unknown>) {
      if (frame!.contentWindow && event.source === frame!.contentWindow) {
        for (const receivedPort of event.ports) receivedPort.close()
        fail()
      }
    }

    function receiveLoad() {
      // A subsequent document cannot inherit this document's channel or reconnect.
      if (!disposed && ++loads > 1) fail()
    }

    const bridge: ThemeBridge = {
      publishState() { send({ type: 'state', state: latestRef.current.snapshot }) },
      flushFocus() {
        if (disposed || !ready || frame!.getAttribute('aria-hidden') === 'true' || pendingFocusRef.current === null) return
        const selectAll = pendingFocusRef.current
        pendingFocusRef.current = null
        frame!.focus({ preventScroll: true })
        send({ type: 'focus', selectAll })
      }
    }
    bridgeRef.current = bridge
    window.addEventListener('message', receiveConnect)
    window.addEventListener('messageerror', receiveWindowError)
    frame.addEventListener('load', receiveLoad)
    frame.addEventListener('error', fail)
    timer = window.setTimeout(fail, READY_TIMEOUT_MS)
    latestRef.current.onReady(false)

    return () => {
      const wasReady = ready
      ready = false
      dispose()
      pendingFocusRef.current = false
      if (wasReady) latestRef.current.onReady(false)
    }
  }, [session])

  useLayoutEffect(() => { bridgeRef.current?.publishState() }, [snapshot])
  useLayoutEffect(() => {
    if (phase === 'ready') bridgeRef.current?.flushFocus()
  }, [phase])

  return <div className="quick-theme-surface" data-mode={snapshot.plugin ? 'plugin' : 'list'}
    data-ready={phase === 'ready'} aria-busy={phase === 'loading'}>
    {phase !== 'failed' && <iframe ref={frameRef} className="quick-theme-surface-frame" src={session.src}
      sandbox="allow-scripts" referrerPolicy="no-referrer" title="快捷启动主题界面（隔离沙箱）"
      aria-hidden={phase !== 'ready'} tabIndex={phase === 'ready' ? 0 : -1} />}
  </div>
})

export const QuickThemeSurface = forwardRef<QuickThemeSurfaceHandle, QuickThemeSurfaceProps>(function QuickThemeSurface(
  props, ref
) {
  return <QuickThemeFrame key={props.config.key} {...props} ref={ref} />
})
