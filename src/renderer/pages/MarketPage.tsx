/**
 * MarketPage — 插件市场首页
 * 包含 Hero（统计胶囊/打字机/搜索/分类）、精选轮播、插件卡片网格。
 * 数据来自 shellStore + shellApi.getPlugins；动效见 gsap/marketMotion（playHeroIn / animateCards）。
 * 文案走 useI18n；卡片/轮播点击打开 PluginDetailModal。
 * 依赖：shellStore、useI18n、CATEGORIES(mockData)、StatsPill/SearchBox 等。
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { useShellStore } from '@renderer/stores/shellStore'
import { useI18n } from '@renderer/hooks/useI18n'
import { StatsPill } from '@renderer/components/StatsPill'
import { SearchBox } from '@renderer/components/SearchBox'
import { CategoryChips } from '@renderer/components/CategoryChips'
import { SegmentTabs } from '@renderer/components/SegmentTabs'
import { FeaturedCarousel } from '@renderer/components/FeaturedCarousel'
import { PluginCard } from '@renderer/components/PluginCard'
import { PluginDetailModal } from '@renderer/components/PluginDetailModal'
import { animateCards, playHeroIn } from '@renderer/gsap/marketMotion'

/** 打字机词条：中文 / 英文各一组，随 locale 切换（不含品牌名，避免「发现最佳 eNest」） */
const TYPE_WORDS_ZH = ['插件', '效率工具', '开发利器']
const TYPE_WORDS_EN = ['plugins', 'productivity', 'dev tools']

/** Hero 标题旁的循环打字机文案 */
function Typewriter({ words }: { words: string[] }) {
  const [text, setText] = useState('')
  useEffect(() => {
    let w = 0
    let c = 0
    let deleting = false
    let cancelled = false
    let timer: number

    const tick = () => {
      if (cancelled) return
      const word = words[w % words.length]
      if (!deleting) {
        c += 1
        setText(word.slice(0, c))
        if (c === word.length) {
          timer = window.setTimeout(() => {
            deleting = true
            tick()
          }, 1600)
          return
        }
        timer = window.setTimeout(tick, 120)
      } else {
        c -= 1
        setText(word.slice(0, c))
        if (c === 0) {
          deleting = false
          w += 1
          timer = window.setTimeout(tick, 320)
          return
        }
        timer = window.setTimeout(tick, 55)
      }
    }
    tick()
    return () => {
      cancelled = true
      window.clearTimeout(timer)
    }
  }, [words])
  return <span>{text}</span>
}

/** mock 分类为中文键；显示时按 locale 映射文案，筛选仍用原键 */
const CATEGORY_KEYS = ['全部', '效率', '开发', '设计'] as const

function categoryLabel(key: string, t: (k: string) => string): string {
  const map: Record<string, string> = {
    全部: t('market.all'),
    效率: t('market.catProductivity'),
    开发: t('market.catDev'),
    设计: t('market.catDesign'),
  }
  return map[key] ?? key
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
  const heroPlayed = useRef(false)
  const [detailId, setDetailId] = useState<string | null>(null)

  const typeWords = locale === 'en-US' ? TYPE_WORDS_EN : TYPE_WORDS_ZH

  useEffect(() => {
    void refreshPlugins()
  }, [refreshPlugins])

  useEffect(() => {
    if (heroPlayed.current) return
    heroPlayed.current = true
    playHeroIn(scrollRef.current)
  }, [])

  const list = useMemo(() => {
    const q = query.trim().toLowerCase()
    let items =
      seg === 'installed'
        ? plugins.filter((p) => p.installed)
        : plugins.filter((p) => category === '全部' || p.category === category)
    if (q) {
      items = items.filter(
        (p) =>
          p.name.toLowerCase().includes(q) ||
          p.description.toLowerCase().includes(q) ||
          p.id.includes(q)
      )
    }
    return items
  }, [plugins, query, category, seg])

  const carouselItems = useMemo(() => {
    if (seg === 'installed') return plugins.filter((p) => p.installed)
    return [...plugins]
      .sort((a, b) => parseFloat(b.installs) - parseFloat(a.installs))
      .slice(0, 5)
  }, [plugins, seg])

  useEffect(() => {
    const nodes = gridRef.current?.querySelectorAll('.card')
    if (nodes?.length) animateCards(Array.from(nodes))
  }, [list])

  const gridTitle =
    seg === 'installed'
      ? t('market.installedPlugins')
      : category === '全部'
        ? t('market.official')
        : categoryLabel(category, t)

  const handleOpen = (id: string) => {
    void openPlugin(id)
  }

  const handleDetail = (id: string) => {
    setDetailId(id)
  }

  const detailPlugin = detailId ? plugins.find((p) => p.id === detailId) ?? null : null

  const showAll = () => {
    setSeg('browse')
    setCategory('全部')
    gridRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }

  return (
    <section className="page page-home">
      <div className="dot-grid" aria-hidden="true" />
      <div className="home-scroll" ref={scrollRef}>
        <div className="hero">
          <StatsPill count={plugins.length || 6} />
          <h1>
            {t('market.heroPrefix')}{' '}
            <span className="type-wrap">
              <Typewriter words={typeWords} />
              <span className="caret" aria-hidden="true" />
            </span>
          </h1>
          <p className="lead">{t('market.heroLead')}</p>
          <SearchBox value={query} onChange={setQuery} />
          <CategoryChips
            categories={CATEGORY_KEYS.map((k) => categoryLabel(k, t))}
            value={categoryLabel(category, t)}
            onChange={(label) => {
              const hit = CATEGORY_KEYS.find((k) => categoryLabel(k, t) === label)
              setCategory(hit ?? '全部')
            }}
          />
        </div>

        <div className="home-toolbar">
          <SegmentTabs value={seg} onChange={setSeg} />
          <button className="link-more" type="button" onClick={showAll}>
            {t('market.viewAll')}
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M5 12h14M13 6l6 6-6 6" />
            </svg>
          </button>
        </div>

        {carouselItems.length > 0 && (
          <FeaturedCarousel items={carouselItems} onOpen={handleOpen} onDetail={handleDetail} />
        )}

        <div className="section-head grid-head">
          <h2>{gridTitle}</h2>
          <span className="stars">{t('market.pluginsCount', { n: list.length })}</span>
        </div>
        <div className="grid" ref={gridRef}>
          {list.length === 0 ? (
            <div className="empty">
              <strong>{seg === 'installed' ? t('market.emptyInstalled') : t('market.emptySearch')}</strong>
              <span>{t('market.emptyHint')}</span>
            </div>
          ) : (
            list.map((p) => (
              <PluginCard key={p.id} plugin={p} onOpen={handleOpen} onDetail={handleDetail} />
            ))
          )}
        </div>
      </div>

      {detailPlugin && (
        <PluginDetailModal
          plugin={detailPlugin}
          onClose={() => setDetailId(null)}
          onInstall={handleOpen}
        />
      )}
    </section>
  )
}
