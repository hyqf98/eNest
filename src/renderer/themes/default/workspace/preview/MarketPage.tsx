/** 插件市场：首页采用搜索、产品推荐、紧凑目录；筛选与安装仍使用壳子数据。 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import gsap from 'gsap'
import { useShellStore } from '@renderer/stores/shellStore'
import { useI18n } from '@renderer/hooks/useI18n'
import { useAppearanceStore } from '@renderer/hooks/useAppearance'
import { HomeSearch } from '@renderer/themes/default/workspace/preview/HomeSearch'
import { CategoryChips } from '@renderer/themes/default/workspace/CategoryChips'
import { SegmentTabs } from '@renderer/themes/default/workspace/SegmentTabs'
import { FeaturedCarousel } from '@renderer/themes/default/workspace/FeaturedCarousel'
import { MarketCategorySection } from '@renderer/themes/default/workspace/preview/MarketCategorySection'
import { PluginDetailModal } from '@renderer/themes/default/workspace/preview/PluginDetailModal'
import { RotateCwIcon } from '@renderer/components/icons'
import { animateCards, playHeroIn } from '@renderer/themes/default/motion/workspaceMotion'
import type { HomeCardContribution, PluginMarketStatus } from '@shared/types/plugin'
import { matchesSearchTerms, normalizeSearchText } from '@shared/search'
import { shellApi } from '@renderer/services/shellApi'

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
  const continuous = useAppearanceStore(state => state.appearance.animation.continuous)
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
  const [detail, setDetail] = useState<{ id: string; origin: HTMLElement | null } | null>(null)
  const handleDetail = useCallback((id: string, origin?: HTMLElement | null) => setDetail({ id, origin: origin ?? null }), [])
  const closeDetail = useCallback(() => setDetail(null), [])
  const [loading, setLoading] = useState(plugins.length === 0)
  const [loadError, setLoadError] = useState(false)
  const [refreshKey, setRefreshKey] = useState(0)
  const [refreshing, setRefreshing] = useState(true)
  const [marketStatus, setMarketStatus] = useState<PluginMarketStatus | null>(null)

  useEffect(() => {
    let cancelled = false
    setLoadError(false)
    setRefreshing(true)
    void (async () => {
      // Installed plugins are available immediately, including while the market is offline.
      await refreshPlugins()
      if (cancelled) return
      setLoading(false)
      const status = await shellApi.getMarketStatus(refreshKey > 0)
      if (cancelled) return
      setMarketStatus(status)
      await refreshPlugins()
    })().catch(() => {
      if (!cancelled) setLoadError(true)
    }).finally(() => {
      if (!cancelled) { setLoading(false); setRefreshing(false) }
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
    return ['全部', ...Object.keys(CATEGORY_I18N).filter((key) => categories.has(key)),
      ...Array.from(categories).filter((key) => !CATEGORY_I18N[key])]
  }, [plugins])

  const list = useMemo(() => {
    const q = normalizeSearchText(query)
    return plugins.filter((p) => {
      if (seg === 'installed' && !p.installed) return false
      if (category !== '全部' && (p.category || '其它') !== category) return false
      return !q || matchesSearchTerms(`${p.name} ${p.description} ${p.id} ${p.author} ${p.tags?.join(' ') ?? ''}`, q)
    })
  }, [plugins, query, category, seg])

  const categoryGroups = useMemo(() => categoryKeys.slice(1)
    .map((key) => ({ key, plugins: list.filter((plugin) => (plugin.category || '其它') === key) }))
    .filter((group) => group.plugins.length > 0), [categoryKeys, list])

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

  // Only repository-declared recommendations are promoted; preserve registry order.
  const carouselItems = useMemo(() => plugins.filter((plugin) => plugin.featured === true).slice(0, 5), [plugins])

  const showFeatured = seg === 'browse' && category === '全部' && !query.trim()
  const searching = Boolean(query.trim())
  const detailPlugin = detail ? plugins.find((p) => p.id === detail.id) ?? null : null
  const handleOpen = useCallback((id: string) => { void openPlugin(id) }, [openPlugin])
  useEffect(() => {
    if (detail && !detailPlugin) closeDetail()
  }, [detail, detailPlugin, closeDetail])
  const english = locale === 'en-US'
  const installedCount = plugins.filter((plugin) => plugin.installed).length
  const unavailable = loadError || marketStatus?.state === 'offline'
  const retry = () => setRefreshKey((key) => key + 1)
  const waitingForCatalog = loading || (refreshing && plugins.length === 0)

  return (
    <section className="page page-home" aria-label={t('nav.market')}>
      <div className="home-scroll" ref={scrollRef}>
        <header className="market-page-heading">
          <div>
            <h1>{english ? 'Plugin marketplace' : '插件市场'}</h1>
            <p>{english ? `${plugins.length} plugins · ${installedCount} installed` : `${plugins.length} 个插件 · 已安装 ${installedCount} 个`}</p>
          </div>
          <button
            type="button"
            className="market-refresh"
            onClick={retry}
            disabled={refreshing}
            aria-busy={refreshing}
            title={refreshing ? (english ? 'Refreshing…' : '正在刷新…') : english ? 'Refresh marketplace' : '刷新市场'}
            aria-label={refreshing ? (english ? 'Refreshing marketplace' : '正在刷新插件市场') : english ? 'Refresh marketplace' : '刷新插件市场'}
          >
            <RotateCwIcon size={15} />
          </button>
        </header>
        <HomeSearch value={query} onChange={setQuery} plugins={plugins} onDetail={handleDetail}
          onBrowseAll={() => { setQuery(''); setCategory('全部'); setSeg('browse') }} />

        {marketStatus?.state === 'preview' && <div className="market-source-notice" role="status">
          {english ? 'Browser preview · sample data for UI development only. Open the desktop app for the live marketplace.' : '浏览器预览 · 当前为界面开发示例数据，真实插件市场请在桌面应用中查看。'}
        </div>}

        {!searching && <>
        {showFeatured && carouselItems.length > 0 && (
          <section className="market-featured" aria-label={english ? 'Recommended by the plugin repository' : '插件仓库推荐'}>
          <div className="market-featured-heading"><h2>{english ? 'Featured plugins' : '精选推荐'}</h2><span>{english ? 'From the plugin repository' : '来自插件仓库'}</span></div>
          <FeaturedCarousel items={carouselItems} onOpen={handleOpen} onDetail={handleDetail} paused={detail !== null} continuous={continuous} />
          </section>
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
          <div className="market-category-list" ref={gridRef} aria-busy={waitingForCatalog}>
            {waitingForCatalog ? (
              <div className="market-loading" role="status">
                <span className="market-loading-icon" aria-hidden="true"><i /><i /><i /></span>
                <strong>{english ? 'Preparing the marketplace' : '正在准备插件市场'}</strong>
                <span>{english ? 'Installed and local plugins stay available' : '已安装与本地插件保持可用'}</span>
              </div>
            ) : unavailable && plugins.length === 0 && seg === 'browse' ? (
              <div className="empty">
                <strong>{locale === 'en-US' ? 'Unable to load plugins' : '暂时无法加载插件'}</strong>
                <span>{english ? 'Check your connection, then refresh the marketplace.' : '请检查网络连接后重新加载插件市场。'}</span>
                <button className="btn btn-ghost" type="button" onClick={retry} disabled={refreshing}>
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
            ) : categoryGroups.map((group) => (
              <MarketCategorySection key={`${seg}:${group.key}`} category={categoryLabel(group.key, t)}
                plugins={group.plugins} onOpen={handleOpen} onDetail={handleDetail} />
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
      {detailPlugin && <PluginDetailModal plugin={detailPlugin} origin={detail?.origin} onClose={closeDetail} onInstall={handleOpen} />}
    </section>
  )
}
