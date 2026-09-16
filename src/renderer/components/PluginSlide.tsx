/**
 * PluginSlide — 精选轮播中的单张插件幻灯片
 * 与 PluginCard 类似的展示结构，但适配轮播横滑布局。
 * 整卡点击打开详情，操作按钮安装/打开插件。
 * 由 FeaturedCarousel 渲染。
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

export function PluginSlide({ plugin, onOpen, onDetail }: Props) {
  const handleSlide = () => {
    if (onDetail) onDetail(plugin.id)
    else onOpen(plugin.id)
  }

  return (
    <article className="slide" onClick={handleSlide}>
      <div className="slide-top">
        <div className="slide-icon" style={{ background: iconBackground(plugin) }}>
          {plugin.glyph}
        </div>
        <div>
          <h3>{plugin.name}</h3>
          <div className="sub">
            {plugin.author} · v{plugin.version}
          </div>
        </div>
        <span className="slide-arrow">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M7 17 17 7M9 7h8v8" />
          </svg>
        </span>
      </div>
      <p>{plugin.description}</p>
      <div className="slide-foot">
        <span className="tag">{plugin.category}</span>
        {plugin.installed ? <span className="tag">已安装</span> : null}
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
