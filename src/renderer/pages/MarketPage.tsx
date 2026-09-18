/**
 * MarketPage — 插件市场首页
 * 包含 Hero（统计胶囊/打字机/搜索/分类）、精选轮播、插件卡片网格。
 * 数据来自 shellStore + shellApi.getPlugins；动效见 gsap/marketMotion（playHeroIn / animateCards）。
 * 文案走 useI18n；已安装点卡片直接打开插件，未安装点卡片/「安装」打开详情。
 * 依赖：shellStore、useI18n、StatsPill/SearchBox 等。
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
import { ArrowRightIcon } from '@renderer/components/icons'
import { animateCards, playHeroIn } from '@renderer/gsap/marketMotion'
import { useAnimationLevelStore } from '@renderer/hooks/useAnimationLevel'
import type { HomeCardContribution } from '@shared/types/plugin'

/** 打字机词条：中文 / 英文各一组，随 locale 切换（不含品牌名，避免「发现最佳 eNest」） */
const TYPE_WORDS_ZH = ['插件', '效率工具', '开发利器']
const TYPE_WORDS_EN = ['plugins', 'productivity', 'dev tools']

/** Hero 标题旁的循环打字机文案；按动画档位调速（low 静态首词，不循环删除）；页面隐藏时暂停 */
function Typewriter({ words }: { words: string[] }) {
  const level = useAnimationLevelStore((s) => s.level)
  const [text, setText] = useState(() => (level === 'low' ? (words[0] ?? '') : ''))

  useEffect(() => {
    if (level === 'low') {
      setText(words[0] ?? '')
      return
    }
    // medium：既有节奏；high：略快
    const typeMs = level === 'high' ? 95 : 120
    const deleteMs = level === 'high' ? 42 : 55
    const holdMs = level === 'high' ? 1200 : 1600
    const gapMs = level === 'high' ? 240 : 320

    let w = 0
    let c = 0
    let deleting = false
    let cancelled = false
    let timer: number
    /** 页面隐藏时暂停调度（后台标签 Electron 仍会跑 setTimeout，浪费且回来跳词） */
    let paused = false

    const tick = () => {
      if (cancelled) return
      if (paused) return
      const word = words[w % words.length]
      if (!deleting) {
        c += 1
        setText(word.slice(0, c))
        if (c === word.length) {
          timer = window.setTimeout(() => {
            deleting = true
            tick()
          }, holdMs)
          return
        }
        timer = window.setTimeout(tick, typeMs)
      } else {
        c -= 1
        setText(word.slice(0, c))
        if (c === 0) {
          deleting = false
          w += 1
          timer = window.setTimeout(tick, gapMs)
          return
        }
        timer = window.setTimeout(tick, deleteMs)
      }
    }

    const onVisibility = () => {
      if (document.hidden) {
        paused = true
        window.clearTimeout(timer)
      } else if (paused) {
        paused = false
        tick()
      }
    }

    tick()
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      cancelled = true
      paused = true
      window.clearTimeout(timer)
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }, [words, level])
  return <span>{text}</span>
}

/** 已知分类 → i18n key；仓库里出现的未知分类原样展示 */
const CATEGORY_I18N: Record<string, string> = {
  效率: 'market.catProductivity',
  开发: 'market.catDev',
  设计: 'market.catDesign',
  媒体: 'market.catMedia',
  其它: 'market.catOther',
}

function categoryLabel(key: string, t: (k: string) => string): string {
  if (key === '全部') return t('market.all')
  const i18nKey = CATEGORY_I18N[key]
  return i18nKey ? t(i18nKey) : key
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

  /** 分类 chips：始终含「全部」+ 当前插件仓库里实际出现的分类 */
  const categoryKeys = useMemo(() => {
    const seen = new Set<string>()
    for (const p of plugins) {
      if (p.category) seen.add(p.category)
    }
    return ['全部', ...Array.from(seen)]
  }, [plugins])

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

  // 当前选中分类已不在仓库中时回退「全部」
  useEffect(() => {
    if (category !== '全部' && !categoryKeys.includes(category)) {
      setCategory('全部')
    }
  }, [category, categoryKeys, setCategory])

  /** 首页「插件扩展」卡片：来自已安装插件 manifest.contributes.homeCards（声明式，无需插件运行） */
  const homeCards = useMemo(() => {
    const out: Array<HomeCardContribution & { pluginId: string; pluginName: string; fallbackColor: string }> = []
    for (const p of plugins) {
      if (!p.installed || p.enabled === false) continue
      const cards = p.contributes?.homeCards
      if (!Array.isArray(cards)) continue
      for (const card of cards) {
        if (!card || typeof card !== 'object' || !card.title) continue
        out.push({
          ...card,
          id: card.id || `${p.id}:card`,
          pluginId: p.id,
          pluginName: p.name,
          fallbackColor: p.color || '#5b8cff'
        })
      }
    }
    return out
  }, [plugins])

  const handleOpenCard = (card: { pluginId: string; openCode?: string }) => {
    // openCode 透传给插件 onEnter（contributes.homeCards.openCode）
    void openPlugin(card.pluginId, card.openCode ? { code: card.openCode } : undefined)
  }

  // 精选 coverflow 只在浏览段展示；「已安装」不渲染 FeaturedCarousel
  const carouselItems = useMemo(() => {
    if (seg === 'installed') return []
    return [...plugins]
      .sort((a, b) => parseFloat(b.installs) - parseFloat(a.installs))
      .slice(0, 5)
  }, [plugins, seg])

  // 卡片 stagger 入场：只在首次挂载播放一次；query/分类等筛选变化时列表直接更新不重播
  // （此前依赖 [list]，搜索框每敲一个字符整网格卡片重播 GSAP stagger，造成明显卡顿）
  const cardsPlayedRef = useRef(false)
  useEffect(() => {
    if (cardsPlayedRef.current) return
    const nodes = gridRef.current?.querySelectorAll('.card')
    if (!nodes?.length) return
    cardsPlayedRef.current = true
    animateCards(Array.from(nodes))
  }, [list])

  const gridTitle =
    seg === 'installed'
      ? t('market.installedPlugins')
      : category === '全部'
        ? t('market.official')
        : categoryLabel(category, t)

  /** 浏览「全部」时按分类分组展示，便于按类别扫一眼 */
  const categoryGroups = useMemo(() => {
    if (seg === 'installed' || category !== '全部') return null
    const map = new Map<string, typeof list>()
    for (const p of list) {
      const key = p.category || '其它'
      const arr = map.get(key)
      if (arr) arr.push(p)
      else map.set(key, [p])
    }
    // 保持 chips 顺序
    const ordered: Array<{ category: string; items: typeof list }> = []
    for (const key of categoryKeys) {
      if (key === '全部') continue
      const items = map.get(key)
      if (items?.length) ordered.push({ category: key, items })
    }
    for (const [key, items] of map) {
      if (!categoryKeys.includes(key)) ordered.push({ category: key, items })
    }
    return ordered.length > 1 ? ordered : null
  }, [list, category, seg, categoryKeys])

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
            categories={categoryKeys.map((k) => categoryLabel(k, t))}
            value={categoryLabel(category, t)}
            onChange={(label) => {
              const hit = categoryKeys.find((k) => categoryLabel(k, t) === label)
              setCategory(hit ?? '全部')
            }}
          />
        </div>

        <div className="home-toolbar">
          <SegmentTabs value={seg} onChange={setSeg} />
          <button className="link-more" type="button" onClick={showAll}>
            {t('market.viewAll')}
            <ArrowRightIcon size={14} />
          </button>
        </div>

        {seg !== 'installed' && carouselItems.length > 0 && (
          <FeaturedCarousel items={carouselItems} onOpen={handleOpen} onDetail={handleDetail} />
        )}

        {homeCards.length > 0 && (
          <div className="section-head contrib-head">
            <h2>{locale === 'en-US' ? 'Plugin Extensions' : '插件扩展'}</h2>
            <span className="section-count">
              {t('market.pluginsCount', { n: homeCards.length })}
            </span>
          </div>
        )}
        {homeCards.length > 0 && (
          <div className="grid contrib-grid">
            {homeCards.map((card) => (
              <button
                key={`${card.pluginId}:${card.id}`}
                type="button"
                className="card contrib-card"
                onClick={() => handleOpenCard(card)}
                title={card.explain || card.pluginName}
              >
                <span
                  className="contrib-glyph"
                  style={{ background: card.color || card.fallbackColor }}
                  aria-hidden
                >
                  {(card.glyph || card.title.slice(0, 1)).slice(0, 1).toUpperCase()}
                </span>
                <span className="contrib-body">
                  <strong className="contrib-title">{card.title}</strong>
                  {card.explain ? <span className="contrib-explain">{card.explain}</span> : null}
                  <span className="contrib-source">{card.pluginName}</span>
                </span>
              </button>
            ))}
          </div>
        )}

        {categoryGroups ? (
          categoryGroups.map((group) => (
            <div key={group.category} className="category-group">
              <div className="section-head grid-head">
                <h2>{categoryLabel(group.category, t)}</h2>
                <span className="section-count">
                  {t('market.pluginsCount', { n: group.items.length })}
                </span>
              </div>
              <div className="grid">
                {group.items.map((p) => (
                  <PluginCard key={p.id} plugin={p} onOpen={handleOpen} onDetail={handleDetail} />
                ))}
              </div>
            </div>
          ))
        ) : (
          <>
            <div className="section-head grid-head">
              <h2>{gridTitle}</h2>
              <span className="section-count">{t('market.pluginsCount', { n: list.length })}</span>
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
          </>
        )}
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
