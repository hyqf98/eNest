import { useEffect, useRef, useState } from 'react'
import { Button } from '@renderer/components/ui/Button'
import { useI18n } from '@renderer/hooks/useI18n'
import { isMockShell, shellApi } from '@renderer/services/shellApi'
import type { PerformanceCaptureState } from '@shared/types/performanceCapture'

/** Viewing status is cheap; only an explicit click starts native collection in main. */
export function PerformanceCaptureSection({ visible }: { visible: boolean }) {
  const { t, locale } = useI18n()
  const [state, setState] = useState<PerformanceCaptureState | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const version = useRef(0)
  const mounted = useRef(true)
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; version.current++ } }, [])
  useEffect(() => {
    if (!visible) return
    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const poll = async () => {
      const current = version.current
      try {
        const next = await shellApi.getPerformanceCaptureState()
        if (!cancelled && current === version.current) { setState(next); setError(null) }
      } catch (reason) {
        if (!cancelled && current === version.current) setError(reason instanceof Error ? reason.message : String(reason))
      } finally {
        if (!cancelled && !isMockShell) timer = setTimeout(() => { void poll() }, 5000)
      }
    }
    void poll()
    return () => { cancelled = true; if (timer) clearTimeout(timer) }
  }, [visible])

  const act = async (action: 'start' | 'stop' | 'export') => {
    if (busy) return
    version.current++
    setBusy(true); setError(null); setNotice(null)
    try {
      if (action === 'export') {
        const result = await shellApi.exportPerformanceCapture()
        if (mounted.current) setNotice(result.exported
          ? t('settings.performance.exported', { count: String(result.sampleCount) })
          : t('settings.performance.exportCancelled'))
      } else if (action === 'start') await shellApi.startPerformanceCapture()
      else await shellApi.stopPerformanceCapture()
      const next = await shellApi.getPerformanceCaptureState()
      if (mounted.current) setState(next)
    } catch (reason) {
      if (mounted.current) setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      version.current++
      if (mounted.current) setBusy(false)
    }
  }
  const running = state?.status === 'running'
  const stopping = state?.status === 'stopping'
  const unavailable = isMockShell || state?.status === 'unavailable'
  const labels: Record<PerformanceCaptureState['status'], string> = {
    idle: t('settings.performance.statusIdle'), running: t('settings.performance.statusRunning'),
    stopping: t('settings.performance.statusStopping'), stopped: t('settings.performance.statusStopped'),
    unavailable: t('settings.performance.statusUnavailable')
  }
  const stops: Record<NonNullable<PerformanceCaptureState['stopReason']>, string> = {
    manual: t('settings.performance.stopManual'), 'time-limit': t('settings.performance.stopTimeLimit'),
    'sample-limit': t('settings.performance.stopSampleLimit'), 'size-limit': t('settings.performance.stopSizeLimit'),
    shutdown: t('settings.performance.stopShutdown')
  }
  return <div className="performance-capture" aria-labelledby="performance-capture-title" aria-busy={busy}>
    <div className="performance-capture-heading">
      <h3 id="performance-capture-title">{t('settings.performance.title')}</h3>
      <span className="plugin-memory-badge" role="status">{state ? labels[state.status] : t('settings.performance.loadingStatus')}</span>
    </div>
    <p className="desc">{t('settings.performance.desc')}</p>
    <div className="performance-capture-actions">
      <Button variant="primary" size="sm" disabled={busy || running || stopping || unavailable || !state} onClick={() => { void act('start') }}>
        {state?.sampleCount ? t('settings.performance.startNew') : t('settings.performance.start')}
      </Button>
      <Button variant="ghost" size="sm" disabled={busy || !running} onClick={() => { void act('stop') }}>{t('settings.performance.stop')}</Button>
      <Button variant="ghost" size="sm" disabled={busy || stopping || !state?.sampleCount || unavailable} onClick={() => { void act('export') }}>
        {running ? t('settings.performance.stopAndExport') : t('settings.performance.exportJson')}
      </Button>
    </div>
    {state && state.status !== 'idle' && !unavailable && <p className="performance-capture-status" role="status">
      {t('settings.performance.summary', {
        count: String(state.sampleCount),
        size: (state.retainedBytes / 1024).toFixed(1),
        failed: String(state.failedSamples)
      })}
      {state.stopReason && ` · ${stops[state.stopReason]}`}
      {running && state.deadlineAt && ` · ${t('settings.performance.stopsBy')} ${new Date(state.deadlineAt).toLocaleTimeString(locale)}`}
      {state.captureId && <code>{state.captureId}</code>}
    </p>}
    <p className="plugin-memory-note">{t('settings.performance.note')}</p>
    {error && <p className="plugin-memory-error" role="alert">{error}</p>}
    {notice && <p className="plugin-memory-message" role="status">{notice}</p>}
  </div>
}
