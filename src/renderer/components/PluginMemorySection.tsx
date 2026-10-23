import { useCallback, useEffect, useRef, useState } from 'react'
import { Button } from '@renderer/components/ui/Button'
import { Input } from '@renderer/components/ui/Input'
import { Switch } from '@renderer/components/ui/Switch'
import { Tooltip, TooltipProvider } from '@renderer/components/ui/Tooltip'
import { useI18n } from '@renderer/hooks/useI18n'
import { notify } from '@renderer/services/notifyService'
import { isMockShell, shellApi } from '@renderer/services/shellApi'
import { toTabId } from '@shared/constants'
import {
  normalizePluginMemoryMonitor,
  type PluginMemoryMonitorSettings,
  type PluginMemoryProcess,
  type PluginMemorySnapshot
} from '@shared/types/pluginMemory'
import '@renderer/styles/pluginMemory.css'

const REFRESH_INTERVAL_MS = 5000
const MIB = 1024 * 1024

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Read-only host snapshots; alert classification and resource ownership stay in main. */
export function PluginMemorySection() {
  const { t, locale } = useI18n()
  const sectionRef = useRef<HTMLElement>(null)
  const mounted = useRef(false)
  const readable = useRef(false)
  const snapshotVersion = useRef(0)
  const request = useRef<Promise<void> | null>(null)
  const settingsVersion = useRef(0)
  const confirmed = useRef<PluginMemoryMonitorSettings | null>(null)
  const saving = useRef(false)
  const closing = useRef(new Set<string>())
  const [intersecting, setIntersecting] = useState(typeof IntersectionObserver === 'undefined')
  const [documentVisible, setDocumentVisible] = useState(document.visibilityState !== 'hidden')
  const [monitor, setMonitor] = useState<PluginMemoryMonitorSettings | null>(null)
  const [threshold, setThreshold] = useState('')
  const [settingsLoading, setSettingsLoading] = useState(true)
  const [settingsSaving, setSettingsSaving] = useState(false)
  const [settingsError, setSettingsError] = useState<string | null>(null)
  const [snapshot, setSnapshot] = useState<PluginMemorySnapshot | null>(null)
  const [snapshotError, setSnapshotError] = useState<string | null>(null)
  const [refreshing, setRefreshing] = useState(false)
  const [closingIds, setClosingIds] = useState<Set<string>>(new Set())
  const visible = intersecting && documentVisible

  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
      readable.current = false
      snapshotVersion.current++
      settingsVersion.current++
    }
  }, [])

  useEffect(() => {
    const onVisibilityChange = () => {
      if (document.visibilityState === 'hidden') {
        readable.current = false
        snapshotVersion.current++
      }
      setDocumentVisible(document.visibilityState !== 'hidden')
    }
    document.addEventListener('visibilitychange', onVisibilityChange)
    const element = sectionRef.current
    const observer = typeof IntersectionObserver === 'undefined' ? null : new IntersectionObserver(([entry]) => {
      if (!entry?.isIntersecting) {
        readable.current = false
        snapshotVersion.current++
      }
      setIntersecting(entry?.isIntersecting === true)
    })
    if (element) observer?.observe(element)
    return () => {
      document.removeEventListener('visibilitychange', onVisibilityChange)
      observer?.disconnect()
    }
  }, [])

  const readSettings = useCallback(async () => {
    const version = ++settingsVersion.current
    setSettingsLoading(true)
    setSettingsError(null)
    try {
      const settings = await shellApi.getSettings()
      if (!mounted.current || version !== settingsVersion.current) return
      const next = normalizePluginMemoryMonitor(settings.general?.pluginMemoryMonitor as Partial<PluginMemoryMonitorSettings> | undefined)
      confirmed.current = next
      setMonitor(next)
      setThreshold(String(next.warningThresholdMiB))
    } catch (error) {
      if (mounted.current && version === settingsVersion.current) {
        setSettingsError(t('settings.pluginMemory.settingsReadFailed', { error: errorMessage(error) }))
      }
    } finally {
      if (mounted.current && version === settingsVersion.current) setSettingsLoading(false)
    }
  }, [t])

  // A forced read waits for any older request, then obtains a fresh post-save/close snapshot.
  const refresh = useCallback(async (force = false): Promise<void> => {
    if (request.current) {
      if (!force) return request.current
      await request.current
    }
    if (!mounted.current || !readable.current) return
    if (request.current) return request.current
    const version = snapshotVersion.current
    setRefreshing(true)
    const current = Promise.resolve().then(async () => {
      try {
        const next = await shellApi.getPluginMemorySnapshot()
        if (!mounted.current || !readable.current || version !== snapshotVersion.current) return
        setSnapshot(next)
        setSnapshotError(null)
      } catch (error) {
        if (!mounted.current || !readable.current || version !== snapshotVersion.current) return
        // Never leave a stale, apparently healthy sample visible after a failed read.
        setSnapshot(null)
        setSnapshotError(errorMessage(error))
      }
    }).finally(() => {
      if (request.current === current) {
        request.current = null
        if (mounted.current) setRefreshing(false)
      }
    })
    request.current = current
    return current
  }, [])

  useEffect(() => {
    void readSettings()
    const off = shellApi.onEvent(payload => {
      if (payload.type !== 'settings-changed' || !payload.generalKeys.includes('pluginMemoryMonitor') || saving.current) return
      void readSettings()
      snapshotVersion.current++
      void refresh(true)
    })
    return off
  }, [readSettings, refresh])

  useEffect(() => {
    snapshotVersion.current++
    readable.current = visible
    if (!visible) {
      setRefreshing(false)
      return
    }
    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const poll = async () => {
      await refresh(true)
      if (!cancelled && !isMockShell) timer = setTimeout(() => { void poll() }, REFRESH_INTERVAL_MS)
    }
    void poll()
    return () => {
      cancelled = true
      readable.current = false
      snapshotVersion.current++
      if (timer !== undefined) clearTimeout(timer)
    }
  }, [visible, refresh])

  const saveSettings = async (patch: Partial<PluginMemoryMonitorSettings>) => {
    const previous = confirmed.current
    if (!previous || saving.current || settingsLoading) return
    const next = normalizePluginMemoryMonitor({ ...previous, ...patch })
    setThreshold(String(next.warningThresholdMiB))
    if (next.enabled === previous.enabled && next.alertsEnabled === previous.alertsEnabled && next.warningThresholdMiB === previous.warningThresholdMiB) return
    saving.current = true
    settingsVersion.current++
    setSettingsSaving(true)
    setSettingsError(null)
    setMonitor(next)
    try {
      // This nested setting is always persisted as one complete three-field value.
      await shellApi.setSettings({ general: { pluginMemoryMonitor: next } })
      confirmed.current = next
    } catch (error) {
      if (mounted.current) {
        setMonitor(previous)
        setThreshold(String(previous.warningThresholdMiB))
        const message = t('settings.pluginMemory.saveFailed', { error: errorMessage(error) })
        setSettingsError(message)
        notify.error(message)
      }
    } finally {
      saving.current = false
      if (mounted.current) {
        setSettingsSaving(false)
        snapshotVersion.current++
        void refresh(true)
      }
    }
  }

  const commitThreshold = () => {
    if (!confirmed.current || saving.current) return
    const value = Number(threshold)
    if (!threshold.trim() || !Number.isInteger(value) || value < 128 || value > 8192) {
      setThreshold(String(confirmed.current.warningThresholdMiB))
      notify.warn(t('settings.pluginMemory.invalidThreshold'))
      return
    }
    void saveSettings({ warningThresholdMiB: value })
  }

  const closePlugin = async (pluginId: string, name: string) => {
    if (!snapshot?.plugins.some(plugin => plugin.pluginId === pluginId && plugin.canClose) || closing.current.has(pluginId)) return
    closing.current.add(pluginId)
    setClosingIds(new Set(closing.current))
    try {
      await shellApi.closePlugin(toTabId(pluginId))
      snapshotVersion.current++
      await refresh(true)
    } catch (error) {
      if (mounted.current) notify.error(t('settings.pluginMemory.closeFailed', { name, error: errorMessage(error) }))
    } finally {
      closing.current.delete(pluginId)
      if (mounted.current) setClosingIds(new Set(closing.current))
    }
  }

  const memory = (bytes: number | null | undefined) => bytes == null || !Number.isFinite(bytes) || bytes < 0
    ? '—'
    : `${(bytes / MIB).toLocaleString(locale, { maximumFractionDigits: bytes < MIB ? 2 : 1 })} MiB`
  const processKind = {
    renderer: t('settings.pluginMemory.processRenderer'),
    backend: t('settings.pluginMemory.processBackend'),
    development: t('settings.pluginMemory.processDevelopment'),
    runtime: t('settings.pluginMemory.processRuntime'),
    host: t('settings.pluginMemory.processHost')
  }
  const metric = {
    footprint: t('settings.pluginMemory.metricFootprint'),
    private: t('settings.pluginMemory.metricPrivate'),
    'resident-swap': t('settings.pluginMemory.metricResidentSwap'),
    resident: t('settings.pluginMemory.metricResident'),
    unavailable: t('settings.pluginMemory.metricUnavailable')
  }
  const processDetails = (processes: PluginMemoryProcess[]) => (
    <div className="plugin-memory-process-details">
      {processes.map(process => (
        <span key={process.pid}>
          PID {process.pid} · {processKind[process.kind]} · {metric[process.metric]} · {memory(process.memoryBytes)}
          {' · '}{t(process.shared ? 'settings.pluginMemory.sharedProcess' : 'settings.pluginMemory.exclusiveProcess')}
        </span>
      ))}
    </div>
  )
  const error = snapshotError ?? snapshot?.error
  const measured = Boolean(snapshot && snapshot.sampledAt !== null && !error && monitor?.enabled && snapshot.settings.enabled)
  const sampledAt = snapshot?.sampledAt
  const disabled = monitor?.enabled === false
  const controlsDisabled = settingsLoading || settingsSaving
  const runningPlugins = snapshot?.plugins.filter(plugin => plugin.status !== 'idle') ?? []
  const pluginProcesses = snapshot?.processes.filter(process => process.pluginIds.length > 0) ?? []
  const sharedProcesses = pluginProcesses.filter(process => process.shared)
  const hostProcesses = snapshot?.processes.filter(process => process.pluginIds.length === 0) ?? []

  return (
    <TooltipProvider>
      <section ref={sectionRef} className="s-card plugin-memory-section" aria-labelledby="plugin-memory-title">
        <h2 id="plugin-memory-title">{t('settings.pluginMemory.title')}</h2>
        <p className="hint">{t('settings.pluginMemory.hint')}</p>

        {monitor ? (
          <div className="plugin-memory-controls" aria-busy={settingsSaving}>
            <div className="field">
              <div>
                <div className="label" id="plugin-memory-enabled-label">{t('settings.pluginMemory.enabled')}</div>
                <p className="desc">{t('settings.pluginMemory.enabledDesc')}</p>
              </div>
              <Switch checked={monitor.enabled} disabled={controlsDisabled} aria-labelledby="plugin-memory-enabled-label" onCheckedChange={enabled => { void saveSettings({ enabled }) }} />
            </div>
            <div className="field">
              <div>
                <div className="label" id="plugin-memory-alerts-label">{t('settings.pluginMemory.alerts')}</div>
                <p className="desc">{t('settings.pluginMemory.alertsDesc')}</p>
              </div>
              <Switch checked={monitor.alertsEnabled} disabled={controlsDisabled || !monitor.enabled} aria-labelledby="plugin-memory-alerts-label" onCheckedChange={alertsEnabled => { void saveSettings({ alertsEnabled }) }} />
            </div>
            <div className="field">
              <div>
                <label className="label" htmlFor="plugin-memory-threshold">{t('settings.pluginMemory.threshold')}</label>
                <p className="desc" id="plugin-memory-threshold-desc">{t('settings.pluginMemory.thresholdDesc')}</p>
              </div>
              <div className="plugin-memory-threshold">
                <Input
                  id="plugin-memory-threshold"
                  aria-describedby="plugin-memory-threshold-desc"
                  type="number"
                  inputMode="numeric"
                  min={128}
                  max={8192}
                  step={1}
                  value={threshold}
                  disabled={controlsDisabled || !monitor.enabled}
                  onChange={event => setThreshold(event.target.value)}
                  onBlur={commitThreshold}
                  onKeyDown={event => {
                    if (event.key === 'Enter') { event.preventDefault(); event.currentTarget.blur() }
                    if (event.key === 'Escape') { event.preventDefault(); setThreshold(String(confirmed.current?.warningThresholdMiB ?? 512)) }
                  }}
                />
                <span>MiB</span>
              </div>
            </div>
          </div>
        ) : settingsLoading ? <p className="desc" role="status">{t('common.loading')}</p> : null}
        {settingsSaving && <p className="desc" role="status">{t('settings.pluginMemory.saving')}</p>}
        {settingsError && (
          <div className="plugin-memory-error" role="alert">
            <span>{settingsError}</span>
            {!settingsSaving && <Button variant="ghost" size="sm" onClick={() => { void readSettings() }} disabled={settingsLoading}>{t('settings.pluginMemory.retry')}</Button>}
          </div>
        )}

        <div className="plugin-memory-toolbar">
          <span className="desc">
            {measured && sampledAt != null ? t('settings.pluginMemory.sampledAt', { time: new Date(sampledAt).toLocaleTimeString(locale) }) : t('settings.pluginMemory.notSampled')}
          </span>
          {!isMockShell && <Button variant="ghost" size="sm" disabled={refreshing || !visible} aria-busy={refreshing} onClick={() => { void refresh() }}>{t(refreshing ? 'settings.pluginMemory.refreshing' : 'settings.pluginMemory.refresh')}</Button>}
        </div>

        <dl className="plugin-memory-summary">
          {([
            ['total', 'totalHint', snapshot?.totalMemoryBytes, pluginProcesses],
            ['sharedTotal', 'sharedHint', snapshot?.sharedMemoryBytes, sharedProcesses],
            ['host', 'hostHint', snapshot?.hostMemoryBytes, hostProcesses]
          ] as const).map(([label, hint, value, processes]) => (
            <div key={label}>
              <dt><Tooltip content={t(`settings.pluginMemory.${hint}`)}><span tabIndex={0}>{t(`settings.pluginMemory.${label}`)}</span></Tooltip></dt>
              <dd title={!measured || !processes.length || value == null ? t('settings.pluginMemory.unavailable') : undefined}>{memory(measured && processes.length ? value : null)}</dd>
              {measured && processes.some(process => process.metric === 'resident') && <Tooltip content={t('settings.pluginMemory.rssHint')}><span className="plugin-memory-badge" tabIndex={0}>{t('settings.pluginMemory.rssFallback')}</span></Tooltip>}
            </div>
          ))}
        </dl>

        {isMockShell ? <p className="plugin-memory-message" role="status">{t('settings.pluginMemory.browserPreview')}</p> : error ? (
          <p className="plugin-memory-error" role="alert">{t('settings.pluginMemory.readFailed', { error })}</p>
        ) : disabled ? <p className="plugin-memory-message" role="status">{t('settings.pluginMemory.disabled')}</p>
          : !snapshot ? <p className="plugin-memory-message" role="status">{t('common.loading')}</p>
            : snapshot.sampledAt === null ? <p className="plugin-memory-message" role="status">{t('settings.pluginMemory.waiting')}</p>
              : runningPlugins.length === 0 ? <p className="plugin-memory-message" role="status">{t('settings.pluginMemory.noPlugins')}</p> : null}

        {snapshot && runningPlugins.length > 0 && (
          <div className="plugin-memory-table-scroll" tabIndex={0} role="region" aria-label={t('settings.pluginMemory.title')}>
            <table className="plugin-memory-table">
              <thead>
                <tr>
                  <th scope="col">{t('settings.pluginMemory.plugin')}</th>
                  <th scope="col">{t('settings.pluginMemory.exclusive')}</th>
                  <th scope="col"><Tooltip content={t('settings.pluginMemory.sharedHint')}><span tabIndex={0}>{t('settings.pluginMemory.shared')}</span></Tooltip></th>
                  <th scope="col"><Tooltip content={t('settings.pluginMemory.peakHint')}><span tabIndex={0}>{t('settings.pluginMemory.peak')}</span></Tooltip></th>
                  <th scope="col"><span className="plugin-memory-sr-only">{t('settings.pluginMemory.closePlugin')}</span></th>
                </tr>
              </thead>
              <tbody>
                {runningPlugins.map(plugin => {
                  const isClosing = closingIds.has(plugin.pluginId) || plugin.status === 'closing'
                  const status = isClosing ? 'statusClosing' : plugin.status === 'running' ? 'statusRunning' : 'statusIdle'
                  const alert = plugin.alert === 'warning' ? 'alertWarning' : plugin.alert === 'critical' ? 'alertCritical' : plugin.alert === 'unavailable' ? 'alertUnavailable' : null
                  const pids = [...new Set(plugin.processes.map(process => process.pid))].join(', ')
                  const rssFallback = plugin.processes.some(process => process.metric === 'resident')
                  const exclusiveMemory = measured && plugin.processes.some(process => !process.shared) ? plugin.memoryBytes : null
                  const sharedMemory = measured && plugin.processes.some(process => process.shared) ? plugin.sharedMemoryBytes : null
                  const peakMemory = measured && (plugin.peakMemoryBytes > 0 || (plugin.processes.length > 0 && plugin.unmeasuredProcessCount === 0)) ? plugin.peakMemoryBytes : null
                  return (
                    <tr key={plugin.pluginId}>
                      <th scope="row">
                        <span className="plugin-memory-name" title={plugin.pluginId}>{plugin.name}</span>
                        <div className="plugin-memory-badges">
                          <span className="plugin-memory-status">{t(`settings.pluginMemory.${status}`)}</span>
                          {alert && <span className="plugin-memory-badge" data-alert={plugin.alert}>{t(`settings.pluginMemory.${alert}`)}</span>}
                          {rssFallback && <Tooltip content={t('settings.pluginMemory.rssHint')}><span className="plugin-memory-badge" tabIndex={0}>{t('settings.pluginMemory.rssFallback')}</span></Tooltip>}
                        </div>
                        <div className="plugin-memory-meta">
                          <span>{t('settings.pluginMemory.processCount', { count: plugin.processCount })}</span>
                          {pids && <Tooltip content={processDetails(plugin.processes)}><span tabIndex={0}>{t('settings.pluginMemory.pids', { pids })}</span></Tooltip>}
                        </div>
                        {plugin.unmeasuredProcessCount > 0 && <span className="plugin-memory-partial">{t('settings.pluginMemory.unmeasured', { count: plugin.unmeasuredProcessCount })}</span>}
                      </th>
                      <td title={exclusiveMemory == null ? t('settings.pluginMemory.unavailable') : undefined}>{memory(exclusiveMemory)}</td>
                      <td title={t('settings.pluginMemory.sharedHint')}>{memory(sharedMemory)}</td>
                      <td>{memory(peakMemory)}</td>
                      <td className="plugin-memory-action">
                        {plugin.status !== 'idle' && (
                          <Tooltip content={t(plugin.canClose ? 'settings.pluginMemory.closeHint' : 'settings.pluginMemory.hostManagedHint')}>
                            <span tabIndex={plugin.canClose ? undefined : 0} aria-label={plugin.canClose ? undefined : t('settings.pluginMemory.hostManagedHint')}>
                              <Button variant="ghost" size="sm" disabled={isClosing || !plugin.canClose} aria-busy={isClosing} aria-label={`${t(plugin.canClose ? 'settings.pluginMemory.closePlugin' : 'settings.pluginMemory.hostManagedHint')} · ${plugin.name}`} onClick={() => { void closePlugin(plugin.pluginId, plugin.name) }}>
                                {t(!plugin.canClose ? 'settings.pluginMemory.hostManaged' : isClosing ? 'settings.pluginMemory.closing' : 'settings.pluginMemory.closePlugin')}
                              </Button>
                            </span>
                          </Tooltip>
                        )}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
        {snapshot && snapshot.unavailableProcessCount > 0 && <p className="desc">{t('settings.pluginMemory.unmeasured', { count: snapshot.unavailableProcessCount })}</p>}
        <p className="plugin-memory-note">{t('settings.pluginMemory.totalHint')} {t('settings.pluginMemory.limitations')}</p>
      </section>
    </TooltipProvider>
  )
}
