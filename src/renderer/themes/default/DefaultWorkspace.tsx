import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import gsap from 'gsap'
import type { HomeCatalogItem, HomeDetail } from '@shared/types/home'
import type { PluginPresentation } from '@renderer/components/pluginPresentation'
import { useI18n } from '@renderer/hooks/useI18n'
import { CategoryChips } from '@renderer/components/CategoryChips'
import { SegmentTabs } from '@renderer/components/SegmentTabs'
import { FeaturedCarousel } from '@renderer/components/FeaturedCarousel'
import { MarketCategoryView } from '@renderer/components/MarketCategoryView'
import { PluginCardView } from '@renderer/components/PluginCardView'
import { PluginDetailView } from '@renderer/components/PluginDetailView'
import { usePluginDetailMotion } from '@renderer/components/usePluginDetailMotion'
import { RotateCwIcon } from '@renderer/components/icons'
import { animateCards, playHeroIn } from '@renderer/gsap/marketMotion'
import { DefaultThemeBackground } from './DefaultThemeBackground'
import { DefaultWorkspaceSearch } from './DefaultWorkspaceSearch'
import type { DefaultWorkspaceController, DefaultWorkspaceState } from './WorkspaceController'
import './defaultWorkspace.css'

const CATEGORY_I18N: Record<string, string> = {
  效率: 'market.catProductivity', 开发: 'market.catDev', 设计: 'market.catDesign',
  媒体: 'market.catMedia', 其它: 'market.catOther',
}

/** Build a presentation model from explicitly public slots, never spread host plugin records. */
export function workspacePluginPresentation(item: HomeCatalogItem | HomeDetail): PluginPresentation {
  return {
    id: item.pluginId, name: item.name, description: item.description ?? '', version: item.version ?? '',
    author: item.author ?? '', category: item.category || '其它', installs: String(item.installs ?? ''),
    color: item.color ?? '', glyph: item.glyph || Array.from(item.name)[0] || '', icon: item.icon || undefined,
    installed: Boolean(item.installed), enabled: item.enabled !== false, tags: item.tags,
    latestVersion: item.latestVersion, packageSize: item.packageSize, screenshots: item.screenshots,
    featured: 'featured' in item ? item.featured : undefined,
    permissions: 'permissions' in item ? item.permissions ?? [] : [],
    readmeUrl: 'readmeUrl' in item ? item.readmeUrl : undefined,
    readmeImages: 'readmeImages' in item ? item.readmeImages : undefined,
  }
}

function DefaultWorkspaceDetail({ state, controller, origin }: {
  state: DefaultWorkspaceState; controller: DefaultWorkspaceController; origin: HTMLElement | null
}) {
  const detail = state.detail!
  const plugin = useMemo(() => workspacePluginPresentation(detail), [detail])
  const rootRef = useRef<HTMLDivElement>(null)
  // Closing detail returns to the host's catalog route; the provider keeps its own
  // marketplace/installed segment in local state, so the visible list is unchanged.
  const close = useCallback(() => { void controller.navigate({ page: 'catalog' }) }, [controller])
  const requestClose = usePluginDetailMotion(rootRef, plugin.id, origin, close)
  const { t, locale } = useI18n()
  const english = locale === 'en-US'
  const [actionError, setActionError] = useState<string>()
  const [operation, setOperation] = useState<string>()
  const busy = state.busy.has(plugin.id) || Boolean(operation)
  const disabled = plugin.installed && plugin.enabled === false
  const perform = async (type: 'installPlugin' | 'updatePlugin' | 'uninstallPlugin' | 'setPluginEnabled') => {
    if (busy) return
    setOperation(type)
    setActionError(undefined)
    try {
      await controller.manage(type === 'setPluginEnabled'
        ? { type, pluginId: plugin.id, enabled: disabled }
        : { type, pluginId: plugin.id }, plugin.id)
      if (type !== 'setPluginEnabled') requestClose()
    } catch (error) { setActionError(error instanceof Error ? error.message : english ? 'Action failed. Please retry.' : '操作失败，请重试。') }
    finally { setOperation(undefined) }
  }
  const primary = async () => {
    if (!plugin.installed) { await perform('installPlugin'); return }
    try { await controller.action({ type: 'openPlugin', pluginId: plugin.id }) }
    catch (error) { setActionError(error instanceof Error ? error.message : english ? 'Unable to open this plugin.' : '暂时无法打开插件。') }
  }
  return <PluginDetailView plugin={plugin} rootRef={rootRef} requestClose={requestClose}
    status={state.detailReadme?.status ?? 'loading'} readme={state.detailReadme?.text ?? ''}
    busy={busy} disabled={disabled} actionError={actionError}
    installing={operation === 'installPlugin' || operation === 'updatePlugin'}
    uninstalling={operation === 'uninstallPlugin'} toggling={operation === 'setPluginEnabled'}
    actionLabel={operation === 'installPlugin' ? t('plugin.installing') : plugin.installed ? t('plugin.open') : t('plugin.install')}
    handlePrimary={primary} handleUpdate={() => perform('updatePlugin')}
    handleToggleEnabled={() => perform('setPluginEnabled')} handleUninstall={() => perform('uninstallPlugin')}
    disableReadmeLinks launchControls={plugin.installed && <section className="detail-launch" aria-label={english ? 'Quick launch' : '快捷启动'}>
      <div className="detail-launch-head"><h3>{english ? 'Quick launch' : '快捷启动'}</h3><span className="detail-launch-hint">{english ? 'Shortcut bindings and launch preferences are managed by eNest.' : '快捷键绑定与启动偏好由 eNest 宿主设置面板管理。'}</span></div>
      <div className="detail-launch-row"><button type="button" className="btn btn-ghost" onClick={() => void controller.action({ type: 'openSettings' }).catch(controller.reportError)}>{english ? 'Open settings' : '前往系统设置'}</button></div>
    </section>} />
}

/** Marketplace presentation owned by the compiled default theme package. */
export function DefaultWorkspace({ controller }: { controller: DefaultWorkspaceController }) {
  const state = useSyncExternalStore(controller.subscribe, controller.getState, controller.getState)
  const { t, locale } = useI18n()
  const english = locale === 'en-US'
  const scrollRef = useRef<HTMLDivElement>(null)
  const gridRef = useRef<HTMLDivElement>(null)
  const originRef = useRef<HTMLElement | null>(null)
  const previousSeg = useRef<'browse' | 'installed' | null>(null)
  const plugins = useMemo(() => state.catalog?.items.map(workspacePluginPresentation) ?? [], [state.catalog])
  const seg = state.basePage === 'installed' ? 'installed' : 'browse'
  const searching = Boolean(state.query.trim())
  const showFeatured = seg === 'browse' && state.category === '全部' && !searching
  const categoryKeys = useMemo(() => {
    const keys = new Set(plugins.map(plugin => plugin.category))
    return ['全部', ...Object.keys(CATEGORY_I18N).filter(key => keys.has(key)), ...Array.from(keys).filter(key => !CATEGORY_I18N[key])]
  }, [plugins])
  const list = useMemo(() => plugins.filter(plugin =>
    (seg !== 'installed' || plugin.installed) && (state.category === '全部' || plugin.category === state.category)), [plugins, seg, state.category])
  const groups = useMemo(() => categoryKeys.slice(1).map(key => ({ key, plugins: list.filter(plugin => plugin.category === key) })).filter(group => group.plugins.length), [categoryKeys, list])
  const label = (key: string) => key === '全部' ? t('market.all') : CATEGORY_I18N[key] ? t(CATEGORY_I18N[key]) : key
  const carouselItems = useMemo(() => plugins.filter(plugin => plugin.featured).slice(0, 5), [plugins])
  const installedCount = plugins.filter(plugin => plugin.installed).length
  const detailOpen = state.route.page === 'detail'
  const detail = detailOpen ? state.detail : undefined
  const handleOpen = useCallback((pluginId: string) => { void controller.action({ type: 'openPlugin', pluginId }).catch(controller.reportError) }, [controller])
  const handleDetail = useCallback((pluginId: string, origin?: HTMLElement | null) => {
    originRef.current = origin ?? null
    void controller.navigate({ page: 'detail', pluginId })
  }, [controller])

  useEffect(() => {
    if (!categoryKeys.includes(state.category)) controller.setCategory('全部')
  }, [categoryKeys, controller, state.category])
  useEffect(() => {
    // Segment switches keep the same surface; only the list below changes, so reset its scroll.
    // The first run records the initial segment so the entrance choreography keeps its own scroll.
    const previous = previousSeg.current
    previousSeg.current = seg
    if (previous === null || previous === seg) return
    scrollRef.current?.scrollTo({ top: 0, behavior: 'auto' })
  }, [seg])
  useEffect(() => {
    if (state.loading || !state.appearance) return
    const context = gsap.context(() => playHeroIn(scrollRef.current), scrollRef)
    return () => context.revert()
  }, [state.loading, Boolean(state.appearance)])
  useEffect(() => {
    if (state.loading) return
    const context = gsap.context(() => {
      const nodes = gridRef.current?.querySelectorAll('[data-plugin-card]')
      if (nodes?.length) animateCards(Array.from(nodes))
    }, gridRef)
    return () => context.revert()
  }, [state.loading])

  if (!state.appearance) return state.loading ? null : <div className="default-workspace-boot"><strong>{english ? 'Workspace is unavailable' : '工作区暂时无法启动'}</strong><p role="alert">{state.message}</p></div>
  return <div className={`default-workspace${state.appearance.appearance.layout.tabStyle === 'orb' ? ' tab-orb' : ''}`} data-workspace-route={state.route.page}>
    <DefaultThemeBackground appearance={state.appearance.appearance} paused={!state.visible} />
    <section className="page page-home" aria-label={t('nav.market')}>
      <div className="home-scroll" ref={scrollRef}>
        <header className="market-page-heading"><div><h1>{english ? 'Plugin marketplace' : '插件市场'}</h1><p>{english ? `${plugins.length} plugins · ${installedCount} installed` : `${plugins.length} 个插件 · 已安装 ${installedCount} 个`}</p></div>
          <button type="button" className="market-refresh" onClick={() => void controller.refreshCatalog()} disabled={state.refreshing} aria-busy={state.refreshing} title={state.refreshing ? english ? 'Refreshing…' : '正在刷新…' : english ? 'Refresh marketplace' : '刷新市场'} aria-label={english ? 'Refresh marketplace' : '刷新插件市场'}><RotateCwIcon size={15} /></button>
        </header>
        <DefaultWorkspaceSearch state={state} controller={controller} onDetailOrigin={origin => { originRef.current = origin }} />
        {state.message && <div className="market-source-notice default-workspace-notice" role="status"><span>{state.message}</span><button type="button" className="btn btn-ghost btn-sm" onClick={controller.dismissMessage}>{english ? 'Dismiss' : '关闭提示'}</button></div>}
        {!searching && <>
          {showFeatured && carouselItems.length > 0 && <section className="market-featured" aria-label={english ? 'Recommended by the plugin repository' : '插件仓库推荐'}><div className="market-featured-heading"><h2>{english ? 'Featured plugins' : '精选推荐'}</h2><span>{english ? 'From the plugin repository' : '来自插件仓库'}</span></div><FeaturedCarousel items={carouselItems} onOpen={handleOpen} onDetail={handleDetail} paused={detailOpen || !state.visible} /></section>}
          <div className="home-toolbar"><SegmentTabs value={seg} onChange={value => controller.setBasePage(value === 'installed' ? 'installed' : 'catalog')} /><CategoryChips categories={categoryKeys.map(label)} value={label(state.category)} onChange={value => controller.setCategory(categoryKeys.find(key => label(key) === value) ?? '全部')} /></div>
          <section className="market-catalog" aria-label={seg === 'installed' ? t('market.installedPlugins') : t('market.browse')}>
            <div className="sr-only" aria-live="polite">{t('market.pluginsCount', { n: list.length })}</div>
            <div className="market-category-list" ref={gridRef} aria-busy={state.loading}>
              {state.loading ? <div className="market-loading" role="status"><span className="market-loading-icon" aria-hidden="true"><i /><i /><i /></span><strong>{english ? 'Preparing the marketplace' : '正在准备插件市场'}</strong><span>{english ? 'Installed and local plugins stay available' : '已安装与本地插件保持可用'}</span></div>
                : list.length === 0 ? <div className="empty"><strong>{seg === 'installed' && state.category === '全部' ? t('market.emptyInstalled') : t('market.emptySearch')}</strong><span>{t('market.emptyHint')}</span><button className="btn btn-ghost" type="button" onClick={() => { controller.setCategory('全部'); controller.setBasePage('catalog') }}>{t('market.viewAll')}</button></div>
                  : groups.map(group => <MarketCategoryView key={group.key} category={label(group.key)} plugins={group.plugins} renderPlugin={plugin => <PluginCardView plugin={plugin} onOpen={handleOpen} onDetail={handleDetail}
                    onUninstall={pluginId => controller.manage({ type: 'uninstallPlugin', pluginId }, pluginId)} onSetEnabled={(pluginId, enabled) => controller.manage({ type: 'setPluginEnabled', pluginId, enabled }, pluginId)} />} />)}
            </div>
          </section>
        </>}
      </div>
      {detail && <DefaultWorkspaceDetail key={detail.pluginId} state={state} controller={controller} origin={originRef.current} />}
    </section>
  </div>
}
