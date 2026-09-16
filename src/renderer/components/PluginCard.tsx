/**
 * PluginCard — 市场网格中的插件卡片
 * 展示图标渐变、名称、描述、分类/安装量；整卡点击打开详情，操作按钮安装/打开插件。
 * 由 MarketPage 网格渲染；插件数据来自 shellStore.plugins。
 */
import type { PluginSummary } from '@shared/types/plugin'

function iconBackground(p: PluginSummary): string {
  return `linear-gradient(145deg, ${p.color}, color-mix(in srgb, ${p.color} 50%, #111))`
}

interface Props {
  plugin: PluginSummary
  /** 安装 / 打开（操作按钮；阻止冒泡） */
  onOpen: (id: string) => void
  /** 打开详情弹窗；未提供时整卡回落 onOpen */
  onDetail?: (id: string) => void
}

export function PluginCard({ plugin, onOpen, onDetail }: Props) {
  const handleCard = () => {
    if (onDetail) onDetail(plugin.id)
    else onOpen(plugin.id)
  }

  return (
    <article className="card" onClick={handleCard}>
      {plugin.installed ? <span className="badge-installed">已安装</span> : null}
      <div className="card-head">
        <div className="card-icon" style={{ background: iconBackground(plugin) }}>
          {plugin.glyph}
        </div>
        <h3>{plugin.name}</h3>
        <span className="arrow">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M7 17 17 7M9 7h8v8" />
          </svg>
        </span>
      </div>
      <p>{plugin.description}</p>
      <div className="card-foot">
        <span className="tag">{plugin.category}</span>
        <span className="stars">★ {plugin.installs}</span>
        <button
          type="button"
          className={`btn btn-sm ${plugin.installed ? 'btn-ghost' : 'btn-primary'}`}
          onClick={(e) => {
            e.stopPropagation()
            onOpen(plugin.id)
          }}
        >
          {plugin.installed ? '打开' : '安装'}
        </button>
      </div>
    </article>
  )
}
