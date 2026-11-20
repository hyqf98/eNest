import { memo, useMemo, useRef, useState } from 'react'
import type { HomeCatalogItem } from '@shared/types/home'
import { useI18n } from '@renderer/hooks/useI18n'
import './homeCards.css'

interface HomeCardsViewProps {
  items: HomeCatalogItem[]
  /** 打开插件详情（小组件卡点击进入详情，可查看是否加入自由面板）。 */
  onOpen: (pluginId: string) => Promise<void> | void
  onError: (error: unknown) => void
}

/**
 * 首页「小组件」区块。
 *
 * 数据来源是**自由面板小组件的标准声明**：`plugin.json` 的 `views.layouts` 含 `panel`
 * 且 `views.panel.preview` 指向包内预览图（宿主已按资源白名单解析为 enest-home:// 地址）。
 * 壳子不扫目录、不猜文件名——没有声明的插件不会出现在这里。
 *
 * 卡片展示的是小组件在面板里的**真实渲染截图**，不是插件图标+文字的通用卡片：
 * 小组件的价值就在于"它长什么样"，用图标卡看不出尺寸与布局密度。
 */
export const HomeCardsView = memo(function HomeCardsView({ items, onOpen, onError }: HomeCardsViewProps) {
  const { locale } = useI18n()
  const english = locale === 'en-US'
  // 只列已安装、启用、且真的声明了 panel 预览的插件。
  const widgets = useMemo(() => items.filter(item =>
    item.installed && item.enabled !== false && typeof item.panelPreview === 'string' && item.panelPreview
  ), [items])
  const pending = useRef(false)
  const [opening, setOpening] = useState<string | null>(null)
  const open = async (pluginId: string) => {
    if (pending.current) return
    pending.current = true
    setOpening(pluginId)
    try { await onOpen(pluginId) }
    catch (error) { onError(error) }
    finally { pending.current = false; setOpening(null) }
  }
  if (!widgets.length) return null
  return (
    <section className="market-widgets" aria-label={english ? 'Widgets' : '小组件'}>
      <div className="section-head contrib-head">
        <h2>{english ? 'Widgets' : '小组件'}</h2>
        <span className="market-widgets-hint">
          {english ? 'Plugins that support free-canvas panels' : '支持自由面板的插件'}
        </span>
      </div>
      <div className="widget-grid">
        {widgets.map(widget => {
          const busy = opening === widget.pluginId
          const size = widget.panelSize
          return (
            <button
              key={widget.pluginId}
              type="button"
              className="widget-card"
              disabled={opening !== null}
              aria-busy={busy}
              title={widget.description || widget.name}
              onClick={() => void open(widget.pluginId)}
            >
              {/* 预览图按小组件真实宽高比展示，让用户先看到它放进面板后的比例。 */}
              <span
                className="widget-preview"
                style={size ? { aspectRatio: `${size.width} / ${size.height}` } : undefined}
              >
                <img src={widget.panelPreview} alt="" loading="lazy" decoding="async" draggable={false} />
              </span>
              <span className="widget-meta">
                <strong className="widget-name">{widget.name}</strong>
                {size && <span className="widget-size">{size.width}×{size.height}</span>}
              </span>
            </button>
          )
        })}
      </div>
    </section>
  )
})
