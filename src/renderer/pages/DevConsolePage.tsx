/**
 * DevConsolePage — 开发者控制台页
 * 本地目录加载插件、热重载、打开 DevTools，以及滚动 IPC/console 日志列表。
 * 依赖：shellStore（devLogs/loadDevPlugin/reloadActivePlugin/openDevToolsActive/plugins）。
 */
import { useEffect, useRef, useState } from 'react'
import { useShellStore } from '@renderer/stores/shellStore'

export function DevConsolePage() {
  const devLogs = useShellStore((s) => s.devLogs)
  const loadDevPlugin = useShellStore((s) => s.loadDevPlugin)
  const reloadActivePlugin = useShellStore((s) => s.reloadActivePlugin)
  const openDevToolsActive = useShellStore((s) => s.openDevToolsActive)
  const plugins = useShellStore((s) => s.plugins)
  const [dirPath, setDirPath] = useState('')
  const logRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight
  }, [devLogs])

  const devPlugins = plugins.filter((p) => p.devUrl || p.rootPath)

  return (
    <section className="page">
      <div className="dev-shell">
        <div className="settings-header">
          <h1>开发者</h1>
          <p>本地目录调试 · 热更新 · DevTools · IPC 日志</p>
        </div>
        <div className="dev-grid">
          <div className="s-card">
            <h2>开发中</h2>
            <p className="hint">development.main 可指向 Vite / Webpack</p>
            {devPlugins.length === 0 ? (
              <div className="field">
                <div>
                  <div className="label">暂无开发插件</div>
                  <p className="desc">在下方输入本地目录加载 plugin.json</p>
                </div>
              </div>
            ) : (
              devPlugins.map((p) => (
                <div className="field" key={p.id}>
                  <div>
                    <div className="label">{p.id}</div>
                    <p className="desc">
                      {p.rootPath ?? '—'} · {p.devUrl ?? '—'}
                    </p>
                  </div>
                  <span className="tag">HMR</span>
                </div>
              ))
            )}
            <div className="dev-path-row">
              <input
                type="text"
                placeholder="本地插件目录绝对路径…"
                value={dirPath}
                onChange={(e) => setDirPath(e.target.value)}
              />
            </div>
            <div className="dev-actions">
              <button
                className="btn btn-primary btn-sm"
                type="button"
                onClick={() => void loadDevPlugin(dirPath)}
              >
                加载本地目录
              </button>
              <button className="btn btn-ghost btn-sm" type="button" onClick={() => void reloadActivePlugin()}>
                热重载
              </button>
              <button className="btn btn-ghost btn-sm" type="button" onClick={() => void openDevToolsActive()}>
                DevTools
              </button>
            </div>
          </div>
          <div className="s-card">
            <h2>日志</h2>
            <p className="hint">console + IPC</p>
            <div className="log" ref={logRef}>
              {devLogs.map((l, i) => (
                <div key={i} className={l.level === 'info' ? '' : l.level}>
                  {l.text}
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </section>
  )
}
