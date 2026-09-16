/**
 * PluginHostChrome — 插件宿主 Chrome（Tab 打开后的插件视图壳）
 * 顶部 plugin-bar 显示插件名与 enest:// 协议 URL；主体为启动中/出错占位。
 * 支持 manifest.ui.chrome 三档：default（48px 标准条）/ minimal（28px 细条）/ none（无条，全幅）。
 * 实际插件内容由 main 侧 WebContentsView 覆盖本层（pointer-events: none）。
 * orb 模式下本层经 CSS `left: var(--orb-rail-inset)` 从通道右侧起铺，左侧不铺底、不占满圆轨通道。
 * 依赖：shellStore（tabs/activeTabId/plugins/pluginReady/pluginError）、@shared/constants 协议与分区工具。
 */
import { useShellStore } from '@renderer/stores/shellStore'
import { pluginProtocolUrl, pluginPartition } from '@shared/constants'
import type { PluginChromeMode } from '@shared/types/plugin'

export function PluginHostChrome() {
  const tabs = useShellStore((s) => s.tabs)
  const activeTabId = useShellStore((s) => s.activeTabId)
  const plugins = useShellStore((s) => s.plugins)
  const pluginReady = useShellStore((s) => s.pluginReady)
  const pluginError = useShellStore((s) => s.pluginError)

  const tab = tabs.find((t) => t.id === activeTabId)
  if (!tab) return null

  const plugin = plugins.find((p) => p.id === tab.pluginId)
  const url = pluginProtocolUrl(tab.pluginId)
  // manifest.ui.chrome：default | minimal | none（缺省 default）
  const chrome: PluginChromeMode = plugin?.ui?.chrome ?? 'default'
  const showBar = chrome !== 'none'
  const barClass = chrome === 'minimal' ? 'plugin-bar plugin-bar-minimal' : 'plugin-bar'

  return (
    <div className="plugin-view">
      {showBar && (
        <div className={barClass}>
          <div className="left">
            <span className="live-dot" style={{ background: tab.color }} />
            <span className="name">{tab.title}</span>
            {chrome !== 'minimal' && <span className="path">{url}</span>}
          </div>
        </div>
      )}
      {!pluginReady && !pluginError && (
        <div className="plugin-body">
          <div className="isolate-panel">
            <h2>正在启动 {tab.title}…</h2>
            <p>WebContentsView 正在挂载，就绪后本占位层会被原生插件内容覆盖。</p>
          </div>
        </div>
      )}
      {pluginError && (
        <div className="plugin-body">
          <div className="isolate-panel">
            <h2>插件出错</h2>
            <p>{pluginError}</p>
            <div className="iso-grid">
              <div className="iso-tile">
                <strong>进程隔离</strong>
                <span>{pluginPartition(tab.pluginId)}</span>
              </div>
              <div className="iso-tile">
                <strong>权限</strong>
                <span>{plugin?.permissions.join(' · ') || '—'}</span>
              </div>
            </div>
          </div>
        </div>
      )}
      {pluginReady && !pluginError && (
        <div style={{ flex: 1, pointerEvents: 'none' }} aria-hidden="true" />
      )}
    </div>
  )
}
