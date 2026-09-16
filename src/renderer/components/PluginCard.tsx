/**
 * PluginCard — 市场网格中的插件卡片
 * 图标为品牌色圆角方块 + 居中 glyph；展示名称、描述（2 行截断）、分类/安装量。
 * 整卡与底部按钮行为一致：已安装 → onOpen 启动；未安装 → onDetail 详情（无 onDetail 时回落 onOpen 安装）。
 * 由 MarketPage 网格渲染；插件数据来自 shellStore.plugins。
 * 依赖：useI18n。
 */
import type { CSSProperties, MouseEvent } from 'react'
import type { PluginSummary } from '@shared/types/plugin'
import { useI18n } from '@renderer/hooks/useI18n'

/** 品牌色微渐变 + 柔和阴影（避免过重的粗渐变） */
function iconStyle(p: PluginSummary): CSSProperties {
  return {
    background: `linear-gradient(160deg, color-mix(in srgb, ${p.color} 88%, #fff) 0%, ${p.color} 52%, color-mix(in srgb, ${p.color} 72%, #000) 100%)`,
    boxShadow: `0 2px 8px color-mix(in srgb, ${p.color} 30%, transparent), inset 0 1px 0 color-mix(in srgb, #fff 22%, transparent)`,
  }
}

interface Props {
  plugin: PluginSummary
  /** 已安装时启动插件（整卡 / 按钮） */
  onOpen: (id: string) => void
  /** 未安装时打开详情；未提供时整卡/按钮回落 onOpen */
  onDetail?: (id: string) => void
}

export function PluginCard({ plugin, onOpen, onDetail }: Props) {
  const { t } = useI18n()

  const act = () => {
    if (plugin.installed) {
      onOpen(plugin.id)
      return
    }
    if (onDetail) onDetail(plugin.id)
    else onOpen(plugin.id)
  }

  const handleCard = () => act()

  const handleAction = (e: MouseEvent) => {
    e.stopPropagation()
    act()
  }

  const actionLabel = plugin.installed
    ? t('plugin.open')
    : onDetail
      ? t('plugin.detail')
      : t('plugin.install')

  return (
    <article className="card" onClick={handleCard}>
      {plugin.installed ? <span className="badge-installed">{t('plugin.installed')}</span> : null}
      <div className={plugin.installed ? 'card-head has-badge' : 'card-head'}>
        <div className="card-icon" style={iconStyle(plugin)} aria-hidden="true">
          {plugin.glyph}
        </div>
        <h3>{plugin.name}</h3>
        <span className="arrow" aria-hidden="true">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M7 17 17 7M9 7h8v8" />
          </svg>
        </span>
      </div>
      <p>{plugin.description}</p>
      <div className="card-foot">
        <span className="tag">{plugin.category}</span>
        <span className="installs">{plugin.installs}</span>
        <button
          type="button"
          className={`btn btn-sm ${plugin.installed ? 'btn-ghost' : 'btn-primary'}`}
          onClick={handleAction}
        >
          {actionLabel}
        </button>
      </div>
    </article>
  )
}
