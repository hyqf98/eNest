import { useEffect, useRef, useState } from 'react'
import { Button } from '@renderer/components/ui/Button'
import { useI18n } from '@renderer/hooks/useI18n'
import { isMockShell, shellApi } from '@renderer/services/shellApi'
import type { PerformanceCaptureState } from '@shared/types/performanceCapture'

/** Viewing status is cheap; only an explicit click starts native collection in main. */
export function PerformanceCaptureSection({ visible }: { visible: boolean }) {
  const { locale } = useI18n()
  const en = locale === 'en-US'
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
          ? (en ? `Exported ${result.sampleCount} samples. Review the JSON before sharing.` : `已导出 ${result.sampleCount} 个样本，分享前请检查 JSON 内容。`)
          : (en ? 'Save cancelled. The stopped recording is still available.' : '已取消保存，停止的记录仍保留，可再次导出。'))
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
  const labels = {
    idle: en ? 'Not recording' : '未开始', running: en ? 'Recording' : '采样中', stopping: en ? 'Finishing current sample' : '正在结束当前采样',
    stopped: en ? 'Stopped' : '已停止', unavailable: en ? 'Desktop app required' : '仅桌面壳可用'
  }
  const stops = {
    manual: en ? 'Manually stopped' : '手动停止', 'time-limit': en ? '10-minute limit reached' : '已达 10 分钟上限',
    'sample-limit': en ? 'Sample limit reached' : '已达样本上限', 'size-limit': en ? '4 MiB limit reached' : '已达 4 MiB 上限', shutdown: en ? 'App shutdown' : '应用退出'
  }
  return <div className="performance-capture" aria-labelledby="performance-capture-title" aria-busy={busy}>
    <div className="performance-capture-heading">
      <h3 id="performance-capture-title">{en ? 'Performance recording' : '性能诊断记录'}</h3>
      <span className="plugin-memory-badge" role="status">{state ? labels[state.status] : (en ? 'Loading status' : '读取状态中')}</span>
    </div>
    <p className="desc">{en
      ? 'Off by default. Sample every 5 seconds for up to 10 minutes (121 samples / 4 MiB); CPU deltas need at least two samples. Open, switch and close plugins normally, then stop and export JSON. Recording continues when you leave Settings.'
      : '默认关闭。每 5 秒采样，最长 10 分钟（最多 121 个样本 / 4 MiB）；CPU 差分需要至少两个样本。开始后正常打开、切换、关闭插件，再停止并导出 JSON；离开设置页仍继续记录。'}</p>
    <div className="performance-capture-actions">
      <Button variant="primary" size="sm" disabled={busy || running || stopping || unavailable || !state} onClick={() => { void act('start') }}>
        {state?.sampleCount ? (en ? 'Start New Recording' : '开始新记录') : (en ? 'Start Recording' : '开始采样')}
      </Button>
      <Button variant="ghost" size="sm" disabled={busy || !running} onClick={() => { void act('stop') }}>{en ? 'Stop' : '停止采样'}</Button>
      <Button variant="ghost" size="sm" disabled={busy || stopping || !state?.sampleCount || unavailable} onClick={() => { void act('export') }}>
        {running ? (en ? 'Stop & Export JSON' : '停止并导出 JSON') : (en ? 'Export JSON' : '导出 JSON')}
      </Button>
    </div>
    {state && state.status !== 'idle' && !unavailable && <p className="performance-capture-status" role="status">
      {en ? `${state.sampleCount} samples · ${(state.retainedBytes / 1024).toFixed(1)} KiB · ${state.failedSamples} failed` : `${state.sampleCount} 个样本 · ${(state.retainedBytes / 1024).toFixed(1)} KiB · ${state.failedSamples} 次失败`}
      {state.stopReason && ` · ${stops[state.stopReason]}`}
      {running && state.deadlineAt && ` · ${en ? 'Stops by' : '最晚停止于'} ${new Date(state.deadlineAt).toLocaleTimeString(locale)}`}
      {state.captureId && <code>{state.captureId}</code>}
    </p>}
    <p className="plugin-memory-note">{en
      ? 'Includes unique process memory, single-core CPU deltas, plugin generations, backgrounds, auxiliary windows, file streams and DevTools/focus flags. Native-child CPU may be unavailable. No commands, paths or payloads are collected. Numeric summaries also appear in main.log / console as [performance-capture]. A new recording replaces the previous in-memory recording; quitting clears it.'
      : '包含唯一进程内存、单核口径 CPU 差分、插件代次、后台、辅助窗口、文件流及 DevTools / 焦点标记；原生子进程 CPU 可能不可用。不记录命令、路径或业务内容。main.log / console 同时输出 [performance-capture] 数值摘要。新记录覆盖上次内存记录，退出应用后清空。'}</p>
    {error && <p className="plugin-memory-error" role="alert">{error}</p>}
    {notice && <p className="plugin-memory-message" role="status">{notice}</p>}
  </div>
}
