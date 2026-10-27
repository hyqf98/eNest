/**
 * DevConsoleSection — 设置 → 开发者
 * 加载本地源码目录并直接打开插件 → 启动/停止调试 / 移除；开发中列表与日志。
 * DevTools 与重载走键盘快捷键（插件内/壳内 F12、⌘⌥I、⌘R），不再放按钮；
 * 热更新由壳子自动负责：优先拉起开发服务走框架 HMR，否则监听目录变更自动重载。
 * 列表标签显示后台自动识别结果（Vite / Next / Nuxt / webpack / 自定义命令 / 静态 HTML / 构建产物）。
 */
import { useEffect, useRef, useState } from 'react'
import { useShellStore } from '@renderer/stores/shellStore'
import { PluginIcon } from '@renderer/components/PluginIcon'
import { notify } from '@renderer/services/notifyService'
import { confirmAction } from '@renderer/services/confirmAction'
import { useI18n } from '@renderer/hooks/useI18n'

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
  const [loading, setLoading] = useState(false)
  const [debuggingId, setDebuggingId] = useState<string | null>(null)
  const logRef = useRef<HTMLDivElement>(null)
  const { t } = useI18n()

  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight
  }, [devLogs])

  const devPlugins = plugins.filter((p) => p.dev === true)
  const openIds = new Set(tabs.map((t) => t.pluginId))

  const load = async (path?: string) => {
    if (loading) return
    setLoading(true)
    try {
      await loadDevPlugin(path !== undefined ? path : '')
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
    if (!await confirmAction({ title: t('devConsole.remove'), message: t('devConsole.removeConfirm', { name }), confirmLabel: t('devConsole.remove') })) return
    await removeDevPlugin(id)
    setDebuggingId((cur) => (cur === id ? null : cur))
  }

  const copyLogs = async () => {
    const text = devLogs.map((l) => l.text).join('\n')
    try {
      await navigator.clipboard.writeText(text)
      notify.success(t('devConsole.copied'))
    } catch (error) {
      notify.error(error instanceof Error ? error.message : String(error))
    }
  }

  /** 自动识别结果标签：开发服务显示「开发服务 · 框架」，离线产物显示「构建产物」，无服务声明显示「静态 HTML」 */
  const kindLabel = (kind: string | undefined, runningServer: boolean, builtPreview: boolean) => {
    if (builtPreview) return t('devConsole.kindDist')
    if (runningServer) {
      if (kind === 'vite' || kind === 'next' || kind === 'nuxt' || kind === 'webpack' || kind === 'custom') {
        return `${t('devConsole.kindServer')} · ${t(`devConsole.kind.${kind}`)}`
      }
      return t('devConsole.kindServer')
    }
    return t('devConsole.kindStatic')
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
        </div>

        <div className="dev-load-row">
          <input
            type="text"
            className="dev-load-input"
            aria-label={t('devConsole.pathPlaceholder')}
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
              const server = !!p.devUrl
              return (
                <div className={`dev-plugin-item${running ? ' running' : ''}`} key={p.id}>
                  <PluginIcon src={p.icon} glyph={p.glyph} size={40} alt={p.name} />
                  <div className="dev-plugin-meta">
                    <div className="dev-plugin-name">
                      {p.name}
                      {running ? <span className="dev-run-dot" /> : null}
                      <span className="tag">
                        {kindLabel(p.devKind, server, !server && p.devSource === false)}
                      </span>
                      {server && p.devCommand ? <code className="dev-command-tag">{p.devCommand}</code> : null}
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
          <div className="dev-card-head-actions">
            <span className="tag">{devLogs.length}</span>
            <button
              className="btn btn-ghost btn-sm"
              type="button"
              disabled={!devLogs.length}
              onClick={() => void copyLogs()}
            >
              {t('devConsole.copyLogs')}
            </button>
          </div>
        </div>
        <div className="dev-log" ref={logRef}>
          {devLogs.map((l, i) => (
            <div key={i} className={`dev-log-line ${l.level === 'info' ? '' : l.level}`}>
              {l.text}
            </div>
          ))}
        </div>
      </div>

    </>
  )
}
