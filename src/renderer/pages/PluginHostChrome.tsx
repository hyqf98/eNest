/**
 * PluginHostChrome — 插件宿主 Chrome（Tab 打开后的插件视图壳）
 * 顶部 plugin-bar 显示插件名；主体保留启动状态、错误信息与恢复操作。
 * 支持 manifest.ui.chrome 三档：default（48px 标准条）/ minimal（28px 细条）/ none（无条，全幅）。
 * 实际插件内容由 main 侧 WebContentsView 覆盖本层（pointer-events: none）。
 * orb 模式下插件内容全宽渲染（inset 0），左侧圆轨为顶层 WebContentsView 悬浮覆盖。
 * Tab 态：lazy（占位，点击 Tab 加载）与 crashed（崩溃面板 + 重试按钮）。
 * 依赖：shellStore（tabs/activeTabId/plugins/pluginReady/pluginError）。
 */
import { useShellStore } from '@renderer/stores/shellStore'
import type { PluginChromeMode } from '@shared/types/plugin'

export function PluginHostChrome() {
  const tabs = useShellStore((s) => s.tabs)
  const activeTabId = useShellStore((s) => s.activeTabId)
  const plugins = useShellStore((s) => s.plugins)
  const pluginReady = useShellStore((s) => s.pluginReady)
  const pluginError = useShellStore((s) => s.pluginError)
  const activateTab = useShellStore((s) => s.activateTab)

  const tab = tabs.find((t) => t.id === activeTabId)
  if (!tab) return null

  const plugin = plugins.find((p) => p.id === tab.pluginId)
  // manifest.ui.chrome：default | minimal | none（缺省 default）
  const chrome: PluginChromeMode = plugin?.ui?.chrome ?? 'default'
  const showBar = chrome !== 'none'
  const barClass = chrome === 'minimal' ? 'plugin-bar plugin-bar-minimal' : 'plugin-bar'

  // 惰性恢复的占位 Tab（未孵化渲染进程）：此处仅占位说明，点击 Tab 条即加载
  if (tab.lazy) {
    return (
      <div className="plugin-view">
        {showBar && (
          <div className={barClass}>
            <div className="left">
              <span className="live-dot" style={{ background: tab.color }} />
              <span className="name">{tab.title}</span>
            </div>
          </div>
        )}
        <div className="plugin-body">
          <div className="isolate-panel">
            <h2>{tab.title}</h2>
            <button
              className="btn btn-primary btn-sm"
              type="button"
              onClick={() => void activateTab(tab.id)}
            >
              立即加载
            </button>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="plugin-view">
      {showBar && (
        <div className={barClass}>
          <div className="left">
            <span className={`live-dot${tab.crashed ? ' crashed' : ''}`} style={{ background: tab.color }} />
            <span className="name">{tab.title}</span>
          </div>
        </div>
      )}
      {!pluginReady && !pluginError && (
        <div className="plugin-body plugin-launch-body">
          <div className="plugin-launch-state" role="status" aria-live="polite">
            <span className="plugin-launch-spinner" aria-hidden="true" />
            <span>正在启动 <strong>{tab.title}</strong>…</span>
          </div>
        </div>
      )}
      {pluginError && (
        <div className="plugin-body">
          <div className="isolate-panel">
            <h2>{tab.crashed ? '插件已崩溃' : '插件出错'}</h2>
            <p>{pluginError}</p>
            {tab.crashed && (
              <button
                className="btn btn-primary btn-sm"
                type="button"
                onClick={() => void activateTab(tab.id)}
              >
                重试启动
              </button>
            )}
          </div>
        </div>
      )}
      {pluginReady && !pluginError && (
        <div style={{ flex: 1, pointerEvents: 'none' }} aria-hidden="true" />
      )}
    </div>
  )
}
