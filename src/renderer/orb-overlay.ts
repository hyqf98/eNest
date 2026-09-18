/**
 * orb-overlay — 左侧圆轨（主窗口内顶层 WebContentsView）
 * ?part=rail：Tab 轨窄条，mouseenter 展开 / mouseleave 延迟收起（真实 DOM 事件，无穿透转发）；
 * ?part=dock：左下角常驻设置钮。
 * 动画档位 / 主题：URL query 首帧 + orb-state 载荷（主进程 settingsStore 为唯一事实来源）
 * 同步到 root[data-anim] / root[data-theme] + token 变量；CSS 动效与配色按档位、主题缩放。
 */
import type { AnimationLevel } from '@shared/types/plugin'
import type { OrbRailState } from '@shared/types/ipc'
import './orb-overlay.css'

type OrbState = OrbRailState
type Part = 'rail' | 'dock'
type ThemeInfo = OrbState['theme']

const PART: Part = new URLSearchParams(window.location.search).get('part') === 'dock' ? 'dock' : 'rail'

/** 鼠标离开后收起缓冲（hover intent），不随动画档位缩放 */
const COLLAPSE_DELAY_MS = 260
/** 收起 CSS 动画播完后再缩窄视图，避免圆球被右缘裁切（item 淡出 ~260ms 已不可见） */
const NARROW_DELAY_MS = 280
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
  const base = STAGGER_BASE_MS + index * STAGGER_STEP_MS
  return lv === 'high' ? Math.round(base * 1.2) : base
}

const shell = window.enestShell
const rootEl = document.getElementById('orb-root')
if (!rootEl) throw new Error('#orb-root missing')
const root: HTMLElement = rootEl

let state: OrbState = {
  view: 'home',
  tabStyle: 'orb',
  activeTabId: null,
  animationLevel: 'medium',
  theme: { mode: 'light', tokens: {} },
  tabs: []
}
let expanded = false
let closeTimer: number | null = null
let narrowTimer: number | null = null

function cancelClose(): void {
  if (closeTimer != null) {
    window.clearTimeout(closeTimer)
    closeTimer = null
  }
}

function scheduleClose(): void {
  cancelClose()
  closeTimer = window.setTimeout(() => setExpanded(false), COLLAPSE_DELAY_MS)
}

function cancelNarrow(): void {
  if (narrowTimer != null) {
    window.clearTimeout(narrowTimer)
    narrowTimer = null
  }
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

function applyExpanded(): void {
  root.classList.toggle('expanded', expanded)
  // 入列错落；收起不加 delay，整列一起退更跟手
  root.querySelectorAll<HTMLElement>('.orb-item').forEach((el, i) => {
    el.style.transitionDelay = expanded ? `${itemStaggerMs(i)}ms` : '0ms'
  })
}

function setExpanded(v: boolean): void {
  if (expanded === v) return
  expanded = v
  if (v) {
    cancelClose()
    cancelNarrow()
    applyExpanded()
    // CSS 动画立即开始；主进程跟进拓宽视图（同进程 setBounds，约 1 帧）
    void shell?.setOrbRailExpanded?.(true).catch(() => undefined)
  } else {
    applyExpanded()
    // 等收起动画播完再缩窄视图，期间鼠标回到窄条内可无缝取消
    cancelNarrow()
    narrowTimer = window.setTimeout(() => {
      narrowTimer = null
      void shell?.setOrbRailExpanded?.(false).catch(() => undefined)
    }, NARROW_DELAY_MS)
  }
}

const SETTINGS_ICON = `
  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <path d="M9.671 4.136a2.34 2.34 0 0 1 4.659 0 2.34 2.34 0 0 0 3.319 1.915 2.34 2.34 0 0 1 2.33 4.033 2.34 2.34 0 0 0 0 3.831 2.34 2.34 0 0 1-2.33 4.033 2.34 2.34 0 0 0-3.319 1.915 2.34 2.34 0 0 1-4.659 0 2.34 2.34 0 0 0-3.32-1.915 2.34 2.34 0 0 1-2.33-4.033 2.34 2.34 0 0 0 0-3.831A2.34 2.34 0 0 1 6.35 6.051a2.34 2.34 0 0 0 3.319-1.915"/>
    <circle cx="12" cy="12" r="3"/>
  </svg>`

function buildChrome(): void {
  root.innerHTML =
    PART === 'rail'
      ? `
    <div class="orb-tabs-zone" id="orb-tabs-zone">
      <button type="button" class="orb-handle" id="orb-handle" aria-label="展开标签">
        <span class="orb-handle-grip"></span>
        <span class="orb-handle-dots" id="orb-dots"></span>
      </button>
      <div class="orb-panel" id="orb-panel"></div>
    </div>
  `
      : `
    <div class="orb-dock" id="orb-dock">
      <button type="button" class="orb-face orb-settings" data-settings="1" title="设置" aria-label="设置">
        ${SETTINGS_ICON}
      </button>
    </div>
  `
}

function syncPanel(): void {
  if (PART === 'rail') {
    const panel = document.getElementById('orb-panel')
    const dots = document.getElementById('orb-dots')
    if (!panel || !dots) return

    const homeActive = state.view === 'home' || state.view === 'settings'
    dots.innerHTML = `
      <i style="background:currentColor;opacity:${homeActive ? '0.95' : '0.4'}"></i>
      ${state.tabs.slice(0, 3).map((t) => `<i style="background:${t.color}"></i>`).join('')}
    `

    const items: string[] = []
    items.push(
      `<div class="orb-item orb-home${homeActive ? ' active' : ''}">
        <button type="button" class="orb-face" data-home="1" title="首页" aria-label="首页">
          <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <path d="M15 21v-8a1 1 0 0 0-1-1h-4a1 1 0 0 0-1 1v8"/>
            <path d="M3 10a2 2 0 0 1 .709-1.528l7-6a2 2 0 0 1 2.582 0l7 6A2 2 0 0 1 21 10v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>
          </svg>
        </button>
      </div>`
    )
    for (const tab of state.tabs) {
      const active = tab.id === state.activeTabId && state.view === 'plugin'
      items.push(
        `<div class="orb-item orb-tab${active ? ' active' : ''}">
          <button type="button" class="orb-face" style="background:${tab.color}" title="${escapeHtml(tab.title)}" data-activate="${tab.id}">
            <span class="orb-glyph">${escapeHtml(tab.glyph)}</span>
          </button>
          <button type="button" class="orb-close" data-close="${tab.id}" aria-label="关闭 ${escapeHtml(tab.title)}">
            <svg xmlns="http://www.w3.org/2000/svg" width="8" height="8" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>
          </button>
        </div>`
      )
    }
    // rail-entries 插槽贡献（manifest.contributes.railEntries）：Tab 圆点之后、
    // 分隔线下方渲染入口圆点；点击 openPlugin(pluginId, { code: openCode })
    const contribs = state.contribEntries ?? []
    if (contribs.length > 0) {
      items.push('<div class="orb-item orb-contrib-sep" aria-hidden="true"><span></span></div>')
      for (const entry of contribs) {
        items.push(
          `<div class="orb-item orb-contrib">
            <button type="button" class="orb-face" style="background:${entry.color}" title="${escapeHtml(entry.title)}" data-contrib="${entry.pluginId}" data-open-code="${escapeHtml(entry.openCode ?? '')}">
              <span class="orb-glyph">${escapeHtml(entry.glyph.charAt(0) || '·')}</span>
            </button>
          </div>`
        )
      }
    }
    panel.innerHTML = items.join('')
    applyExpanded()
  } else {
    root.querySelector('[data-settings]')?.classList.toggle('active', state.view === 'settings')
  }
}

function bindEvents(): void {
  root.onclick = (e) => {
    const t = e.target as HTMLElement
    if (t.closest('[data-home]')) {
      void shell?.goHome?.()
      setExpanded(false)
      return
    }
    const act = t.closest('[data-activate]') as HTMLElement | null
    if (act?.dataset.activate) {
      void shell?.activatePlugin(act.dataset.activate)
      setExpanded(false)
      return
    }
    const close = t.closest('[data-close]') as HTMLElement | null
    if (close?.dataset.close) {
      void shell?.closePlugin(close.dataset.close)
      return
    }
    // rail-entries 贡献入口：openPlugin(pluginId, { code: openCode })，
    // openCode 为空则不带 enter（插件默认入口）
    const contrib = t.closest('[data-contrib]') as HTMLElement | null
    if (contrib?.dataset.contrib) {
      const code = contrib.dataset.openCode || ''
      void shell?.openPlugin(contrib.dataset.contrib, code ? { code } : undefined)?.catch(
        () => undefined
      )
      setExpanded(false)
      return
    }
    if (t.closest('[data-settings]')) {
      void shell?.setShellView?.('settings')
      setExpanded(false)
    }
  }

  if (PART !== 'rail') return

  // 真实 DOM 事件，但触发区限定在把手/圆球 zone（垂直居中矩形）：
  // 沿左缘扫过条带顶部/底部（如去点设置钮）不应弹开 Tab 轨
  const overChrome = (y: number): boolean => {
    const zone = document.getElementById('orb-tabs-zone')
    if (!zone) return false
    const r = zone.getBoundingClientRect()
    return y >= r.top && y <= r.bottom
  }
  document.documentElement.addEventListener(
    'mousemove',
    (e) => {
      if (overChrome(e.clientY)) {
        cancelClose()
        if (!expanded) setExpanded(true)
      } else if (expanded) {
        scheduleClose()
      }
    },
    { passive: true }
  )
  document.documentElement.addEventListener(
    'mouseleave',
    () => {
      if (expanded) scheduleClose()
    },
    { passive: true }
  )
}

/** orb-state 载荷携带档位与主题（主进程 settingsStore 为唯一事实来源），到达即应用 */
function applyState(next: OrbState): void {
  state = next
  if (isAnimLevel(next.animationLevel)) applyAnimLevel(next.animationLevel)
  if (next.theme) applyTheme(next.theme)
  syncPanel()
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

  shell?.onOrbEvent?.((payload) => {
    if (payload?.state) applyState(payload.state)
  })
  if (shell?.getOrbState) {
    try {
      const s = await shell.getOrbState()
      applyState({
        view: s.view as OrbState['view'],
        tabStyle: s.tabStyle as OrbState['tabStyle'],
        activeTabId: s.activeTabId,
        animationLevel: isAnimLevel(s.animationLevel) ? s.animationLevel : 'medium',
        theme: (s.theme as OrbState['theme']) ?? { mode: 'light', tokens: {} },
        tabs: (s.tabs as OrbState['tabs']) ?? [],
        contribEntries: (s.contribEntries as OrbState['contribEntries']) ?? []
      })
    } catch {
      /* ignore */
    }
  }
  syncPanel()
}

void boot()
