/**
 * MarketPage — 插件市场首页
 * 包含 Hero（统计胶囊/打字机/搜索/分类）、精选轮播、插件卡片网格。
 * 数据来自 shellStore + shellApi.getPlugins；动效见 gsap/marketMotion（playHeroIn / animateCards）。
 * 卡片/轮播点击打开 PluginDetailModal，操作按钮安装/打开。
 * 依赖：shellStore、CATEGORIES(mockData)、StatsPill/SearchBox/CategoryChips/SegmentTabs/FeaturedCarousel/PluginCard/PluginDetailModal。
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { CATEGORIES } from '../services/mockData'
import { useShellStore } from '../stores/shellStore'
import { StatsPill } from '../components/StatsPill'
import { SearchBox } from '../components/SearchBox'
import { CategoryChips } from '../components/CategoryChips'
import { SegmentTabs } from '../components/SegmentTabs'
import { FeaturedCarousel } from '../components/FeaturedCarousel'
import { PluginCard } from '../components/PluginCard'
import { PluginDetailModal } from '../components/PluginDetailModal'
import { animateCards, playHeroIn } from '../gsap/marketMotion'

const TYPE_WORDS = ['插件', '效率工具', '开发利器', 'eNest']

/** Hero 标题旁的循环打字机文案（插件 / 效率工具 / 开发利器 / eNest） */
function Typewriter() {
  const [text, setText] = useState('')
  useEffect(() => {
    let w = 0
    let c = 0
    let deleting = false
    let cancelled = false
    let timer: number

    const tick = () => {
      if (cancelled) return
      const word = TYPE_WORDS[w % TYPE_WORDS.length]
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
  }, [])
  return <span>{text}</span>
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
  const scrollRef = useRef<HTMLDivElement>(null)
  const gridRef = useRef<HTMLDivElement>(null)
  const heroPlayed = useRef(false)
  /** 当前打开详情的插件 id（始终从 plugins 取最新 installed 状态） */
  const [detailId, setDetailId] = useState<string | null>(null)

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

  const gridTitle = seg === 'installed' ? '已安装插件' : category === '全部' ? '官方插件' : category

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
            发现最佳{' '}
            <span className="type-wrap">
              <Typewriter />
              <span className="caret" aria-hidden="true" />
            </span>
          </h1>
          <p className="lead">精选桌面效率与开发工具目录。安装后以独立进程运行，多 Tab 并行，关闭即回收。</p>
          <SearchBox value={query} onChange={setQuery} />
          <CategoryChips categories={CATEGORIES} value={category} onChange={setCategory} />
        </div>

        <div className="home-toolbar">
          <SegmentTabs value={seg} onChange={setSeg} />
          <button className="link-more" type="button" onClick={showAll}>
            查看全部插件
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
          <span className="stars">{list.length} 个</span>
        </div>
        <div className="grid" ref={gridRef}>
          {list.length === 0 ? (
            <div className="empty">
              <strong>{seg === 'installed' ? '还没有安装插件' : '没有找到插件'}</strong>
              <span>试试其他分类或关键词</span>
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
