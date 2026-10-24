import { useId, useLayoutEffect, useRef, useState } from 'react'
import type { PluginPresentation } from './pluginPresentation'
import { useI18n } from '@renderer/hooks/useI18n'
import { Fragment, type ReactNode } from 'react'
import { ChevronRightIcon } from '@renderer/components/icons'

export interface MarketCategoryViewProps<T extends PluginPresentation> {
  category: string
  plugins: T[]
  renderPlugin: (plugin: T) => ReactNode
}

/** 每组默认展示实际网格的两行；折叠项不挂载，避免键盘进入不可见卡片。 */
export function MarketCategoryView<T extends PluginPresentation>({ category, plugins, renderPlugin }: MarketCategoryViewProps<T>) {
  const { t } = useI18n()
  const id = useId()
  const gridRef = useRef<HTMLDivElement>(null)
  const toggleRef = useRef<HTMLButtonElement>(null)
  const restoreFocusRef = useRef(false)
  const [columns, setColumns] = useState(1)
  const [expanded, setExpanded] = useState(false)
  const limit = columns * 2
  const remaining = Math.max(0, plugins.length - limit)
  const visiblePlugins = expanded ? plugins : plugins.slice(0, limit)
  const toggleLabel = expanded ? t('market.collapseCategory') : t('market.morePlugins', { n: remaining })

  useLayoutEffect(() => {
    const grid = gridRef.current
    if (!grid) return
    const measure = () => {
      if (grid.clientWidth === 0) return
      // 读取 CSS 的实际轨道数量，跟随窗口缩放和后续断点调整。
      const tracks = getComputedStyle(grid).gridTemplateColumns
      const nextColumns = tracks === 'none' ? 1 : Math.max(1, tracks.trim().split(/\s+/).length)
      const cards = Array.from(grid.children)
      const focusedIndex = cards.findIndex((card) => card.contains(document.activeElement))
      if (!expanded && focusedIndex >= nextColumns * 2) restoreFocusRef.current = true
      setColumns((current) => current === nextColumns ? current : nextColumns)
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(grid)
    return () => observer.disconnect()
  }, [expanded])

  useLayoutEffect(() => {
    if (!restoreFocusRef.current) return
    toggleRef.current?.focus({ preventScroll: true })
    restoreFocusRef.current = false
  }, [columns])

  return (
    <section className="market-category" aria-labelledby={`${id}-title`}>
      <header className="market-category-head">
        <div className="market-category-title">
          <h2 id={`${id}-title`}>{category}</h2>
          <span className="market-category-count">{t('market.pluginsCount', { n: plugins.length })}</span>
        </div>
        {remaining > 0 && (
          <button ref={toggleRef} type="button" className="market-category-toggle"
            aria-expanded={expanded} aria-controls={`${id}-grid`} aria-label={`${category} · ${toggleLabel}`}
            onClick={() => setExpanded((current) => !current)}>
            <span>{toggleLabel}</span>
            <ChevronRightIcon size={14} />
          </button>
        )}
      </header>
      <div id={`${id}-grid`} className="grid market-grid" ref={gridRef}>
        {visiblePlugins.map((plugin) => (
          <Fragment key={plugin.id}>{renderPlugin(plugin)}</Fragment>
        ))}
      </div>
    </section>
  )
}
