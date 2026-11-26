/**
 * orb-overlay — 左侧圆轨（主窗口内顶层 WebContentsView）
 * ?part=rail：首页、插件与末尾设置共用圆轨，mouseenter 展开 / mouseleave 延迟收起；
 * ?part=dock：仅经典模式显示的左下角头像设置入口。
 * 动画档位 / 主题：URL query 首帧 + orb-state 载荷（主进程 settingsStore 为唯一事实来源）
 * 同步到 root[data-anim] / root[data-theme] + token 变量；CSS 动效与配色按档位、主题缩放。
 */
import type { AnimationLevel } from '@shared/types/plugin'
import type { ThemeChromeSnapshot as OrbState } from '@shared/types/themeChrome'
import { LUCIDE_PATHS, lucideSvgMarkup } from '@renderer/icons.paths'
import { applyLevelToDefaults } from '@renderer/gsap/marketMotion'
import { applyAppearanceToDom } from '@renderer/services/appearanceDom'
import '@renderer/styles/appearance.css'
import { bindPluginDragSource, bindPluginDropTarget } from '@renderer/services/pluginWindowDrag'
import { createDefaultChromeApi } from './api'
import './orb.css'
import '@renderer/styles/plugin-window-drag.css'

type Part = 'rail' | 'dock'
type ThemeInfo = OrbState['theme']

const PART: Part = new URLSearchParams(window.location.search).get('part') === 'dock' ? 'dock' : 'rail'

/** 鼠标离开后收起缓冲（hover intent），不随动画档位缩放 */
const COLLAPSE_DELAY_MS = 260
/**
 * 收起 CSS 动画播完后再缩窄原生视图：视图缩窄是不可动画的硬切换，早于过渡结束
 * 就会把还在淡出的圆球直接切掉，看起来像"突然收回"。
 * 时长从元素实际 computed style 读取，避免按档位硬编码落后于 CSS 改动。
 */
function narrowDelayMs(): number {
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return 0
  const nodes = [document.getElementById('orb-panel'), document.querySelector('.orb-item')]
  let longest = 0
  for (const node of nodes) {
    if (!(node instanceof HTMLElement)) continue
    const style = getComputedStyle(node)
    const durations = style.transitionDuration.split(',').map(parseFloat)
    const delays = style.transitionDelay.split(',').map(parseFloat)
    const count = Math.max(durations.length, delays.length)
    for (let i = 0; i < count; i++) {
      const total = (durations[i % durations.length] || 0) + (delays[i % delays.length] || 0)
      if (total > longest) longest = total
    }
  }
  // 40ms 缓冲覆盖一帧合成与 setBounds 的往返。
  return longest ? Math.round(longest * 1000) + 40 : 320
}
/** 展开错落 delay 基准：40 + i * 38（medium） */
const STAGGER_BASE_MS = 40
const STAGGER_STEP_MS = 38

function isAnimLevel(v: unknown): v is AnimationLevel {
  return v === 'low' || v === 'medium' || v === 'high'
}

function currentAnimLevel(): AnimationLevel {
  const v = document.documentElement.dataset.anim
  return isAnimLevel(v) ? v : 'medium'
}

function applyAnimLevel(level: AnimationLevel): void {
  applyLevelToDefaults(level)
  if (document.documentElement.dataset.anim !== level) {
    document.documentElement.dataset.anim = level
  }
}

/** 启动时用 URL query 立刻套档，避免首帧 medium 弹簧 */
function readUrlAnim(): AnimationLevel | null {
  try {
    const q = new URLSearchParams(window.location.search).get('anim')
    return isAnimLevel(q) ? q : null
  } catch {
    return null
  }
}

/** 应用主题：data-theme 切配色档，token 变量供 CSS 取色（与主壳/插件同源） */
function applyTheme(theme: ThemeInfo): void {
  const root = document.documentElement
  const mode = theme?.mode === 'dark' ? 'dark' : 'light'
  if (root.dataset.theme !== mode) root.dataset.theme = mode
  for (const [key, value] of Object.entries(theme?.tokens ?? {})) {
    if (key.startsWith('--') && value) root.style.setProperty(key, value)
  }
  if (theme.appearance) applyAppearanceToDom(theme.appearance)
  // Shared appearance applies color-scheme to full pages; transparent native chrome
  // must retain a transparent Chromium canvas instead of painting a light/dark tile.
  root.style.colorScheme = 'normal'
  applyOrbDock(theme.appearance?.layout.orbDock === 'right' ? 'right' : 'left')
}

/**
 * 停靠边镜像：原生视图本身已由主进程移到另一侧，这里只负责把轨道内部的
 * 方向（把手贴哪边、展开方向、悬停位移、面板对齐）翻过来。
 * 写在 documentElement 的 data-orb-dock 上（与 data-theme/data-anim 同级），
 * CSS 用属性选择器翻转，避免在 JS 里算像素。
 */
function applyOrbDock(dock: 'left' | 'right'): void {
  const el = document.documentElement
  if (el.dataset.orbDock !== dock) el.dataset.orbDock = dock
}

/** 启动时用 URL query 立刻套停靠边，避免首帧贴在错误一侧 */
function readUrlDock(): 'left' | 'right' | null {
  try {
    const q = new URLSearchParams(window.location.search).get('dock')
    return q === 'right' || q === 'left' ? q : null
  } catch {
    return null
  }
}

/** 启动时用 URL query 立刻套主题档，避免首帧浅色闪变（完整 tokens 随状态载荷到达） */
function readUrlTheme(): 'light' | 'dark' | null {
  try {
    const q = new URLSearchParams(window.location.search).get('theme')
    return q === 'dark' || q === 'light' ? q : null
  } catch {
    return null
  }
}

/** 展开 item 错落 delay：low 归零，high 略拉长 */
function itemStaggerMs(index: number): number {
  const lv = currentAnimLevel()
  if (lv === 'low') return 0
  const base = STAGGER_BASE_MS + Math.min(index, 5) * STAGGER_STEP_MS
  return lv === 'high' ? Math.round(base * 1.2) : base
}

// captionClose：宿主看门狗在光标离开轨道后主动收回拓宽并通知这里，
// 避免视图变大导致 pointerout 未触发时浮层残留。
const chrome = createDefaultChromeApi(PART, {
  isCurrent: () => !disposed,
  captionClose: () => { hideCaption() }
})
const rootEl = document.getElementById('orb-root')
if (!rootEl) throw new Error('#orb-root missing')
const root: HTMLElement = rootEl

let state: OrbState = {
  version: 1,
  surface: PART,
  view: 'home',
  tabStyle: 'orb',
  activeTabId: null,
  animationLevel: 'medium',
  theme: { mode: 'light', tokens: {} },
  profile: null,
  tabs: [],
  contribEntries: []
}
let expanded = false
let closeTimer: number | null = null
let narrowTimer: number | null = null
let focusExitTimer: number | null = null
let pointerFrame = 0
let pointerLayoutChanged = false
const closingTabs = new Map<string, { acknowledged: boolean }>()
let pointerCloseTarget: HTMLElement | null = null
let closeShiftY = 0
/** 展开后「滚到激活项」的两帧句柄：收起时要取消，避免对已收起的面板做滚动 */
let expandFrame = 0
/**
 * 最近一次已知的指针视口坐标。
 *
 * 浏览器不会因为 DOM 变化重算 :hover，关闭一个条目后新落到指针下的条目
 * 收不到 hover，× 按钮不显示，用户必须抖一下鼠标才能继续关。
 */
let lastPointer: { x: number; y: number; width: number } | null = null
/**
 * 当前挂着 `is-pointer-over` 的条目。
 * 用**元素身份**而不是索引跟踪：关闭条目后列表重排，指针下可能是全新元素，
 * 索引却与上次相同——只比索引会把标记留在已被移除的旧节点上。
 */
let pointerOverItem: HTMLElement | null = null
/** 上一次的激活目标（插件 id / home / settings）：用于判断激活项是否真的换了 */
let lastActiveKey = ''
let pointerWithinChrome = false
let dragActive = false
let dropTarget: ReturnType<typeof bindPluginDropTarget> | null = null
const dragDisposers: Array<() => void> = []
const eventDisposers: Array<() => void> = []
let offOrbEvent: (() => void) | undefined
let avatarVersion = 0
let avatarKey: string | undefined
let avatarLoader: HTMLImageElement | null = null
let disposed = false
let readyRequested = false

function cancelClose(): void {
  if (closeTimer != null) {
    window.clearTimeout(closeTimer)
    closeTimer = null
  }
}

function panelHasFocus(): boolean {
  return document.hasFocus() && Boolean(document.getElementById('orb-panel')?.contains(document.activeElement))
}

function scheduleClose(): void {
  if (disposed || dragActive || pointerWithinChrome || panelHasFocus() || closeTimer != null) return
  closeTimer = window.setTimeout(() => {
    closeTimer = null
    if (dragActive || pointerWithinChrome || panelHasFocus()) return
    setExpanded(false)
  }, COLLAPSE_DELAY_MS)
}

function cancelNarrow(): void {
  if (narrowTimer != null) {
    window.clearTimeout(narrowTimer)
    narrowTimer = null
  }
}

function applyExpanded(reveal = false): void {
  const panel = document.getElementById('orb-panel')
  const handle = document.getElementById('orb-handle')
  // Return local focus before inert, without stealing it back from another native surface.
  if (!expanded && panelHasFocus()) handle?.focus({ preventScroll: true })
  // 收起时取消待执行的「滚到激活项」，避免对已收起的面板做滚动。
  if (!expanded && expandFrame) { cancelAnimationFrame(expandFrame); expandFrame = 0 }
  handle?.setAttribute('aria-expanded', String(expanded))
  if (handle) handle.tabIndex = expanded ? -1 : 0
  panel?.toggleAttribute('inert', !expanded)
  panel?.setAttribute('aria-hidden', String(!expanded))
  root.classList.toggle('expanded', expanded)
  // 入列错落；收起不加 delay，整列一起退更跟手
  root.querySelectorAll<HTMLElement>('.orb-item').forEach((el, i) => {
    el.style.transitionDelay = expanded && !dragActive ? `${itemStaggerMs(i)}ms` : '0ms'
  })
  // 展开后条目尺寸才可测量，景深按真实位置重算一次；
  // 同时把当前激活插件滚进视野——条目多时面板只显示一屏，
  // 不定位就会出现「展开后看不到自己正在用哪个插件」。
  if (expanded && reveal) {
    // 两帧：一帧给 CSS 过渡起步、一帧给布局稳定，之后 measure 才拿到真实高度。
    // expandFrame 记录句柄，收起时取消，避免快速开合时对已收起的面板做滚动。
    if (expandFrame) cancelAnimationFrame(expandFrame)
    expandFrame = requestAnimationFrame(() => {
      expandFrame = requestAnimationFrame(() => {
        expandFrame = 0
        if (!expanded || disposed) return
        if (!pointerOverItem && !pointerCloseTarget) revealActiveItem()
        scheduleDepthSync()
      })
    })
  }
}

function setExpanded(v: boolean): void {
  if (disposed || !v && dragActive) return
  if (expanded === v) return
  expanded = v
  if (v) {
    cancelClose()
    cancelNarrow()
    applyExpanded(true)
    // CSS 动画立即开始；主进程跟进拓宽视图（同进程 setBounds，约 1 帧）
    void chrome.dispatch({ type: 'expand', expanded: true }).catch(() => undefined)
  } else {
    pointerCloseTarget = null
    if (closeShiftY) document.getElementById('orb-panel')?.style.removeProperty('translate')
    closeShiftY = 0
    lastPointer = null
    pointerWithinChrome = false
    syncPointerOverItem()
    applyExpanded()
    // 等收起动画播完再缩窄视图，期间鼠标回到窄条内可无缝取消
    cancelNarrow()
    narrowTimer = window.setTimeout(() => {
      narrowTimer = null
      if (!disposed) void chrome.dispatch({ type: 'expand', expanded: false }).catch(() => undefined)
    }, narrowDelayMs())
  }
  dropTarget?.refresh()
}

const ACCOUNT_ICON = lucideSvgMarkup(LUCIDE_PATHS.user)
const ACCOUNT_PORTRAIT = `<span class="orb-account-portrait" aria-hidden="true">
  <img class="orb-account-image" data-account-image alt="" draggable="false" referrerpolicy="no-referrer" />
  <span class="orb-account-fallback" data-account-fallback>${ACCOUNT_ICON}</span>
</span>`

function buildChrome(): void {
  root.innerHTML =
    PART === 'rail'
      ? `
    <div class="orb-tabs-zone" id="orb-tabs-zone">
      <button type="button" class="orb-handle" id="orb-handle" aria-label="展开标签" aria-controls="orb-panel" aria-expanded="false">
        <span class="orb-handle-grip"></span>
        <span class="orb-handle-dots" id="orb-dots"></span>
      </button>
      <div class="orb-panel" id="orb-panel" inert aria-hidden="true"></div>
    </div>
    <span class="orb-caption" id="orb-caption" role="tooltip" aria-hidden="true"></span>
  `
      : `
    <div class="orb-dock" id="orb-dock">
      <button type="button" class="orb-face orb-settings" data-settings="1" aria-label="账号与设置" aria-describedby="orb-settings-hint">
        ${ACCOUNT_PORTRAIT}
      </button>
      <span class="orb-dock-caption" id="orb-settings-hint" role="tooltip">设置</span>
    </div>
    <span class="orb-dock-grip" aria-hidden="true"></span>
  `
}

function syncAccountAvatar(): void {
  const profile = state.profile
  const name = profile?.name?.trim() ?? ''
  const source = typeof profile?.avatar === 'string' && /^data:image\/[a-z0-9.+-]+;base64,/i.test(profile.avatar)
    ? profile.avatar : ''
  root.querySelector('[data-settings]')?.setAttribute('aria-label', name ? `${name}，账号与设置` : '未登录，账号与设置')
  const key = JSON.stringify([name, source])
  if (key === avatarKey) return
  avatarKey = key
  const version = ++avatarVersion
  if (avatarLoader) { avatarLoader.onload = null; avatarLoader.onerror = null; avatarLoader = null }
  const images = Array.from(root.querySelectorAll<HTMLImageElement>('[data-account-image]'))
  const fallback = () => {
    if (disposed || version !== avatarVersion) return
    for (const image of images) { image.classList.remove('is-loaded'); image.removeAttribute('src') }
  }
  for (const node of root.querySelectorAll<HTMLElement>('[data-account-fallback]')) {
    if (name) node.textContent = Array.from(name)[0].toLocaleUpperCase()
    else node.innerHTML = ACCOUNT_ICON
  }
  if (!source) { fallback(); return }
  const loader = new Image()
  avatarLoader = loader
  loader.onload = () => {
    if (disposed || version !== avatarVersion) return
    avatarLoader = null
    for (const image of images) {
      image.src = source
      void image.decode().then(() => {
        if (!disposed && version === avatarVersion && image.getAttribute('src') === source) image.classList.add('is-loaded')
      }).catch(fallback)
    }
  }
  loader.onerror = () => { if (version === avatarVersion) avatarLoader = null; fallback() }
  loader.src = source
}

interface OrbItemSpec {
  key: string
  kind: 'home' | 'tab' | 'contrib' | 'separator' | 'settings' | 'overflow'
  title?: string
  color?: string
  glyph?: string
  icon?: string | null
  badge?: string
  active?: boolean
  tabId?: string
  pluginId?: string
  contributionId?: string
  /** 聚合圈上显示的剩余数量（kind === 'overflow' 时使用） */
  count?: number
}

const panelItems = new Map<string, HTMLElement>()
let previousDots = ''
/** 轨道聚合：超过阈值后只列前 N 个，其余收进「+N」圈；点开后临时全量显示。 */
const RAIL_VISIBLE_TABS = 4
let railTabsExpanded = false

/** 景深衰减的最大距离（条目数）：超过这个距离统一按最大值处理 */
const ORB_DEPTH_MAX = 4

/**
 * 清晰带判定阈值（单位：条目间距）。
 *
 * 取 0.6：带内恰好 1~2 个条目，且视觉上"两个一组的节奏"稳定。
 *
 * 为什么不是 1.0+：阈值 ≥1 时，指针停在某个 icon 正中，它的**两侧**邻居各距 1.0
 * 都进带 → 一次清晰 3 个，与"两个 icon"的要求冲突。
 *
 * 为什么不是 0.75：指针落在 icon 正中时只有它自己距 0 进带 → 只有 1 个清晰。
 *
 * 真正的解法是**把焦点从悬停项中心偏移到与下一项的中点**（见 syncDepth）：
 * 这样两个 icon 各距 0.5，阈值 0.6 正好只覆盖这两个，第三项在 1.5 处被排除。
 * 指针在条目边缘移动时焦点平滑过渡，不跳变。
 */
/**
 * 清晰带判定阈值（单位：条目间距，基准是**真实相邻中心距**）。
 *
 * 取 1.05：只有焦点项与**上下各 1 个邻居**保持全清晰（共 3 个），
 * 再往外立刻进入衰减。用户明确要求「高亮某个图标后上下临近的 2~3 个不要模糊」，
 * 但也反馈 ±2（5 个）在实际轨道上「还是显示了一大片」——3 个是刚好能看清邻居
 * 又不至于让整列都实的平衡点。
 *
 * 为什么正好是 1.05：|Δ|≤1 进带、|Δ|=2 开始衰减，留 0.05 吸收亚像素误差，
 * 避免临界值抖动导致带在 1/3 个之间跳。
 */
const ORB_FOCUS_BAND_UNITS = 1.05
/** 展开/滚动/激活变化后重算景深的 rAF 句柄（同一帧内多次触发合并为一次） */
let depthFrame = 0
/** 鼠标当前悬停的条目序号；-1 表示未悬停（回落中线焦点） */
let depthPointerIndex = -1

/**
 * 给每个条目写入 `--orb-depth`（离焦点多少档），CSS 据此做 blur/scale/opacity 衰减。
 *
 * 焦点优先级：
 * 1. **鼠标悬停的条目** —— 指针移到哪，清晰带就跟到哪。这是用户明确要求的行为：
 *    「鼠标移动的模糊效果要跟随着走」。
 * 2. 未悬停时回落到**轨道可视中线** —— 静止状态有一条不动的清晰带，不会整列全糊。
 *
 * 清晰带宽度：0.75 个条目间距以内都是 depth 0。
 * 停在某个 icon 正中时它自己进带、两侧邻居各在 1.0 处不进带；
 * 停在两个 icon 之间时两者各距 0.5、一起进带。这样"一次看到 1~2 个"是稳定的，
 * 不会因为半像素差跳到 3 个（那是 0.5 阈值 + round 造成的问题）。
 *
 * 距离用**像素距离 ÷ 平均条目高度**换算成"档"，而不是序号差：
 * 序号差只有整数档，两个条目中心的中点位置没法表达"各占半档"；
 * 像素距离能给出连续衰减，滚动和悬停切换都平滑。
 */
function syncDepth(): void {
  if (PART !== 'rail' || disposed) return
  const panel = document.getElementById('orb-panel')
  if (!panel) return
  const items = Array.from(panel.querySelectorAll<HTMLElement>('.orb-item'))
  if (!items.length) return
  // 一次批量读取所有条目的几何：连续 getBoundingClientRect 会各自触发同步布局，
  // 条目多时（聚合展开可达数十个）是 hover 卡顿的主要来源。
  // 统一先读进数组，后续计算只用内存里的数字。
  const panelRect = panel.getBoundingClientRect()
  const rects = items.map(item => item.getBoundingClientRect())
  let total = 0
  for (const rect of rects) total += rect.height
  const unit = Math.max(1, total / items.length)
  // 真实相邻中心距：条目有 margin-top:-10px 重叠，中心距 ≠ 条目高度。
  // 用相邻两项中心的实际差值做"一档"的基准，阈值才和"上下各 N 个"对得上。
  let pitch = unit
  if (rects.length > 1) {
    const c0 = rects[0].top + rects[0].height / 2
    const c1 = rects[1].top + rects[1].height / 2
    const diff = Math.abs(c1 - c0)
    if (diff > 1) pitch = diff
  }

  // 焦点位置，优先级从高到低：
  // 1. 鼠标悬停的条目 —— 指针移到哪，清晰带就跟到哪（临时预览别的插件）。
  // 2. 当前激活项 —— 用户正在用的那个插件/首页。轨道静止时清晰带必须落在它身上，
  //    而不是落在"屏幕中间"：用中线会让视觉重心跑到与"我在哪"无关的地方。
  // 3. 都没有时（理论上不会发生）才回落可视中线。
  const activeIndex = items.findIndex(item => item.classList.contains('active'))
  const pointerOnRail = depthPointerIndex >= 0 && depthPointerIndex < rects.length
  let focusCenter = panelRect.top + panelRect.height / 2
  if (pointerOnRail) {
    focusCenter = rects[depthPointerIndex].top + rects[depthPointerIndex].height / 2
  } else if (activeIndex >= 0) {
    focusCenter = rects[activeIndex].top + rects[activeIndex].height / 2
  }

  items.forEach((item, index) => {
    const r = rects[index]
    const center = r.top + r.height / 2
    // 距焦点多少"档"（连续值）：用真实相邻中心距做基准，|Δ|=1 就是一个邻居。
    const distanceUnits = Math.abs(center - focusCenter) / pitch
    // 清晰带内 depth 0；带外按「超出带边缘多少档」衰减，起点连续。
    const inBand = distanceUnits <= ORB_FOCUS_BAND_UNITS
    // 激活项豁免只在**鼠标不在轨道上**时生效：
    // 静止时它是「我在哪」的权威标记，必须清晰；一旦指针去悬停别的条目，
    // 用户在看那个条目，激活项也该跟着虚化——否则首页永远亮着、看不出焦点已经移走。
    // 点击切换后 activeIndex 会更新到新插件，松手（指针仍在轨道上）时新激活项
    // 由 inBand 覆盖（它就在指针下），旧激活项自然虚化。
    const isActive = !pointerOnRail && index === activeIndex
    // 衰减梯度：带外第 n 个邻居 = depth n（Δ=2 → 1，Δ=3 → 2 …）。
    // 用 distanceUnits - BAND 的连续值取整，保证滑动时平滑过渡、静止时整数档稳定。
    const depth = inBand || isActive
      ? 0
      : Math.min(ORB_DEPTH_MAX, Math.max(1, Math.round(distanceUnits - ORB_FOCUS_BAND_UNITS + 1)))
    const value = String(depth)
    if (item.style.getPropertyValue('--orb-depth') !== value) item.style.setProperty('--orb-depth', value)
    if (inBand) {
      if (item.dataset.orbFocus !== '1') item.dataset.orbFocus = '1'
    } else if (item.dataset.orbFocus) delete item.dataset.orbFocus
  })
}

/** 合并同一帧内的多次景深重算（滚动/resize 会高频触发） */
function scheduleDepthSync(): void {
  if (depthFrame) return
  depthFrame = requestAnimationFrame(() => {
    depthFrame = 0
    syncDepth()
  })
}

function cancelDepthSync(): void {
  if (!depthFrame) return
  cancelAnimationFrame(depthFrame)
  depthFrame = 0
}

function railPointerPosition() {
  if (!expanded || !pointerWithinChrome || !lastPointer) return null
  const offset = document.documentElement.dataset.orbDock === 'right' ? window.innerWidth - lastPointer.width : 0
  return { x: lastPointer.x + offset, y: lastPointer.y }
}

function anchorConfirmedClose(panel: HTMLElement): (() => void) | undefined {
  const button = pointerCloseTarget
  if (!button || state.tabs.some(tab => tab.id === button.dataset.close)) return
  pointerCloseTarget = null
  const point = railPointerPosition()
  if (!point || dragActive || !panel.contains(button)) return
  const before = button.getBoundingClientRect()
  if (point.x < before.left || point.x >= before.right || point.y < before.top || point.y >= before.bottom) return
  const index = Array.from(panel.querySelectorAll<HTMLElement>('[data-close]')).indexOf(button)
  return () => {
    const buttons = panel.querySelectorAll<HTMLElement>('[data-close]')
    const next = buttons[Math.min(index, buttons.length - 1)]
    if (!next) return
    const after = next.getBoundingClientRect()
    let delta = before.top + before.height / 2 - (after.top + after.height / 2)
    if (delta && panel.scrollHeight > panel.clientHeight) {
      const scroll = panel.scrollTop
      panel.scrollTop -= delta
      delta -= scroll - panel.scrollTop
    }
    const bounds = panel.getBoundingClientRect()
    const shift = Math.max(Math.min(0, -bounds.top), Math.min(delta, Math.max(0, window.innerHeight - bounds.bottom)))
    if (shift) { closeShiftY += shift; panel.style.translate = `0 ${closeShiftY}px` }
    const rect = next.getBoundingClientRect()
    if (Math.abs(point.x - rect.left - rect.width / 2) < next.offsetWidth / 2 && Math.abs(point.y - rect.top - rect.height / 2) < next.offsetHeight / 2) {
      pointerOverItem?.classList.remove('is-pointer-over')
      pointerOverItem = next.closest<HTMLElement>('.orb-item')
      pointerOverItem?.classList.add('is-pointer-over')
    }
  }
}

function syncPanel(): void {
  if (PART !== 'rail') {
    syncAccountAvatar()
    const btn = root.querySelector('[data-settings]')
    if (btn) {
      const active = state.view === 'settings'
      btn.classList.toggle('active', active)
      btn.setAttribute('aria-pressed', String(active))
    }
    return
  }
  const panel = document.getElementById('orb-panel')
  const dots = document.getElementById('orb-dots')
  if (!panel || !dots) return
  const homeActive = state.view === 'home'
  // 收起态定位：点列 = 首页 + 前 3 个插件；活动插件不在前 3 时占用末位点，
  // 并点亮它——收起时也能从把手点列看出「当前在哪个插件」。
  const activeTab = state.view === 'plugin' ? state.tabs.find(tab => tab.id === state.activeTabId) : undefined
  /** 激活目标标识：插件 id 或首页/设置，用于判断"激活项是否真的换了" */
  const activeKey = state.view === 'settings' ? 'settings' : activeTab?.id ?? 'home'
  let previewTabs = state.tabs.slice(0, 3)
  if (activeTab && !previewTabs.includes(activeTab)) previewTabs = [...state.tabs.slice(0, 2), activeTab]
  const dotsKey = JSON.stringify([homeActive, previewTabs.map(tab => [tab.id, tab.color, tab.id === activeTab?.id])])
  if (dotsKey !== previousDots) {
    previousDots = dotsKey
    dots.replaceChildren(...[undefined, ...previewTabs].map((tab) => {
      const dot = document.createElement('i')
      if (!tab) {
        dot.style.background = 'currentColor'
        dot.style.opacity = homeActive ? '1' : '0.4'
        if (homeActive) dot.classList.add('on')
      } else {
        dot.style.background = tab.color ?? 'currentColor'
        if (tab.id === activeTab?.id) { dot.style.opacity = '1'; dot.classList.add('on') }
        else dot.style.opacity = activeTab ? '0.45' : '0.9'
      }
      return dot
    }))
  }
  const items: OrbItemSpec[] = [{ key: 'home', kind: 'home', title: '首页', active: homeActive }]
  /** tab 多到撑满轨道时折叠：只列前 RAIL_VISIBLE_TABS 个，其余收进「+N」；点开后全量显示。 */
  const collapse = state.tabs.length > RAIL_VISIBLE_TABS + 1 && !railTabsExpanded
  const shownTabs = collapse ? state.tabs.slice(0, RAIL_VISIBLE_TABS) : state.tabs
  for (const tab of shownTabs) {
    items.push({ key: `tab:${tab.id}`, kind: 'tab', tabId: tab.id, title: tab.title,
      pluginId: tab.pluginId,
      color: tab.color, glyph: tab.glyph, icon: tab.icon, badge: tab.badge,
      active: tab.id === state.activeTabId && state.view === 'plugin' })
  }
  if (collapse) {
    const hidden = state.tabs.length - RAIL_VISIBLE_TABS
    items.push({ key: 'overflow', kind: 'overflow', count: hidden,
      title: `还有 ${hidden} 个标签，点击展开全部`, color: 'var(--orb-face-bg)' })
  } else if (railTabsExpanded && state.tabs.length > RAIL_VISIBLE_TABS) {
    items.push({ key: 'overflow', kind: 'overflow', count: 0, title: '收起为前 4 个标签',
      color: 'var(--orb-face-bg)' })
  }
  const contribs = state.contribEntries ?? []
  if (contribs.length) items.push({ key: 'separator', kind: 'separator' })
  for (const entry of contribs) items.push({ key: `contrib:${entry.pluginId}:${entry.id}`, kind: 'contrib',
    title: entry.title, color: entry.color, glyph: entry.glyph.charAt(0) || '·',
    pluginId: entry.pluginId, contributionId: entry.id })
  items.push({ key: 'settings', kind: 'settings', title: '设置', active: state.view === 'settings' })

  const wanted = new Set(items.map((item) => item.key))
  const restoreCloseSlot = anchorConfirmedClose(panel)
  for (const [key, node] of panelItems) {
    if (!wanted.has(key)) { node.remove(); panelItems.delete(key) }
  }
  items.forEach((item, index) => {
    let node = panelItems.get(item.key)
    if (!node) {
      node = document.createElement('div')
      node.className = `orb-item orb-${item.kind === 'separator' ? 'contrib-sep' : item.kind}`
      if (item.kind === 'separator') {
        node.appendChild(document.createElement('span'))
        node.setAttribute('aria-hidden', 'true')
      } else {
        const button = document.createElement('button')
        button.type = 'button'
        button.className = 'orb-face'
        if (item.kind === 'home') {
          button.dataset.home = '1'
          button.innerHTML = lucideSvgMarkup(LUCIDE_PATHS.house)
        } else if (item.kind === 'settings') {
          button.dataset.settings = '1'
          button.innerHTML = ACCOUNT_PORTRAIT
        } else if (item.kind === 'overflow') {
          button.dataset.overflow = '1'
          const count = document.createElement('span')
          count.className = 'orb-overflow-count'
          button.appendChild(count)
        } else {
          const glyph = document.createElement('span')
          glyph.className = 'orb-glyph'
          button.appendChild(glyph)
          if (item.kind === 'tab') {
            const image = document.createElement('img')
            image.className = 'orb-icon'
            image.alt = ''
            image.draggable = false
            image.hidden = true
            image.onload = () => { const loaded = Boolean(image.getAttribute('src') && image.naturalWidth); image.hidden = !loaded; glyph.hidden = loaded }
            image.onerror = () => { image.hidden = true; glyph.hidden = false }
            button.appendChild(image)
            const badge = document.createElement('span')
            badge.className = 'orb-badge'
            badge.hidden = true
            button.appendChild(badge)
          }
          if (item.kind === 'tab') button.dataset.activate = item.tabId
          else button.dataset.contrib = item.contributionId
        }
        node.appendChild(button)
        if (item.kind === 'tab') {
          const close = document.createElement('button')
          close.type = 'button'
          close.className = 'orb-close'
          close.dataset.close = item.tabId
          close.innerHTML = lucideSvgMarkup(LUCIDE_PATHS.x, 8, 1.7)
          node.appendChild(close)
        }
      }
      panelItems.set(item.key, node)
    }
    node.classList.toggle('active', item.active === true)
    if (item.kind === 'tab' && item.pluginId) node.dataset.pluginId = item.pluginId
    const face = node.querySelector<HTMLButtonElement>('.orb-face')
    if (face) {
      if (face !== captionTarget) face.title = item.title ?? ''
      face.setAttribute('aria-label', item.title ?? '')
      if (item.active) face.setAttribute('aria-current', 'page')
      else face.removeAttribute('aria-current')
      if (item.color) face.style.background = item.color
      if (item.kind === 'overflow') {
        const count = face.querySelector('.orb-overflow-count')
        if (count) count.textContent = item.count ? `+${item.count}` : '−'
        face.classList.toggle('is-collapse', !item.count)
      }
      const glyph = face.querySelector('.orb-glyph')
      if (glyph && glyph.textContent !== item.glyph) glyph.textContent = item.glyph ?? ''
      const image = face.querySelector<HTMLImageElement>('.orb-icon')
      if (image) {
        const nextSource = item.icon ?? ''
        if ((image.getAttribute('src') ?? '') !== nextSource) {
          image.hidden = true
          if (glyph instanceof HTMLElement) glyph.hidden = false
          if (nextSource) image.src = nextSource
          else image.removeAttribute('src')
        }
      }
      const badge = face.querySelector<HTMLElement>('.orb-badge')
      if (badge) { badge.textContent = item.badge ?? ''; badge.hidden = !item.badge; badge.setAttribute('aria-label', `角标 ${item.badge ?? ''}`) }
      node.querySelector('.orb-close')?.setAttribute('aria-label', `关闭 ${item.title}`)
    }
    // 保留按钮身份、焦点、hover 与滚动位置，仅在顺序真的不对时移动节点。
    const previousNode = index > 0 ? panelItems.get(items[index - 1].key) ?? null : null
    const expectedNext = previousNode ? previousNode.nextSibling : panel.firstChild
    if (node !== expectedNext) panel.insertBefore(node, expectedNext)
  })
  syncAccountAvatar()
  applyExpanded()
  restoreCloseSlot?.()
  // 激活项变化时，若面板正展开，跟随滚到新的激活项。
  // 只在「激活项真的换了」时跟随：普通状态推送（角标、主题色等）不能把用户
  // 手动滚到的位置拉回去——那是 syncPanel 注释里明确要求保留的滚动位置。
  if (expanded && activeKey !== lastActiveKey && !pointerWithinChrome && !panelHasFocus()) {
    requestAnimationFrame(() => { if (expanded && !disposed && !pointerWithinChrome && !panelHasFocus()) revealActiveItem() })
  }
  lastActiveKey = activeKey
  schedulePointerSync(true)
  scheduleDepthSync()
  dropTarget?.refresh()
}

/**
 * 把当前激活项滚到面板可视区中央。
 *
 * 为什么需要：面板是 overflow-y:auto 的滚动容器，条目多时只显示一屏；
 * 此前没有任何滚动定位逻辑，展开后永远停在顶部——用户正在用的插件如果在
 * 列表下半部分（或 `+N` 聚合圈之后），展开时根本看不到自己当前在哪。
 *
 * 触发时机（只在展开瞬间）：收起态不滚（视图只有 14px 宽、没有可视区概念），
 * 展开后重新定位到激活项。不放在每次 syncPanel：注释明确要求「保留滚动位置」，
 * 用户手动滚到某处后不能被一次状态推送拉回去。
 *
 * 折叠聚合时激活项可能不在 DOM 里（被收进 +N），此时自动展开聚合，
 * 否则"定位不到"会让这个功能在最需要的场景失灵。
 */
function revealActiveItem(): void {
  if (PART !== 'rail' || disposed) return
  const panel = document.getElementById('orb-panel')
  if (!panel) return
  let active = panel.querySelector<HTMLElement>('.orb-item.active')
  // 聚合圈折叠了激活项：先展开全量，再定位。
  if (!active && !railTabsExpanded && panel.querySelector('[data-overflow]')) {
    railTabsExpanded = true
    syncPanel()
    active = panel.querySelector<HTMLElement>('.orb-item.active')
  }
  if (!active) return
  const panelRect = panel.getBoundingClientRect()
  const rect = active.getBoundingClientRect()
  // 已经在可视区内（含少量余量）就不动，避免展开时发生无意义的滚动。
  const margin = 8
  const visible = rect.top >= panelRect.top + margin && rect.bottom <= panelRect.bottom - margin
  if (visible) { scheduleDepthSync(); return }
  // 目标：激活项中心对齐面板可视中线。
  const target = panel.scrollTop + (rect.top + rect.height / 2) - (panelRect.top + panelRect.height / 2)
  panel.scrollTop = Math.max(0, target)
  // 滚动后条目位置变了，景深清晰带要跟着重算。
  scheduleDepthSync()
}

/**
 * 指针下的条目高亮（补 :hover 的缺口）。
 *
 * 为什么需要：关闭一个插件后列表重排，鼠标没动 → 浏览器不会重算 `:hover`，
 * 新落到指针下的条目收不到 hover，`.orb-item:hover .orb-close` 不生效，
 * 关闭按钮（×）就不显示 —— 用户必须再抖一下鼠标才能看到，无法连续关闭。
 *
 * 这里用真实坐标做一次 `elementFromPoint`，给命中的条目挂 `is-pointer-over`，
 * 并清掉其他条目的残留。CSS 里把 `:hover` 与这个 class 并列，两者等价。
 */
function syncPointerOverItem(reposition = false): void {
  if (PART !== 'rail' || disposed) return
  const panel = document.getElementById('orb-panel')
  if (!panel) return
  const point = railPointerPosition()
  const under = point ? document.elementFromPoint(point.x, point.y) : null
  const hovered = under?.closest<HTMLElement>('.orb-item') ?? null
  if (hovered !== pointerOverItem) {
    pointerOverItem?.classList.remove('is-pointer-over')
    hovered?.classList.add('is-pointer-over')
    pointerOverItem = hovered
    reposition = true
  }
  if (reposition || !hovered) {
    const index = hovered ? Array.from(panel.children).indexOf(hovered) : -1
    if (depthPointerIndex !== index) { depthPointerIndex = index; scheduleDepthSync() }
  }
  const face = hovered?.querySelector<HTMLElement>('.orb-face'), title = face?.getAttribute('aria-label')
  if (face && title) {
    if (face !== captionTarget || captionEl?.textContent !== title) showCaption(face, title)
    else if (reposition && !captionFrame) positionCaption(face)
  } else if (captionTarget) hideCaption()
}

function schedulePointerSync(layoutChanged = false): void {
  if (!expanded || !lastPointer) return
  pointerLayoutChanged ||= layoutChanged
  if (!pointerFrame) pointerFrame = requestAnimationFrame(() => {
    pointerFrame = 0
    syncPointerOverItem(pointerLayoutChanged)
    pointerLayoutChanged = false
  })
}

function bindDrag(): void {
  if (PART !== 'rail') return
  const zone = document.getElementById('orb-tabs-zone')
  const panel = document.getElementById('orb-panel')
  if (!zone || !panel) return
  dragDisposers.push(bindPluginDragSource(zone, target => {
    if (target.closest('[data-close]')) return null
    const item = target.closest<HTMLElement>('[data-plugin-id]')
    // Capture the actionable button: capturing its wrapper retargets ordinary clicks away from data-activate.
    const element = item?.querySelector<HTMLElement>('[data-activate]')
    return element && item?.dataset.pluginId ? { element, pluginId: item.dataset.pluginId } : null
  }))
  dropTarget = bindPluginDropTarget(zone, {
    kind: 'shell', axis: 'y', scroller: panel,
    enabled: () => state.tabStyle === 'orb',
    items: () => Array.from(panel.querySelectorAll<HTMLElement>('[data-plugin-id]')),
    onFeedback(event) {
      if (disposed) return
      const changed = dragActive !== event.active
      dragActive = event.active
      root.classList.toggle('plugin-drag-session', dragActive)
      if (dragActive) { cancelClose(); cancelNarrow(); setExpanded(true) }
      else if (changed) scheduleClose()
      if (changed) { applyExpanded(); dropTarget?.refresh() }
    }
  })
  dragDisposers.push(() => { dropTarget?.dispose(); dropTarget = null })
}

function disposeDrag(): void {
  if (disposed) return
  disposed = true
  cancelClose(); cancelNarrow(); cancelDepthSync()
  if (pointerFrame) { cancelAnimationFrame(pointerFrame); pointerFrame = 0 }
  if (expandFrame) { cancelAnimationFrame(expandFrame); expandFrame = 0 }
  if (focusExitTimer != null) { window.clearTimeout(focusExitTimer); focusExitTimer = null }
  avatarVersion++
  if (avatarLoader) { avatarLoader.onload = null; avatarLoader.onerror = null; avatarLoader = null }
  for (const dispose of eventDisposers.splice(0)) dispose()
  for (const dispose of dragDisposers.splice(0)) dispose()
  offOrbEvent?.(); offOrbEvent = undefined
  window.removeEventListener('pagehide', disposeDrag)
}

/** 拖拽换边的最小横向位移（px）：小于此值仍按点击处理 */
const DOCK_DRAG_THRESHOLD = 12/** 换边拖拽进行中：抑制随后的 click（否则松手会顺带展开轨道） */
let dockDragSuppressClick = false

/* ---------------- 悬停名称浮层 ---------------- */

/**
 * 插件名提示：原生 `title` 的弹出延迟由操作系统决定（约 0.5s 起，无法配置），
 * 圆轨上悬停找插件时体感很迟滞。这里改用一个共享浮层，pointerenter 立即显示。
 *
 * 关键约束：WebContentsView 里的 DOM **画不出视图边界**，即便 position:fixed 也一样。
 * 轨道视图只有 84px 宽，所以浮层不能"溢出到轨道右边"——那样会被原生视图裁掉，
 * 表现为名称横向铺满轨道、右侧出现一条硬切边。
 *
 * 解法：悬停时先请主进程把轨道视图临时拓宽（+ORB_RAIL_CAPTION_EXTRA_W），
 * 浮层画在这块**拓宽出来的视图内部**；离开时还原宽度。
 * 因为视图变宽有 IPC 往返，显示顺序是「先请求拓宽 → 下一帧再定位显示」，
 * 避免浮层先按 84px 宽度定位、拓宽后再跳一次。
 *
 * `title` 仍然保留在无障碍路径上（读屏与键盘），但悬停瞬间就移除，
 * 避免原生提示在 ~0.5s 后又叠一层；离开时恢复。
 */
let captionEl: HTMLElement | null = null
let captionTarget: HTMLElement | null = null
/** 主进程当前是否已把视图拓宽（避免重复往返） */
let captionWidened = false
/** 延后显示的 rAF 句柄：拓宽未完成前不定位 */
let captionFrame = 0
/** 请求拓宽那一刻的视口宽度：用来判定"视图真的变宽了没有" */
let captionBaseWidth = 0

function requestCaptionWidth(open: boolean): void {
  if (captionWidened === open) return
  captionWidened = open
  captionBaseWidth = open ? window.innerWidth : 0
  void chrome.dispatch({ type: 'caption', open }).catch(() => {
    // 宿主不可用（浏览器预览）时保持本地状态一致，浮层仍按当前视口定位。
    captionWidened = false
  })
}

/** 视图是否已按拓宽请求变宽（Chromium 收到新 setBounds 后 innerWidth 会增大） */
function captionViewWidened(): boolean {
  // 浏览器预览（无原生宿主）不会有 setBounds，直接放行避免永远等不到。
  if (!captionWidened) return true
  const expected = captionBaseWidth + 120 // 部分拓宽即可定位，不必等满额
  return window.innerWidth >= expected
}

function hideCaption(): void {
  if (captionFrame) { cancelAnimationFrame(captionFrame); captionFrame = 0 }
  if (captionEl) {
    captionEl.classList.remove('is-visible')
    captionEl.setAttribute('aria-hidden', 'true')
  }
  if (captionTarget?.isConnected) captionTarget.title = captionTarget.getAttribute('aria-label') ?? ''
  captionTarget = null
  requestCaptionWidth(false)
}

function showCaption(target: HTMLElement, text: string): void {
  if (!captionEl || !text) return
  captionEl.textContent = text
  // 先移除原生 title，防止 OS 提示稍后弹出与浮层重叠。
  if (captionTarget && captionTarget !== target && captionTarget.isConnected) captionTarget.title = captionTarget.getAttribute('aria-label') ?? ''
  if (target.title) target.removeAttribute('title')
  captionTarget = target
  // 先请求拓宽，等视图真的变宽再定位+显示：
  // 否则浮层会按旧视口（84px）定位，被 clamp 压回轨道内——名称压在 icon 正中间。
  requestCaptionWidth(true)
  if (captionFrame) cancelAnimationFrame(captionFrame)
  let attempts = 0
  const paint = (): void => {
    captionFrame = 0
    if (!captionEl || captionTarget !== target) return
    // setBounds 是 IPC 往返，Chromium 的 innerWidth 更新可能落后几帧。
    // 最多等 8 帧（约 130ms）；超时后按当前视口兜底显示，不无限等。
    if (!captionViewWidened() && attempts < 8) {
      attempts++
      captionFrame = requestAnimationFrame(paint)
      return
    }
    captionEl.classList.add('is-visible')
    captionEl.setAttribute('aria-hidden', 'false')
    positionCaption(target)
  }
  captionFrame = requestAnimationFrame(paint)
}

/**
 * 浮层定位：左停靠落在圆球右侧，右停靠落在左侧，纵向对齐圆球中线。
 *
 * 视图拓宽后（悬浮期间主进程把轨道加宽到 320px），`rect.right + gap` 右侧
 * 有足够空间，浮层完整落在视图内部。
 *
 * 关键兜底：**如果可用空间不够（视图没拓宽成功，或名称极长），就把浮层收到
 * 圆球下方的窄行里，而不是横向压到 icon 上**。
 * 之前 clamp 只做 min/max，空间不足时会把浮层压回轨道内、盖住 icon 正中间——
 * 那正是用户多次反馈的问题。这里改成「宁可小字换行在不挡 icon 的位置」。
 */
function positionCaption(target: HTMLElement): void {
  if (!captionEl) return
  const face = target.querySelector<HTMLElement>('.orb-face') ?? target
  const rect = face.getBoundingClientRect()
  const dock = document.documentElement.dataset.orbDock === 'right' ? 'right' : 'left'
  const vw = window.innerWidth
  const vh = window.innerHeight
  const gap = 8
  const margin = 4
  // 侧向可用空间（浮层要落的那一侧）。
  const sideRoom = dock === 'right' ? rect.left - gap - margin : vw - rect.right - gap - margin
  // 名称自然宽度（先测量一次，max-width 已在 CSS 限到 200）。
  captionEl.style.maxWidth = ''
  const natural = captionEl.offsetWidth
  const height = captionEl.offsetHeight

  if (sideRoom >= Math.min(natural, 90)) {
    // 侧向空间够：正常右侧/左侧显示，宽度取「可用空间」与自然宽度较小者。
    captionEl.style.maxWidth = `${Math.max(60, Math.min(natural, sideRoom))}px`
    const width = captionEl.offsetWidth
    const left = dock === 'right' ? rect.left - width - gap : rect.right + gap
    const top = rect.top + rect.height / 2 - height / 2
    captionEl.style.left = `${Math.round(Math.max(margin, left))}px`
    captionEl.style.top = `${Math.round(Math.min(Math.max(margin, top), Math.max(margin, vh - height - margin)))}px`
    captionEl.dataset.side = '1'
    return
  }

  // 侧向空间不足（视图没拓宽）：退化为圆球下方的小字行，宽度限制在轨道内，
  // 纵向放到圆球下方，**绝不覆盖圆球**。
  // 下方放不下就放上方；上下都放不下就贴视口下缘。
  captionEl.style.maxWidth = `${Math.max(48, Math.min(natural, vw - margin * 2))}px`
  const width = captionEl.offsetWidth
  const h = captionEl.offsetHeight
  const below = rect.bottom + 2
  const above = rect.top - h - 2
  const top = below + h <= vh - margin ? below : Math.max(margin, above)
  const left = dock === 'right' ? rect.right - width : rect.left
  captionEl.style.left = `${Math.round(Math.min(Math.max(margin, left), Math.max(margin, vw - width - margin)))}px`
  captionEl.style.top = `${Math.round(Math.max(margin, top))}px`
  delete captionEl.dataset.side
}

/**
 * 把把手绑成「点击展开 / 横向拖动换边」双用途手势。
 *
 * 为什么不用 HTML5 drag：原生视图会把拖拽事件交给 Chromium 的拖放系统，
 * 松手时可能触发文件拖放或丢失 pointer capture；pointer 事件在视图内可靠得多。
 *
 * 判定：横向位移超过 DOCK_DRAG_THRESHOLD 且横向分量大于纵向分量才算换边手势；
 * 松手时若指针已经越过窗口水平中线，就请求宿主切到另一侧。这样用户不需要把
 * 把手精确拖到对面边缘，符合「拖过去就换」的直觉。
 */
function bindDockDrag(): void {
  if (PART !== 'rail') return
  const handle = document.getElementById('orb-handle')
  if (!handle) return
  let gesture: { pointerId: number; startX: number; startY: number; started: boolean } | null = null

  const finish = (event: PointerEvent, cancelled: boolean): void => {
    const current = gesture
    if (!current) return
    gesture = null
    if (handle.hasPointerCapture(current.pointerId)) {
      try { handle.releasePointerCapture(current.pointerId) } catch { /* 已释放 */ }
    }
    if (!current.started || cancelled) return
    dockDragSuppressClick = true
    // 一帧后再放开抑制，确保紧随其后的 click 被吞掉。
    requestAnimationFrame(() => { dockDragSuppressClick = false })
    const next = event.clientX > window.innerWidth / 2 ? 'right' : 'left'
    const current_dock = document.documentElement.dataset.orbDock === 'right' ? 'right' : 'left'
    if (next === current_dock) return
    // 先本地翻转（立即反馈），再交给宿主持久化与重排原生视图；失败时回滚。
    applyOrbDock(next)
    void chrome.dispatch({ type: 'dock', dock: next }).catch(() => applyOrbDock(current_dock))
  }

  const down = (event: PointerEvent): void => {
    if (event.button !== 0 || event.isPrimary === false) return
    gesture = { pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, started: false }
    try { handle.setPointerCapture(event.pointerId) } catch { gesture = null }
  }
  const move = (event: PointerEvent): void => {
    const current = gesture
    if (!current || current.pointerId !== event.pointerId) return
    if (current.started) {
      // 拖动中实时给出方向提示，让用户知道松手会落在哪侧。
      const side = event.clientX > window.innerWidth / 2 ? 'right' : 'left'
      document.documentElement.dataset.orbDockHint = side
      return
    }
    const dx = event.clientX - current.startX
    const dy = event.clientY - current.startY
    if (Math.abs(dx) >= DOCK_DRAG_THRESHOLD && Math.abs(dx) > Math.abs(dy)) {
      current.started = true
      root.classList.add('dock-dragging')
    }
  }
  const up = (event: PointerEvent): void => {
    const current = gesture
    if (!current || current.pointerId !== event.pointerId) return
    if (current.started) root.classList.remove('dock-dragging')
    delete document.documentElement.dataset.orbDockHint
    finish(event, false)
  }
  const cancel = (event: PointerEvent): void => {
    const current = gesture
    if (!current || current.pointerId !== event.pointerId) return
    root.classList.remove('dock-dragging')
    delete document.documentElement.dataset.orbDockHint
    finish(event, true)
  }

  handle.addEventListener('pointerdown', down)
  handle.addEventListener('pointermove', move)
  handle.addEventListener('pointerup', up)
  handle.addEventListener('pointercancel', cancel)
  eventDisposers.push(() => {
    handle.removeEventListener('pointerdown', down)
    handle.removeEventListener('pointermove', move)
    handle.removeEventListener('pointerup', up)
    handle.removeEventListener('pointercancel', cancel)
    root.classList.remove('dock-dragging')
    delete document.documentElement.dataset.orbDockHint
  })
}

function bindEvents(): void {
  const click = (e: MouseEvent): void => {
    if (disposed || !(e.target instanceof Element)) return
    const t = e.target
    if (PART === 'rail') {
      if (t.closest('#orb-handle')) {
        // 换边拖拽刚结束时，松手产生的 click 不应顺带展开轨道。
        if (dockDragSuppressClick) return
        setExpanded(true)
        // Native keyboard/AX button activation emits click with detail 0, not mousemove.
        if (e.detail === 0) document.getElementById('orb-panel')?.querySelector<HTMLElement>('.orb-face')?.focus({ preventScroll: true })
        return
      }
      if (!expanded || t.closest('#orb-panel')?.hasAttribute('inert')) return
    }
    if (t.closest('[data-overflow]')) {
      // 折叠 ↔ 全量切换：面板保持展开，位置由 applyExpanded 重新错落。
      railTabsExpanded = !railTabsExpanded
      syncPanel()
      return
    }
    if (t.closest('[data-home]')) {
      void chrome.dispatch({ type: 'home' }).catch(() => undefined)
      setExpanded(false)
      return
    }
    const act = t.closest('[data-activate]') as HTMLElement | null
    if (act?.dataset.activate) {
      void chrome.dispatch({ type: 'activate', tabId: act.dataset.activate }).catch(() => undefined)
      setExpanded(false)
      return
    }
    const close = t.closest('[data-close]') as HTMLElement | null
    if (close?.dataset.close) {
      const tabId = close.dataset.close
      if (closingTabs.has(tabId)) return
      const request = { acknowledged: false }
      closingTabs.set(tabId, request)
      if (e.detail > 0 && !('pointerType' in e && e.pointerType === 'touch')) {
        pointerCloseTarget = close
        lastPointer = { x: e.clientX, y: e.clientY, width: window.innerWidth }
        pointerWithinChrome = true
        cancelClose()
      }
      void chrome.dispatch({ type: 'close', tabId }).then(() => { request.acknowledged = true }, () => {
        if (closingTabs.get(tabId) !== request) return
        closingTabs.delete(tabId)
        if (pointerCloseTarget === close) pointerCloseTarget = null
      })
      return
    }
    // Resolve contribution targets in the host/adapter, never from a DOM-supplied plugin/code.
    const contrib = t.closest('[data-contrib]') as HTMLElement | null
    if (contrib?.dataset.contrib) {
      void chrome.dispatch({ type: 'contribution', id: contrib.dataset.contrib }).catch(() => undefined)
      setExpanded(false)
      return
    }
    if (t.closest('[data-settings]')) {
      void chrome.dispatch({ type: 'settings' }).catch(() => undefined)
      if (PART === 'rail') setExpanded(false)
    }
  }
  root.addEventListener('click', click)
  eventDisposers.push(() => root.removeEventListener('click', click))

  if (PART !== 'rail') return

  const keepMouseFocus = (event: MouseEvent) => {
    if (event.button === 0 && event.target instanceof Element && event.target.closest('[data-close]')) event.preventDefault()
  }
  root.addEventListener('mousedown', keepMouseFocus)
  eventDisposers.push(() => root.removeEventListener('mousedown', keepMouseFocus))

  // 真实 DOM 事件，但触发区按状态分流：
  // 收起态只认垂直居中的把手矩形（±6px 容差）——zone 会随 tab 数量撑到接近整窗高，
  // 沿用 zone 判定会让左缘窄条上任何高度（如插件左上角悬浮钮旁的路径）都唤出轨道；
  // 展开态仍用 zone 全域，把手↔圆球间滑动不误收。
  const overChrome = (x: number, y: number): boolean => {
    const target = expanded ? document.getElementById('orb-tabs-zone') : document.getElementById('orb-handle')
    if (!target) return false
    const r = target.getBoundingClientRect()
    const margin = expanded ? 0 : 6
    return x >= r.left - margin && x < r.right + margin
      && y >= r.top - margin && y < r.bottom + margin
  }
  const move = (e: MouseEvent): void => {
    if (pointerFrame && lastPointer?.x === e.clientX && lastPointer.y === e.clientY && lastPointer.width === window.innerWidth) return
    lastPointer = { x: e.clientX, y: e.clientY, width: window.innerWidth }
    pointerWithinChrome = overChrome(e.clientX, e.clientY)
    if (pointerWithinChrome) {
      cancelClose()
      if (!expanded) setExpanded(true)
    } else if (expanded) scheduleClose()
    schedulePointerSync()
  }
  const pointerMove = (event: PointerEvent): void => { if (event.isPrimary && event.pointerType !== 'touch') move(event) }
  const leave = (): void => {
    lastPointer = null
    pointerWithinChrome = false
    syncPointerOverItem()
    if (expanded) scheduleClose()
  }
  const blur = (): void => {
    if (expanded && !pointerWithinChrome) scheduleClose()
  }
  const focusIn = (): void => {
    if (focusExitTimer != null) { window.clearTimeout(focusExitTimer); focusExitTimer = null }
    if (panelHasFocus()) cancelClose()
  }
  const focusOut = (): void => {
    if (focusExitTimer != null) window.clearTimeout(focusExitTimer)
    focusExitTimer = window.setTimeout(() => {
      focusExitTimer = null
      if (disposed || !expanded) return
      // 焦点丢失有多种原因，只有"用户真的把指针移出轨道"才该收起：
      // 关闭某个插件条目时，被点的 × 按钮随条目一起从 DOM 移除，
      // 浏览器会补发 focusout —— 那不是离开意图，收起了用户就没法接着关下一个。
      if (pointerWithinChrome) return
      if (!document.hasFocus() || !root.contains(document.activeElement)) scheduleClose()
    }, 0)
  }
  document.documentElement.addEventListener('pointermove', pointerMove, { passive: true })
  document.documentElement.addEventListener('mousemove', move, { passive: true })
  document.documentElement.addEventListener('mouseleave', leave, { passive: true })
  root.addEventListener('focusin', focusIn)
  root.addEventListener('focusout', focusOut)
  window.addEventListener('blur', blur)

  // 滚动时清晰带跟随面板可视中线；窗口 resize 后条目位置也会变，一并重算。
  const panel = document.getElementById('orb-panel')
  const onScroll = (): void => { schedulePointerSync(true); scheduleDepthSync() }
  panel?.addEventListener('scroll', onScroll, { passive: true })
  window.addEventListener('resize', onScroll, { passive: true })
  eventDisposers.push(() => {
    panel?.removeEventListener('scroll', onScroll)
    window.removeEventListener('resize', onScroll)
    cancelDepthSync()
  })

  eventDisposers.push(() => {
    document.documentElement.removeEventListener('pointermove', pointerMove)
    document.documentElement.removeEventListener('mousemove', move)
    document.documentElement.removeEventListener('mouseleave', leave)
    root.removeEventListener('focusin', focusIn)
    root.removeEventListener('focusout', focusOut)
    window.removeEventListener('blur', blur)
    hideCaption()
    captionEl = null
  })
}

/** orb-state 载荷携带档位与主题（主进程 settingsStore 为唯一事实来源），到达即应用 */
function applyState(next: OrbState): void {
  if (disposed) return
  for (const [tabId, request] of closingTabs) {
    if (request.acknowledged || !next.tabs.some(tab => tab.id === tabId)) closingTabs.delete(tabId)
  }
  state = next
  // 诊断：开发态把收到的视图/激活信息打到 orb 视图的 DevTools console。
  // 高亮错位时先看这里——能一眼区分「主壳没推」还是「orb 推了但判断错了」。
  if (import.meta.env.DEV) {
    console.debug('[orb] state', {
      view: next.view,
      activeTabId: next.activeTabId,
      tabs: next.tabs.map(tab => tab.id),
      tabStyle: next.tabStyle
    })
  }
  if (isAnimLevel(next.animationLevel)) applyAnimLevel(next.animationLevel)
  if (next.theme) applyTheme(next.theme)
  syncPanel()
  if (!readyRequested) {
    readyRequested = true
    void chrome.ready().catch(() => { readyRequested = false })
  }
}

async function boot(): Promise<void> {
  // URL query 优先：首帧即正确档位/主题/停靠边；随后 orb-state 载荷持续校正
  const urlLevel = readUrlAnim()
  if (urlLevel) applyAnimLevel(urlLevel)
  const urlTheme = readUrlTheme()
  if (urlTheme) document.documentElement.dataset.theme = urlTheme
  const urlDock = readUrlDock()
  if (urlDock) document.documentElement.dataset.orbDock = urlDock

  root.className = 'orb-rail'
  buildChrome()
  captionEl = document.getElementById('orb-caption')
  bindEvents()
  bindDockDrag()
  bindDrag()

  let receivedState = false
  offOrbEvent = chrome.onSnapshot(next => {
    receivedState = true
    applyState(next)
  })
  try {
    const next = await chrome.getSnapshot()
    if (receivedState || disposed) return
    applyState(next)
  } catch {
    /* Keep the existing visible fallback while the host retries its state. */
  }
  if (!disposed) syncPanel()
}

void boot()
window.addEventListener('pagehide', disposeDrag, { once: true })
if (import.meta.hot) import.meta.hot.dispose(disposeDrag)
