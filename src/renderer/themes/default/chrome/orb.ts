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
/** 收起 CSS 动画播完后再缩窄视图，避免圆球被右缘裁切（item 淡出 ~260ms 已不可见） */
function narrowDelayMs(): number {
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return 0
  return currentAnimLevel() === 'high' ? 380 : currentAnimLevel() === 'low' ? 180 : 280
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

const chrome = createDefaultChromeApi(PART)
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
  if (disposed || dragActive || panelHasFocus()) return
  cancelClose()
  closeTimer = window.setTimeout(() => {
    closeTimer = null
    if (!dragActive && !panelHasFocus()) setExpanded(false)
  }, COLLAPSE_DELAY_MS)
}

function cancelNarrow(): void {
  if (narrowTimer != null) {
    window.clearTimeout(narrowTimer)
    narrowTimer = null
  }
}


function applyExpanded(): void {
  const panel = document.getElementById('orb-panel')
  const handle = document.getElementById('orb-handle')
  // Return local focus before inert, without stealing it back from another native surface.
  if (!expanded && panelHasFocus()) handle?.focus({ preventScroll: true })
  handle?.setAttribute('aria-expanded', String(expanded))
  if (handle) handle.tabIndex = expanded ? -1 : 0
  panel?.toggleAttribute('inert', !expanded)
  panel?.setAttribute('aria-hidden', String(!expanded))
  root.classList.toggle('expanded', expanded)
  // 入列错落；收起不加 delay，整列一起退更跟手
  root.querySelectorAll<HTMLElement>('.orb-item').forEach((el, i) => {
    el.style.transitionDelay = expanded && !dragActive ? `${itemStaggerMs(i)}ms` : '0ms'
  })
}

function setExpanded(v: boolean): void {
  if (disposed || !v && dragActive) return
  if (expanded === v) return
  expanded = v
  if (v) {
    cancelClose()
    cancelNarrow()
    applyExpanded()
    // CSS 动画立即开始；主进程跟进拓宽视图（同进程 setBounds，约 1 帧）
    void chrome.dispatch({ type: 'expand', expanded: true }).catch(() => undefined)
  } else {
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
  `
      : `
    <div class="orb-dock" id="orb-dock">
      <button type="button" class="orb-face orb-settings" data-settings="1" aria-label="账号与设置" aria-describedby="orb-settings-hint">
        ${ACCOUNT_PORTRAIT}
      </button>
      <span class="orb-dock-caption" id="orb-settings-hint" role="tooltip">设置</span>
    </div>
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
  kind: 'home' | 'tab' | 'contrib' | 'separator' | 'settings'
  title?: string
  color?: string
  glyph?: string
  icon?: string | null
  badge?: string
  active?: boolean
  tabId?: string
  pluginId?: string
  contributionId?: string
}

const panelItems = new Map<string, HTMLElement>()
let previousDots = ''

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
  const dotsKey = JSON.stringify([homeActive, state.tabs.slice(0, 3).map((tab) => tab.color)])
  if (dotsKey !== previousDots) {
    previousDots = dotsKey
    dots.replaceChildren(...[undefined, ...state.tabs.slice(0, 3)].map((tab) => {
      const dot = document.createElement('i')
      dot.style.background = tab?.color ?? 'currentColor'
      if (!tab) dot.style.opacity = homeActive ? '0.95' : '0.4'
      return dot
    }))
  }
  const items: OrbItemSpec[] = [{ key: 'home', kind: 'home', title: '首页', active: homeActive }]
  for (const tab of state.tabs) {
    items.push({ key: `tab:${tab.id}`, kind: 'tab', tabId: tab.id, title: tab.title,
      pluginId: tab.pluginId,
      color: tab.color, glyph: tab.glyph, icon: tab.icon, badge: tab.badge,
      active: tab.id === state.activeTabId && state.view === 'plugin' })
  }
  const contribs = state.contribEntries ?? []
  if (contribs.length) items.push({ key: 'separator', kind: 'separator' })
  for (const entry of contribs) items.push({ key: `contrib:${entry.pluginId}:${entry.id}`, kind: 'contrib',
    title: entry.title, color: entry.color, glyph: entry.glyph.charAt(0) || '·',
    pluginId: entry.pluginId, contributionId: entry.id })
  items.push({ key: 'settings', kind: 'settings', title: '设置', active: state.view === 'settings' })

  const wanted = new Set(items.map((item) => item.key))
  for (const [key, node] of panelItems) {
    if (!wanted.has(key)) { node.remove(); panelItems.delete(key) }
  }
  items.forEach((item, index) => {
    let node = panelItems.get(item.key)
    if (!node) {
      node = document.createElement('div')
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
    node.className = `orb-item orb-${item.kind === 'separator' ? 'contrib-sep' : item.kind}${item.active ? ' active' : ''}`
    if (item.kind === 'tab' && item.pluginId) node.dataset.pluginId = item.pluginId
    const face = node.querySelector<HTMLButtonElement>('.orb-face')
    if (face) {
      face.title = item.title ?? ''
      face.setAttribute('aria-label', item.title ?? '')
      if (item.active) face.setAttribute('aria-current', 'page')
      else face.removeAttribute('aria-current')
      if (item.color) face.style.background = item.color
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
    // 保留按钮身份、焦点、hover 与滚动位置，仅在排序变化时移动节点。
    if (panel.children[index] !== node) panel.insertBefore(node, panel.children[index] ?? null)
  })
  syncAccountAvatar()
  applyExpanded()
  dropTarget?.refresh()
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
  cancelClose(); cancelNarrow()
  if (focusExitTimer != null) { window.clearTimeout(focusExitTimer); focusExitTimer = null }
  avatarVersion++
  if (avatarLoader) { avatarLoader.onload = null; avatarLoader.onerror = null; avatarLoader = null }
  for (const dispose of eventDisposers.splice(0)) dispose()
  for (const dispose of dragDisposers.splice(0)) dispose()
  offOrbEvent?.(); offOrbEvent = undefined
  window.removeEventListener('pagehide', disposeDrag)
}

function bindEvents(): void {
  const click = (e: MouseEvent): void => {
    if (disposed || !(e.target instanceof Element)) return
    const t = e.target
    if (PART === 'rail') {
      if (t.closest('#orb-handle')) {
        setExpanded(true)
        // Native keyboard/AX button activation emits click with detail 0, not mousemove.
        if (e.detail === 0) document.getElementById('orb-panel')?.querySelector<HTMLElement>('.orb-face')?.focus({ preventScroll: true })
        return
      }
      if (!expanded || t.closest('#orb-panel')?.hasAttribute('inert')) return
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
      state = { ...state, tabs: state.tabs.filter((tab) => tab.id !== tabId) }
      syncPanel()
      void chrome.dispatch({ type: 'close', tabId }).catch(() => undefined)
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

  // 真实 DOM 事件，但触发区限定在把手/圆球 zone（垂直居中矩形）：
  // 沿左缘扫过条带顶部/底部（如去点设置钮）不应弹开 Tab 轨
  const overChrome = (y: number): boolean => {
    const zone = document.getElementById('orb-tabs-zone')
    if (!zone) return false
    const r = zone.getBoundingClientRect()
    return y >= r.top && y <= r.bottom
  }
  const move = (e: MouseEvent): void => {
    pointerWithinChrome = overChrome(e.clientY)
    if (pointerWithinChrome) {
      cancelClose()
      if (!expanded) setExpanded(true)
    } else if (expanded) scheduleClose()
  }
  const leave = (): void => {
    pointerWithinChrome = false
    if (expanded) scheduleClose()
  }
  const focusIn = (): void => {
    if (focusExitTimer != null) { window.clearTimeout(focusExitTimer); focusExitTimer = null }
    if (panelHasFocus()) cancelClose()
  }
  const focusOut = (): void => {
    if (focusExitTimer != null) window.clearTimeout(focusExitTimer)
    focusExitTimer = window.setTimeout(() => {
      focusExitTimer = null
      if (!disposed && expanded && !pointerWithinChrome && (!document.hasFocus() || !root.contains(document.activeElement))) scheduleClose()
    }, 0)
  }
  document.documentElement.addEventListener('mousemove', move, { passive: true })
  document.documentElement.addEventListener('mouseleave', leave, { passive: true })
  root.addEventListener('focusin', focusIn)
  root.addEventListener('focusout', focusOut)
  window.addEventListener('blur', leave)
  eventDisposers.push(() => {
    document.documentElement.removeEventListener('mousemove', move)
    document.documentElement.removeEventListener('mouseleave', leave)
    root.removeEventListener('focusin', focusIn)
    root.removeEventListener('focusout', focusOut)
    window.removeEventListener('blur', leave)
  })
}

/** orb-state 载荷携带档位与主题（主进程 settingsStore 为唯一事实来源），到达即应用 */
function applyState(next: OrbState): void {
  if (disposed) return
  state = next
  if (isAnimLevel(next.animationLevel)) applyAnimLevel(next.animationLevel)
  if (next.theme) applyTheme(next.theme)
  syncPanel()
  if (!readyRequested) {
    readyRequested = true
    void chrome.ready().catch(() => { readyRequested = false })
  }
}

async function boot(): Promise<void> {
  // URL query 优先：首帧即正确档位/主题；随后 orb-state 载荷持续校正
  const urlLevel = readUrlAnim()
  if (urlLevel) applyAnimLevel(urlLevel)
  const urlTheme = readUrlTheme()
  if (urlTheme) document.documentElement.dataset.theme = urlTheme

  root.className = 'orb-rail'
  buildChrome()
  bindEvents()
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
