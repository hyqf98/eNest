/**
 * DevConsoleSection — 设置 → 开发者
 * 加载本地源码目录并直接打开插件→ 启动/停止调试 / DevTools / 移除；开发中列表与日志。
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { useShellStore } from '@renderer/stores/shellStore'
import { shellApi } from '@renderer/services/shellApi'
import type { PluginCallTraceEntry } from '@shared/types/ipc'
import { PluginIcon } from '@renderer/components/PluginIcon'
import { notify } from '@renderer/services/notifyService'
import { useI18n } from '@renderer/hooks/useI18n'

/** 调用跟踪自动刷新间隔（面板开启轮询时；关闭即停，无常驻开销） */
const TRACE_POLL_MS = 1000

function formatTraceTime(ts: number): string {
  const d = new Date(ts)
  const p = (n: number, w = 2): string => String(n).padStart(w, '0')
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`
}

export function DevConsoleSection() {
  const devLogs = useShellStore((s) => s.devLogs)
  const loadDevPlugin = useShellStore((s) => s.loadDevPlugin)
  const startDebugPlugin = useShellStore((s) => s.startDebugPlugin)
  const stopDebugPlugin = useShellStore((s) => s.stopDebugPlugin)
  const removeDevPlugin = useShellStore((s) => s.removeDevPlugin)
  const openPlugin = useShellStore((s) => s.openPlugin)
  const plugins = useShellStore((s) => s.plugins)
  const tabs = useShellStore((s) => s.tabs)
  const [dirPath, setDirPath] = useState('')
  const [preview, setPreview] = useState<'manifest' | 'server' | 'static' | 'dist'>('manifest')
  const [devHost, setDevHost] = useState('127.0.0.1')
  const [devPort, setDevPort] = useState('5173')
  const [devUrl, setDevUrl] = useState('')
  const [loading, setLoading] = useState(false)
  const [debuggingId, setDebuggingId] = useState<string | null>(null)
  const [trace, setTrace] = useState<PluginCallTraceEntry[]>([])
  const [traceAuto, setTraceAuto] = useState(false)
  const traceTimer = useRef<ReturnType<typeof setInterval> | null>(null)
  const logRef = useRef<HTMLDivElement>(null)
  const { t } = useI18n()

  const refreshTrace = useCallback(async () => {
    try {
      const entries = await shellApi.getPluginCallTrace?.()
      setTrace(entries ?? [])
    } catch {
      /* IPC 失败保持旧数据 */
    }
  }, [])

  // 自动刷新：仅开启时轮询（1s），关闭即停
  useEffect(() => {
    if (!traceAuto) return
    void refreshTrace()
    traceTimer.current = setInterval(() => void refreshTrace(), TRACE_POLL_MS)
    return () => {
      if (traceTimer.current) clearInterval(traceTimer.current)
      traceTimer.current = null
    }
  }, [traceAuto, refreshTrace])

  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight
  }, [devLogs])

  const devPlugins = plugins.filter((p) => p.dev === true)
  const openIds = new Set(tabs.map((t) => t.pluginId))

  /** 「退出即杀」开关状态（对齐 uTools）：挂载后逐插件查询主进程（内存 + dev.json 持久化） */
  const [killOnHide, setKillOnHide] = useState<Record<string, boolean>>({})
  useEffect(() => {
    for (const p of devPlugins) {
      if (killOnHide[p.id] !== undefined) continue
      void shellApi.setDevKillOnHide(p.id).then((on) => {
        setKillOnHide((cur) => ({ ...cur, [p.id]: on === true }))
      })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 仅在 dev 插件集合变化时补查缺失项
  }, [devPlugins.map((p) => p.id).join(',')])

  const toggleKillOnHide = async (id: string) => {
    const next = !(killOnHide[id] === true)
    setKillOnHide((cur) => ({ ...cur, [id]: next }))
    const confirmed = await shellApi.setDevKillOnHide(id, next)
    setKillOnHide((cur) => ({ ...cur, [id]: confirmed === true }))
  }

  const load = async (path?: string) => {
    if (loading) return
    setLoading(true)
    try {
      const url = preview === 'static' ? '' : preview === 'server' ? (devUrl.trim() || `http://${devHost.trim()}:${devPort.trim()}/`) : undefined
      if (url) {
        const endpoint = new URL(url)
        if (!['http:', 'https:'].includes(endpoint.protocol) || endpoint.username || endpoint.password) throw new Error('请输入有效的 HTTP(S) 开发地址')
      }
      await loadDevPlugin(path !== undefined ? path : '', { url, preview: preview === 'dist' ? 'dist' : 'source' })
      if (path?.trim()) setDirPath('')
    } catch (error) {
      notify.error(error instanceof Error ? error.message : String(error))
    } finally {
      setLoading(false)
    }
  }

  const handleStart = async (id: string) => {
    setDebuggingId(id)
    await startDebugPlugin(id)
  }

  const handleStop = async (id: string) => {
    await stopDebugPlugin(id)
    setDebuggingId((cur) => (cur === id ? null : cur))
  }

  const handleRemove = async (id: string, name: string) => {
    if (!window.confirm(t('devConsole.removeConfirm', { name }))) return
    await removeDevPlugin(id)
    setDebuggingId((cur) => (cur === id ? null : cur))
  }

  return (
    <>
      <div className="s-card">
        <h2>{t('devConsole.title')}</h2>
        <p className="hint">{t('devConsole.subtitle')}</p>

        <div className="dev-load-hero">
          <button
            className="btn btn-primary dev-load-primary"
            type="button"
            disabled={loading}
            onClick={() => void load('')}
          >
            {loading ? t('common.loading') : t('devConsole.browse')}
          </button>
          <p className="desc" style={{ margin: '8px 0 0' }}>
            选择含 plugin.json 的源码目录后直接打开。开发服务由终端启动，壳子不会安装依赖或监听源码。
          </p>
        </div>

        <div className="dev-source-options">
          <label>预览方式
            <select value={preview} onChange={event => setPreview(event.target.value as typeof preview)}>
              <option value="manifest">使用 plugin.json 配置</option>
              <option value="server">连接开发服务器</option>
              <option value="static">静态源码（手动刷新）</option>
              <option value="dist">预览 dist 构建产物</option>
            </select>
          </label>
          {preview === 'server' && <>
            <label>IP / 主机<input value={devHost} onChange={event => setDevHost(event.target.value)} placeholder="127.0.0.1" /></label>
            <label>端口<input inputMode="numeric" value={devPort} onChange={event => setDevPort(event.target.value)} placeholder="5173" /></label>
            <label className="dev-url-field">完整 URL（可选，优先使用）<input value={devUrl} onChange={event => setDevUrl(event.target.value)} placeholder="http://192.168.1.10:5173/" /></label>
          </>}
        </div>

        <div className="dev-load-row">
          <input
            type="text"
            className="dev-load-input"
            placeholder={t('devConsole.pathPlaceholder')}
            value={dirPath}
            onChange={(e) => setDirPath(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && dirPath.trim()) void load(dirPath.trim())
            }}
          />
          <button
            className="btn btn-ghost btn-sm"
            type="button"
            disabled={loading || !dirPath.trim()}
            onClick={() => void load(dirPath.trim())}
          >
            {t('devConsole.loadDir')}
          </button>
        </div>
      </div>

      <div className="s-card">
        <h2>{t('devConsole.developing')}</h2>
        {devPlugins.length === 0 ? (
          <p className="desc">{t('devConsole.emptyDesc')}</p>
        ) : (
          <div className="dev-plugin-list">
            {devPlugins.map((p) => {
              const running = openIds.has(p.id)
              const isSelf = debuggingId === p.id || running
              return (
                <div className={`dev-plugin-item${running ? ' running' : ''}`} key={p.id}>
                  <PluginIcon src={p.icon} glyph={p.glyph} size={40} alt={p.name} />
                  <div className="dev-plugin-meta">
                    <div className="dev-plugin-name">
                      {p.name}
                      {running ? <span className="dev-run-dot" /> : null}
                    </div>
                    <code className="dev-plugin-path">
                      {p.rootPath ?? '—'}
                      {p.devUrl ? ` · ${p.devUrl}` : ''}
                    </code>
                  </div>
                  <div className="dev-plugin-actions">
                    {running ? (
                      <>
                        <button
                          className="btn btn-ghost btn-sm"
                          type="button"
                          onClick={() => void openPlugin(p.id)}
                        >
                          {t('devConsole.view')}
                        </button>
                        <button
                          className="btn btn-ghost btn-sm"
                          type="button"
                          onClick={() => void handleStop(p.id)}
                        >
                          {t('devConsole.stop')}
                        </button>
                        <button
                          className="btn btn-ghost btn-sm"
                          type="button"
                          onClick={() => void shellApi.openDevTools(p.id)}
                        >
                          DevTools
                        </button>
                        <button
                          className="btn btn-ghost btn-sm"
                          type="button"
                          onClick={() => void shellApi.reloadPlugin(p.id)}
                        >
                          {t('devConsole.reload')}
                        </button>
                      </>
                    ) : (
                      <button
                        className="btn btn-primary btn-sm"
                        type="button"
                        disabled={!!debuggingId && !isSelf}
                        onClick={() => void handleStart(p.id)}
                      >
                        {t('devConsole.start')}
                      </button>
                    )}
                    <button
                      className="btn btn-danger btn-sm"
                      type="button"
                      onClick={() => void handleRemove(p.id, p.name)}
                    >
                      {t('devConsole.remove')}
                    </button>
                    {p.devUrl ? <span className="tag">HMR</span> : null}
                    <button
                      className={`btn btn-ghost btn-sm${killOnHide[p.id] ? ' active' : ''}`}
                      type="button"
                      aria-pressed={killOnHide[p.id] === true}
                      title={t('devConsole.killOnHideHint')}
                      onClick={() => void toggleKillOnHide(p.id)}
                    >
                      {t('devConsole.killOnHide')}
                    </button>
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </div>

      <div className="s-card">
        <div className="dev-card-head">
          <h2 style={{ margin: 0 }}>{t('devConsole.logs')}</h2>
          <span className="tag">{devLogs.length}</span>
        </div>
        <div className="dev-log" ref={logRef}>
          {devLogs.map((l, i) => (
            <div key={i} className={`dev-log-line ${l.level === 'info' ? '' : l.level}`}>
              {l.text}
            </div>
          ))}
        </div>
      </div>

      <div className="s-card">
        <div className="dev-card-head">
          <h2 style={{ margin: 0 }}>{t('devConsole.trace')}</h2>
          <div className="dev-head-actions">
            <span className="tag">{trace.length}</span>
            <button
              className={`btn btn-ghost btn-sm${traceAuto ? ' active' : ''}`}
              type="button"
              aria-pressed={traceAuto}
              onClick={() => setTraceAuto((v) => !v)}
            >
              {traceAuto ? t('devConsole.traceAutoOn') : t('devConsole.traceAutoOff')}
            </button>
            <button
              className="btn btn-ghost btn-sm"
              type="button"
              onClick={() => void refreshTrace()}
            >
              {t('devConsole.traceRefresh')}
            </button>
          </div>
        </div>
        <p className="hint" style={{ margin: '0 0 10px' }}>
          {t('devConsole.traceHint')}
        </p>
        {trace.length === 0 ? (
          <p className="desc">{t('devConsole.traceEmpty')}</p>
        ) : (
          <div className="dev-trace">
            <table className="dev-trace-table">
              <thead>
                <tr>
                  <th>{t('devConsole.traceTime')}</th>
                  <th>{t('devConsole.tracePlugin')}</th>
                  <th>{t('devConsole.traceMethod')}</th>
                  <th>{t('devConsole.traceDuration')}</th>
                  <th>{t('devConsole.traceError')}</th>
                </tr>
              </thead>
              <tbody>
                {trace
                  .slice()
                  .reverse()
                  .map((e, i) => (
                    <tr key={`${e.ts}-${i}`} className={e.ok ? '' : 'err'}>
                      <td>{formatTraceTime(e.ts)}</td>
                      <td title={e.pluginId}>{e.pluginId}</td>
                      <td>
                        <code>{e.method}</code>
                      </td>
                      <td className="num">{e.durationMs} ms</td>
                      <td className="err-text" title={e.error ?? ''}>
                        {e.error ?? '—'}
                      </td>
                    </tr>
                  ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </>
  )
}
