/**
 * DevConsoleSection — 设置页「开发者」工作台
 * 本地目录加载、热重载、DevTools、开发中插件列表与 IPC/console 日志。
 * 由 SettingsPage 在 settingsTab === 'dev' 时挂载（不再作为独立 view）。
 * 依赖：shellStore（devLogs/loadDevPlugin/reloadActivePlugin/openDevToolsActive/plugins）。
 */
import { useEffect, useRef, useState } from 'react'
import { useShellStore } from '@renderer/stores/shellStore'
import { useI18n } from '@renderer/hooks/useI18n'

export function DevConsoleSection() {
  const devLogs = useShellStore((s) => s.devLogs)
  const loadDevPlugin = useShellStore((s) => s.loadDevPlugin)
  const reloadActivePlugin = useShellStore((s) => s.reloadActivePlugin)
  const openDevToolsActive = useShellStore((s) => s.openDevToolsActive)
  const plugins = useShellStore((s) => s.plugins)
  const activeTabId = useShellStore((s) => s.activeTabId)
  const tabs = useShellStore((s) => s.tabs)
  const [dirPath, setDirPath] = useState('')
  const [loading, setLoading] = useState(false)
  const logRef = useRef<HTMLDivElement>(null)
  const { t } = useI18n()

  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight
  }, [devLogs])

  const devPlugins = plugins.filter((p) => p.devUrl || p.rootPath)
  const activeTab = tabs.find((x) => x.id === activeTabId)

  const handleLoad = async () => {
    if (!dirPath.trim() || loading) return
    setLoading(true)
    try {
      await loadDevPlugin(dirPath.trim())
      setDirPath('')
    } finally {
      setLoading(false)
    }
  }

  return (
    <>
      <div className="s-card dev-card">
        <div className="dev-card-head">
          <div>
            <h2>{t('devConsole.title')}</h2>
            <p className="hint" style={{ margin: 0 }}>{t('devConsole.subtitle')}</p>
          </div>
          <div className="dev-head-actions">
            <button
              className="btn btn-ghost btn-sm"
              type="button"
              onClick={() => void reloadActivePlugin()}
            >
              {t('devConsole.reload')}
            </button>
            <button
              className="btn btn-ghost btn-sm"
              type="button"
              onClick={() => void openDevToolsActive()}
            >
              DevTools
            </button>
          </div>
        </div>

        <div className="field" style={{ borderTop: 'none', paddingTop: 8 }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div className="label">{t('devConsole.loadDir')}</div>
            <p className="desc">
              {activeTab
                ? `${t('devConsole.developing')}: ${activeTab.title}`
                : t('devConsole.developingHint')}
            </p>
          </div>
        </div>

        <div className="dev-load-row">
          <input
            type="text"
            className="dev-load-input"
            placeholder={t('devConsole.pathPlaceholder')}
            value={dirPath}
            onChange={(e) => setDirPath(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void handleLoad()
            }}
          />
          <button
            className="btn btn-primary btn-sm"
            type="button"
            disabled={loading || !dirPath.trim()}
            onClick={() => void handleLoad()}
          >
            {loading ? t('common.loading') : t('devConsole.loadDir')}
          </button>
        </div>
      </div>

      <div className="s-card">
        <h2>{t('devConsole.developing')}</h2>
        <p className="hint">{t('devConsole.developingHint')}</p>
        {devPlugins.length === 0 ? (
          <div className="dev-empty">
            <strong>{t('devConsole.emptyTitle')}</strong>
            <span>{t('devConsole.emptyDesc')}</span>
          </div>
        ) : (
          <div className="dev-plugin-list">
            {devPlugins.map((p) => (
              <div className="dev-plugin-item" key={p.id}>
                <span className="dev-plugin-ico" style={{ background: p.color }}>
                  {p.glyph}
                </span>
                <div className="dev-plugin-meta">
                  <div className="dev-plugin-name">{p.name}</div>
                  <code className="dev-plugin-path">{p.rootPath ?? '—'}</code>
                </div>
                {p.devUrl && <span className="tag">HMR</span>}
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="s-card">
        <div className="dev-card-head">
          <div>
            <h2>{t('devConsole.logs')}</h2>
            <p className="hint" style={{ margin: 0 }}>{t('devConsole.logsHint')}</p>
          </div>
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
    </>
  )
}
