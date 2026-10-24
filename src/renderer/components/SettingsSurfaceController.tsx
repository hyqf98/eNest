import { lazy, Suspense, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { Button } from '@renderer/components/ui/Button'
import { useI18n } from '@renderer/hooks/useI18n'
import { shellApi } from '@renderer/services/shellApi'
import { useShellStore } from '@renderer/stores/shellStore'
import type { NativeSettingsSection, ThemeSettingsAction, ThemeSettingsConfig, ThemeSettingsSnapshot, ThemeSettingsValue } from '@shared/types/themeSettings'
import './settingsSurface.css'

const DefaultSettingsPage = lazy(() => import('@renderer/themes/default/settings/DefaultSettingsPage').then(module => ({ default: module.DefaultSettingsPage })))
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
const only = (value: Record<string, unknown>, keys: string[]): boolean => Object.keys(value).every(key => keys.includes(key))
function readAction(value: unknown): ThemeSettingsAction | null {
  if (!record(value)) return null
  if (value.type === 'native' && only(value, ['type', 'section']) && typeof value.section === 'string' && value.section.length <= 256) return value as unknown as ThemeSettingsAction
  if (value.type !== 'set' || !only(value, ['type', 'fieldId', 'value']) || typeof value.fieldId !== 'string' || !/^[a-f0-9]{64}$/.test(value.fieldId)) return null
  const fieldValue = value.value
  if (fieldValue !== null && typeof fieldValue !== 'boolean' && !(typeof fieldValue === 'number' && Number.isFinite(fieldValue)) && !(typeof fieldValue === 'string' && fieldValue.length <= 512)) return null
  return { type: 'set', fieldId: value.fieldId, value: fieldValue as ThemeSettingsValue }
}

function SettingsFrame({ config, snapshot, onNative, refresh, onFailure }: {
  config: ThemeSettingsConfig; snapshot: ThemeSettingsSnapshot; onNative: (section: NativeSettingsSection) => void
  refresh: () => Promise<void>; onFailure: () => void
}) {
  const frameRef = useRef<HTMLIFrameElement>(null)
  const publish = useRef<(() => void) | null>(null)
  const latest = useRef({ snapshot, onNative, refresh, onFailure })
  const [generation] = useState(() => crypto.randomUUID())
  const [ready, setReady] = useState(false)
  useLayoutEffect(() => { latest.current = { snapshot, onNative, refresh, onFailure }; publish.current?.() })
  useLayoutEffect(() => {
    const frame = frameRef.current
    if (!frame) return
    let disposed = false, connected = false, loaded = false, port: MessagePort | null = null
    let available = false, calls = 0
    const requests = new Set<string>(), recent = new Set<string>(), times: number[] = []
    const send = (message: object): void => { if (!disposed && port) port.postMessage({ ...message, generation }) }
    const active = (): void => {
      if (disposed || !available) return
      const bounds = frame.getBoundingClientRect()
      void shellApi.setThemeSettingsActive({ key: config.key, active: true, bounds: { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height } })
        .then(accepted => { if (!accepted) fail() }).catch(fail)
    }
    function dispose(): void {
      if (disposed) return
      disposed = true
      window.clearTimeout(timer)
      window.removeEventListener('message', connect)
      frame!.removeEventListener('load', load)
      frame!.removeEventListener('error', fail)
      window.removeEventListener('resize', active)
      window.removeEventListener('scroll', active, true)
      observer.disconnect()
      if (port) { port.onmessage = null; port.onmessageerror = null; port.close(); port = null }
      publish.current = null
      requests.clear(); recent.clear(); times.length = 0
      void shellApi.setThemeSettingsActive({ key: config.key, active: false }).catch(() => undefined)
    }
    function fail(): void {
      if (disposed) return
      frame!.style.visibility = 'hidden'
      frame!.style.pointerEvents = 'none'
      dispose()
      latest.current.onFailure()
    }
    function consume(event: MessageEvent): boolean {
      for (const transferred of event.ports) transferred.close()
      const now = performance.now()
      while (times.length && times[0] <= now - 1000) times.shift()
      if (event.ports.length || times.length >= 100) { fail(); return false }
      times.push(now)
      return true
    }
    async function action(id: string, value: ThemeSettingsAction): Promise<void> {
      try {
        const result = await shellApi.dispatchThemeSettingsAction(config.key, value)
        if (disposed) return
        send({ type: 'action-result', id, result })
        if (result.ok && result.nativeSection) latest.current.onNative(result.nativeSection)
        else if (result.ok) await latest.current.refresh()
      } catch { if (!disposed) send({ type: 'action-result', id, result: { ok: false, error: 'Settings action failed' } }) }
      finally { requests.delete(id); calls-- }
    }
    function receive(event: MessageEvent): void {
      if (disposed || !consume(event)) return
      const message: unknown = event.data
      if (!record(message) || message.generation !== generation) { fail(); return }
      if (message.type === 'ready' && only(message, ['type', 'generation'])) {
        if (!available) {
          available = true
          window.clearTimeout(timer)
          frame!.style.visibility = 'visible'
          frame!.style.pointerEvents = 'auto'
          setReady(true)
          active()
        }
        return
      }
      if (!available || message.type !== 'action' || !only(message, ['type', 'generation', 'id', 'action']) || typeof message.id !== 'string' || !message.id || message.id.length > 128 || requests.has(message.id) || recent.has(message.id)) { fail(); return }
      const value = readAction(message.action)
      if (!value || calls >= 8) { send({ type: 'action-result', id: message.id, result: { ok: false, error: 'Invalid or busy settings action' } }); return }
      requests.add(message.id); recent.add(message.id); calls++
      if (recent.size > 256) recent.delete(recent.values().next().value!)
      void action(message.id, value)
    }
    function connect(event: MessageEvent): void {
      if (disposed || event.source !== frame!.contentWindow || !consume(event)) return
      const message: unknown = event.data
      if (!record(message) || message.type !== 'enest-settings:connect') return
      if (connected || !only(message, ['type', 'key', 'generation']) || message.key !== config.key || message.generation !== generation) { fail(); return }
      connected = true
      try {
        const channel = new MessageChannel()
        port = channel.port1
        port.onmessage = receive; port.onmessageerror = fail; port.start()
        frame!.contentWindow!.postMessage({ type: 'enest-settings:port', key: config.key, generation }, '*', [channel.port2])
        send({ type: 'state', state: latest.current.snapshot })
      } catch { fail() }
    }
    function load(): void { if (loaded) fail(); loaded = true }
    const observer = new ResizeObserver(active)
    const timer = window.setTimeout(fail, 8000)
    publish.current = () => { if (!disposed) send({ type: 'state', state: latest.current.snapshot }) }
    observer.observe(frame)
    window.addEventListener('message', connect)
    window.addEventListener('resize', active)
    window.addEventListener('scroll', active, true)
    frame.addEventListener('load', load)
    frame.addEventListener('error', fail)
    return dispose
  }, [config.key, config.url, generation])
  return <iframe className="settings-theme-frame" ref={frameRef} src={`${config.url}#generation=${generation}`} sandbox="allow-scripts" referrerPolicy="no-referrer" title="Theme settings (isolated)" aria-hidden={!ready} tabIndex={ready ? 0 : -1} />
}

/** Chooses the selected theme's presentation; native account/security dialogs never enter its realm. */
export function SettingsSurfaceController() {
  const { locale, t } = useI18n()
  const en = locale === 'en-US'
  const [config, setConfig] = useState<ThemeSettingsConfig | null>(null)
  const [snapshot, setSnapshot] = useState<ThemeSettingsSnapshot | null>(null)
  const [loading, setLoading] = useState(true)
  const [failed, setFailed] = useState(false)
  const settingsTab = useShellStore(state => state.settingsTab)
  const previousTab = useRef(settingsTab)
  const [native, setNative] = useState(() => settingsTab !== 'general')
  const request = useRef(0)
  const key = useRef<string | null>(null)
  const refresh = useCallback(async () => {
    const sequence = ++request.current
    try {
      const next = await shellApi.getThemeSettingsConfig()
      const state = next ? await shellApi.getThemeSettingsSnapshot(next.key) : null
      if (sequence !== request.current) return
      if (key.current !== next?.key) { key.current = next?.key ?? null; setFailed(false) }
      setConfig(next); setSnapshot(state)
    } catch { if (sequence === request.current) setFailed(true) }
    finally { if (sequence === request.current) setLoading(false) }
  }, [])
  useEffect(() => {
    if (previousTab.current !== settingsTab) { previousTab.current = settingsTab; setNative(true) }
  }, [settingsTab])
  useEffect(() => {
    void refresh()
    const off = shellApi.onEvent(event => {
      if (event.type === 'plugin-open-settings') {
        useShellStore.getState().setSettingsTab(`p:${event.pluginId}`)
        setNative(true)
      } else if (event.type === 'set-view' && event.view === 'settings' && event.sectionId) {
        useShellStore.getState().setSettingsTab(event.sectionId)
        setNative(true)
      }
      if (['appearance-changed', 'theme-packs-changed', 'plugins-changed', 'settings-changed', 'settings-sections', 'plugin-settings-changed', 'locale-changed'].includes(event.type)) void refresh()
    })
    return () => { request.current++; off() }
  }, [refresh])
  const openNative = useCallback((section: NativeSettingsSection) => {
    useShellStore.getState().setSettingsTab(section === 'theme' ? 'appearance' : section)
    setNative(true)
  }, [])
  const fallback = <Suspense fallback={<div role="status">{t('common.loading')}</div>}><DefaultSettingsPage /></Suspense>
  if (loading) return <div className="settings-surface-status" role="status">{t('common.loading')}</div>
  if (!config && !failed) return fallback
  return <div className="settings-surface-controller">
    <div className="settings-surface-toolbar">
      {native ? <Button size="sm" variant="ghost" onClick={() => { setNative(false); void refresh() }}>{en ? 'Back to theme settings' : '返回主题设置'}</Button> : <span>{en ? 'Theme settings' : '主题设置'}</span>}
      <Button size="sm" variant="ghost" onClick={() => openNative('general')}>{en ? 'System & security' : '系统与安全设置'}</Button>
    </div>
    {native ? fallback : failed || !config || !snapshot ? <div className="settings-surface-status" role="alert">
      <p>{en ? 'Theme settings are unavailable. System settings remain accessible.' : '主题设置暂不可用，系统设置仍可正常使用。'}</p>
      <Button size="sm" onClick={() => { setFailed(false); setLoading(true); void refresh() }}>{en ? 'Retry' : '重试'}</Button>
    </div> : <SettingsFrame key={config.key} config={config} snapshot={snapshot} onNative={openNative} refresh={refresh} onFailure={() => setFailed(true)} />}
  </div>
}
