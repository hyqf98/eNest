/** 插件市场：首页采用搜索、产品推荐、紧凑目录；筛选与安装仍使用壳子数据。 */
import { useEffect, useMemo, useRef, useState } from 'react'
import gsap from 'gsap'
import { useShellStore } from '@renderer/stores/shellStore'
import { useI18n } from '@renderer/hooks/useI18n'
import { HomeSearch } from '@renderer/components/HomeSearch'
import { CategoryChips } from '@renderer/components/CategoryChips'
import { SegmentTabs } from '@renderer/components/SegmentTabs'
import { FeaturedCarousel } from '@renderer/components/FeaturedCarousel'
import { PluginCard } from '@renderer/components/PluginCard'
import { PluginDetailModal } from '@renderer/components/PluginDetailModal'
import { animateCards, playHeroIn } from '@renderer/gsap/marketMotion'
import type { HomeCardContribution } from '@shared/types/plugin'
import { matchesSearchTerms, normalizeSearchText } from '@shared/search'

const CATEGORY_I18N: Record<string, string> = {
  效率: 'market.catProductivity',
  开发: 'market.catDev',
  设计: 'market.catDesign',
  媒体: 'market.catMedia',
  其它: 'market.catOther',
}

function categoryLabel(key: string, t: (k: string) => string): string {
  if (key === '全部') return t('market.all')
  return CATEGORY_I18N[key] ? t(CATEGORY_I18N[key]) : key
}

export function MarketPage() {
  const plugins = useShellStore((s) => s.plugins)
  const query = useShellStore((s) => s.query)
  const category = useShellStore((s) => s.category)
  const seg = useShellStore((s) => s.seg)
  const setQuery = useShellStore((s) => s.setQuery)
  const setCategory = useShellStore((s) => s.setCategory)
  const setSeg = useShellStore((s) => s.setSeg)
  const openPlugin = useShellStore((s) => s.openPlugin)
  const refreshPlugins = useShellStore((s) => s.refreshPlugins)
  const { t, locale } = useI18n()
  const scrollRef = useRef<HTMLDivElement>(null)
  const gridRef = useRef<HTMLDivElement>(null)
  const [detailId, setDetailId] = useState<string | null>(null)
  const [loading, setLoading] = useState(plugins.length === 0)
  const [loadError, setLoadError] = useState(false)
  const [refreshKey, setRefreshKey] = useState(0)

  useEffect(() => {
    let cancelled = false
    setLoadError(false)
    void refreshPlugins().catch(() => {
      if (!cancelled) setLoadError(true)
    }).finally(() => {
      if (!cancelled) setLoading(false)
    })
    return () => { cancelled = true }
  }, [refreshPlugins, refreshKey])

  useEffect(() => {
    const ctx = gsap.context(() => playHeroIn(scrollRef.current), scrollRef)
    return () => ctx.revert()
  }, [])

  useEffect(() => {
    if (loading) return
    const ctx = gsap.context(() => {
      const nodes = gridRef.current?.querySelectorAll('[data-plugin-card]')
      if (nodes?.length) animateCards(Array.from(nodes))
    }, gridRef)
    return () => ctx.revert()
  }, [loading])

  const categoryKeys = useMemo(() => {
    const categories = new Set(plugins.map((p) => p.category || '其它'))
    return ['全部', ...categories]
  }, [plugins])

  const list = useMemo(() => {
    const q = normalizeSearchText(query)
    return plugins.filter((p) => {
      if (seg === 'installed' && !p.installed) return false
      if (category !== '全部' && (p.category || '其它') !== category) return false
      return !q || matchesSearchTerms(`${p.name} ${p.description} ${p.id}`, q)
    })
  }, [plugins, query, category, seg])

  useEffect(() => {
    if (category !== '全部' && !categoryKeys.includes(category)) setCategory('全部')
  }, [category, categoryKeys, setCategory])

  const homeCards = useMemo(() => {
    const out: Array<HomeCardContribution & { pluginId: string; pluginName: string }> = []
    for (const p of plugins) {
      if (!p.installed || p.enabled === false || !Array.isArray(p.contributes?.homeCards)) continue
      for (const card of p.contributes.homeCards) {
        if (!card || typeof card !== 'object' || !card.title) continue
        out.push({ ...card, id: card.id || `${p.id}:card`, pluginId: p.id, pluginName: p.name })
      }
    }
    return out
  }, [plugins])

  // 推荐标记来自插件仓库；同优先级保持索引顺序，旧索引仍能展示。
  const carouselItems = useMemo(() => [...plugins]
    .sort((a, b) => Number(Boolean(b.featured)) - Number(Boolean(a.featured)))
    .slice(0, 5), [plugins])

  const showFeatured = seg === 'browse' && category === '全部' && !query.trim()
  const searching = Boolean(query.trim())
  const detailPlugin = detailId ? plugins.find((p) => p.id === detailId) ?? null : null
  const handleOpen = (id: string) => { void openPlugin(id) }

  return (
    <section className="page page-home" aria-label={t('nav.market')}>
      <div className="home-scroll" ref={scrollRef}>
        <HomeSearch value={query} onChange={setQuery} plugins={plugins} onDetail={setDetailId}
          onBrowseAll={() => { setQuery(''); setCategory('全部'); setSeg('browse') }} />

        {!searching && <>
        {showFeatured && carouselItems.length > 0 && (
          <FeaturedCarousel items={carouselItems} onOpen={handleOpen} onDetail={setDetailId} paused={detailId !== null} />
        )}

        <div className="home-toolbar">
          <SegmentTabs value={seg} onChange={setSeg} />
          <CategoryChips
            categories={categoryKeys.map((key) => categoryLabel(key, t))}
            value={categoryLabel(category, t)}
            onChange={(label) => setCategory(categoryKeys.find((key) => categoryLabel(key, t) === label) ?? '全部')}
          />
        </div>

        <section className="market-catalog" aria-label={seg === 'installed' ? t('market.installedPlugins') : t('market.browse')}>
          <div className="sr-only" aria-live="polite">
            <span>{query.trim() ? (locale === 'en-US' ? 'Search results' : '搜索结果') : seg === 'installed' ? t('market.installedPlugins') : (locale === 'en-US' ? 'Explore plugins' : '发现插件')}</span>
            <span>{t('market.pluginsCount', { n: list.length })}</span>
          </div>
          <div className="grid market-grid" ref={gridRef} aria-busy={loading}>
            {loading ? (
              <div className="market-loading" role="status">
                <span>{t('common.loading')}</span>
                <div className="market-skeletons" aria-hidden="true"><i /><i /><i /></div>
              </div>
            ) : loadError && plugins.length === 0 ? (
              <div className="empty">
                <strong>{locale === 'en-US' ? 'Unable to load plugins' : '暂时无法加载插件'}</strong>
                <button className="btn btn-ghost" type="button" onClick={() => { setLoading(true); setRefreshKey((key) => key + 1) }}>
                  {locale === 'en-US' ? 'Try again' : '重新加载'}
                </button>
              </div>
            ) : list.length === 0 ? (
              <div className="empty">
                <strong>{seg === 'installed' && !query.trim() && category === '全部' ? t('market.emptyInstalled') : t('market.emptySearch')}</strong>
                <span>{t('market.emptyHint')}</span>
                <button className="btn btn-ghost" type="button" onClick={() => { setQuery(''); setCategory('全部'); setSeg('browse') }}>
                  {t('market.viewAll')}
                </button>
              </div>
            ) : list.map((p) => (
              <PluginCard key={p.id} plugin={p} onOpen={handleOpen} onDetail={setDetailId} />
            ))}
          </div>
        </section>

        {homeCards.length > 0 && showFeatured && (
          <section className="market-extensions" aria-label={locale === 'en-US' ? 'Plugin extensions' : '插件扩展'}>
            <div className="section-head contrib-head"><h2>{locale === 'en-US' ? 'Plugin extensions' : '插件扩展'}</h2></div>
            <div className="grid contrib-grid">
              {homeCards.map((card) => (
                <button key={`${card.pluginId}:${card.id}`} type="button" className="card contrib-card"
                  onClick={() => void openPlugin(card.pluginId, card.openCode ? { code: card.openCode } : undefined)}
                  title={card.explain || card.pluginName}>
                  <span className="contrib-glyph" aria-hidden="true">{(card.glyph || card.title.slice(0, 1)).slice(0, 1).toUpperCase()}</span>
                  <span className="contrib-body">
                    <strong className="contrib-title">{card.title}</strong>
                    {card.explain && <span className="contrib-explain">{card.explain}</span>}
                    <span className="contrib-source">{card.pluginName}</span>
                  </span>
                </button>
              ))}
            </div>
          </section>
        )}
        </>}
      </div>
      {detailPlugin && <PluginDetailModal plugin={detailPlugin} onClose={() => setDetailId(null)} onInstall={handleOpen} />}
    </section>
  )
}
