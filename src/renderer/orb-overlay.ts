/**
 * orb-overlay — 左侧圆轨悬浮窗
 * 窗口宽度固定（不随展开 setBounds）；展开只切 .expanded class。
 * 默认透明穿透：mousemove forward 检测悬停，仅在把手/圆球/设置钮上收回命中。
 * 动画档位：URL query / 主进程 executeJavaScript / getSettings 同步到 root[data-anim]；
 * JS 计时与 CSS 动效均按 low|medium|high 缩放。
 */
import type { AnimationLevel } from '@shared/types/plugin'
import type { OrbRailState } from '@shared/types/ipc'
import './orb-overlay.css'

type OrbState = OrbRailState

const COLLAPSE_DELAY_MS = 700
/** 展开错落 delay 基准：40 + i * 38（medium） */
const STAGGER_BASE_MS = 40
const STAGGER_STEP_MS = 38
/** 设置变更无主进程 push 时的轻量轮询间隔 */
const ANIM_POLL_MS = 3000

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

/** 按档位缩放基准毫秒：low≈×0.2，high×1.25 */
function scaleMs(base: number): number {
  const lv = currentAnimLevel()
  if (lv === 'low') return Math.round(base * 0.2)
  if (lv === 'high') return Math.round(base * 1.25)
  return base
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

let state: OrbState = { view: 'home', tabStyle: 'orb', activeTabId: null, tabs: [] }
let expanded = false
let closeTimer: number | null = null
/** 当前是否已把命中交给窗口（true=可点） */
let hitOn = false

function cancelClose(): void {
  if (closeTimer != null) {
    window.clearTimeout(closeTimer)
    closeTimer = null
  }
}

function scheduleClose(): void {
  cancelClose()
  closeTimer = window.setTimeout(() => {
    if (expanded) {
      expanded = false
      applyExpanded()
    }
  }, scaleMs(COLLAPSE_DELAY_MS))
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

function setHit(receive: boolean): void {
  if (hitOn === receive) return
  hitOn = receive
  void shell?.setOrbOverlayHit?.(receive).catch(() => undefined)
}

function applyExpanded(): void {
  root.classList.toggle('expanded', expanded)
  root.querySelectorAll<HTMLElement>('.orb-item').forEach((el, i) => {
    el.style.transitionDelay = expanded ? `${itemStaggerMs(i)}ms` : '0ms'
  })
  // 兼容旧链路：主进程侧已固定宽度，调用无副作用
  void shell?.resizeOrbOverlay?.(expanded).catch(() => undefined)
}

function setExpanded(v: boolean): void {
  if (expanded === v) return
  if (v) cancelClose()
  expanded = v
  applyExpanded()
}

function buildChrome(): void {
  root.innerHTML = `
    <div class="orb-tabs-zone" id="orb-tabs-zone">
      <button type="button" class="orb-handle" id="orb-handle" aria-label="展开标签">
        <span class="orb-handle-grip"></span>
        <span class="orb-handle-dots" id="orb-dots"></span>
      </button>
      <div class="orb-panel" id="orb-panel"></div>
    </div>
    <div class="orb-dock" id="orb-dock">
      <button type="button" class="orb-face orb-settings" data-settings="1" title="设置" aria-label="设置">
        <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.7">
          <circle cx="12" cy="12" r="3"/>
          <path d="M19.4 15a1.7 1.7 0 0 0 .34 1.88l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06A1.7 1.7 0 0 0 15 19.4a1.7 1.7 0 0 0-1 .6 1.7 1.7 0 0 0-.4 1.1V21a2 2 0 1 1-4 0v-.09A1.7 1.7 0 0 0 8.6 19.4a1.7 1.7 0 0 0-1.88.34l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.7 1.7 0 0 0 4.6 15a1.7 1.7 0 0 0-.6-1 1.7 1.7 0 0 0-1.1-.4H3a2 2 0 1 1 0-4h.09A1.7 1.7 0 0 0 4.6 8.6a1.7 1.7 0 0 0-.34-1.88l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.7 1.7 0 0 0 9 4.6a1.7 1.7 0 0 0 1-.6 1.7 1.7 0 0 0 .4-1.1V3a2 2 0 1 1 4 0v.09a1.7 1.7 0 0 0 .4 1.1 1.7 1.7 0 0 0 1 .6 1.7 1.7 0 0 0 1.88-.34l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.7 1.7 0 0 0 19.4 9c.14.37.36.7.65.96.3.25.67.4 1.06.4H21a2 2 0 1 1 0 4h-.09a1.7 1.7 0 0 0-1.51.64Z"/>
        </svg>
      </button>
    </div>
  `
}

function syncPanel(): void {
  const panel = document.getElementById('orb-panel')
  const dots = document.getElementById('orb-dots')
  if (!panel || !dots) return

  const homeActive = state.view === 'home' || state.view === 'settings'
  dots.innerHTML = `
    <i style="background:${homeActive ? '#1a1f2e' : 'rgba(120,120,120,.5)'}"></i>
    ${state.tabs.slice(0, 3).map((t) => `<i style="background:${t.color}"></i>`).join('')}
  `

  const items: string[] = []
  items.push(
    `<div class="orb-item orb-home${homeActive ? ' active' : ''}">
      <button type="button" class="orb-face" data-home="1" title="首页" aria-label="首页">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9">
          <path d="M4 10.5 12 4l8 6.5V20a1 1 0 0 1-1 1h-5v-6H10v6H5a1 1 0 0 1-1-1v-9.5Z"/>
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
          <svg width="7" height="7" viewBox="0 0 10 10"><path d="M2 2l6 6M8 2L2 8" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>
        </button>
      </div>`
    )
  }
  panel.innerHTML = items.join('')
  root.querySelector('[data-settings]')?.classList.toggle('active', state.view === 'settings')
  applyExpanded()
}

/** 命中判定：把手 / 展开后的圆球区 / 设置钮；展开后 zone 矩形内也保持命中 */
function isOverChrome(x: number, y: number): boolean {
  const el = document.elementFromPoint(x, y)
  if (el instanceof Element) {
    if (el.closest('.orb-handle') || el.closest('.orb-dock')) return true
    if (expanded && el.closest('.orb-panel, .orb-item, .orb-face, .orb-close')) return true
  }
  if (expanded) {
    const zone = document.getElementById('orb-tabs-zone')
    if (zone) {
      const r = zone.getBoundingClientRect()
      if (x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) return true
    }
  }
  return false
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
    if (t.closest('[data-settings]')) {
      void shell?.setShellView?.('settings')
      setExpanded(false)
    }
  }

  // forward 模式下 mousemove 可达；用它驱动展开/收起与命中穿透
  document.addEventListener(
    'mousemove',
    (e) => {
      const over = isOverChrome(e.clientX, e.clientY)
      setHit(over)
      if (over) {
        cancelClose()
        // 把手悬停 → 展开；展开后在 panel 内保持
        if (!expanded && (e.target as Element | null)?.closest?.('.orb-handle')) {
          setExpanded(true)
        }
      } else if (expanded) {
        scheduleClose()
      }
    },
    { passive: true }
  )

  document.addEventListener(
    'mouseleave',
    () => {
      setHit(false)
      if (expanded) scheduleClose()
    },
    { passive: true }
  )
}

/** 从 settings 拉当前 animationLevel（主进程 executeJavaScript 之外的兜底） */
async function hydrateAnimLevel(): Promise<void> {
  if (!shell?.getSettings) return
  try {
    const settings = await shell.getSettings()
    const raw = settings?.general?.animationLevel
    if (isAnimLevel(raw)) applyAnimLevel(raw)
  } catch {
    /* ignore */
  }
}

async function boot(): Promise<void> {
  // URL query 优先，settings 再校正
  const urlLevel = readUrlAnim()
  if (urlLevel) applyAnimLevel(urlLevel)

  root.className = 'orb-rail'
  buildChrome()
  bindEvents()
  // 初始穿透
  setHit(false)

  void hydrateAnimLevel()
  // 轻量轮询：设置页改档无事件推送时，保证可见期间也能对齐
  window.setInterval(() => {
    void hydrateAnimLevel()
  }, ANIM_POLL_MS)

  shell?.onOrbEvent?.((payload) => {
    if (payload?.state) {
      state = payload.state
      syncPanel()
    }
  })
  if (shell?.getOrbState) {
    try {
      const s = await shell.getOrbState()
      state = {
        view: s.view as OrbState['view'],
        tabStyle: s.tabStyle as OrbState['tabStyle'],
        activeTabId: s.activeTabId,
        tabs: (s.tabs as OrbState['tabs']) ?? []
      }
    } catch {
      /* ignore */
    }
  }
  syncPanel()
}

void boot()
