/**
 * orb-overlay — 左侧圆轨悬浮窗入口（透明 BrowserWindow，盖在插件原生层上）
 * 通过 window.enestShell（与主壳同一 preload）同步状态与操作。
 */
import type { OrbRailState } from '@shared/types/ipc'
import './orb-overlay.css'

type OrbState = OrbRailState

const shell = window.enestShell
const root = document.getElementById('orb-root')
if (!root) throw new Error('#orb-root missing')

let state: OrbState = { view: 'home', tabStyle: 'orb', activeTabId: null, tabs: [] }
let expanded = false
let closeTimer: number | null = null

function cancelClose(): void {
  if (closeTimer != null) {
    window.clearTimeout(closeTimer)
    closeTimer = null
  }
}

function scheduleClose(): void {
  cancelClose()
  closeTimer = window.setTimeout(() => {
    expanded = false
    render()
  }, 380)
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

function render(): void {
  if (!root) return
  const homeActive = state.view === 'home' || state.view === 'settings'
  root.className = `orb-rail${expanded ? ' expanded' : ''}`
  root.onmouseenter = () => {
    cancelClose()
    expanded = true
    render()
  }
  root.onmouseleave = scheduleClose

  const items: string[] = []
  items.push(
    `<button type="button" class="orb-item orb-home${homeActive ? ' active' : ''}" data-home="1" title="首页">
      <span class="orb-face">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9">
          <path d="M4 10.5 12 4l8 6.5V20a1 1 0 0 1-1 1h-5v-6H10v6H5a1 1 0 0 1-1-1v-9.5Z"/>
        </svg>
      </span>
    </button>`
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

  root.innerHTML = `
    <button type="button" class="orb-handle" aria-label="展开标签">
      <span class="orb-handle-grip"></span>
      <span class="orb-handle-dots">
        <i style="background:${homeActive ? '#1a1f2e' : 'rgba(120,120,120,.5)'}"></i>
        ${state.tabs.slice(0, 3).map((t) => `<i style="background:${t.color}"></i>`).join('')}
      </span>
    </button>
    <div class="orb-panel">${items.join('')}</div>
    <div class="orb-dock">
      <button type="button" class="orb-face orb-settings${state.view === 'settings' ? ' active' : ''}" data-settings="1" title="设置">
        <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.7">
          <circle cx="12" cy="12" r="3"/>
          <path d="M19.4 15a1.7 1.7 0 0 0 .34 1.88l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06A1.7 1.7 0 0 0 15 19.4a1.7 1.7 0 0 0-1 .6 1.7 1.7 0 0 0-.4 1.1V21a2 2 0 1 1-4 0v-.09A1.7 1.7 0 0 0 8.6 19.4a1.7 1.7 0 0 0-1.88.34l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.7 1.7 0 0 0 4.6 15a1.7 1.7 0 0 0-.6-1 1.7 1.7 0 0 0-1.1-.4H3a2 2 0 1 1 0-4h.09A1.7 1.7 0 0 0 4.6 8.6a1.7 1.7 0 0 0-.34-1.88l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.7 1.7 0 0 0 9 4.6a1.7 1.7 0 0 0 1-.6 1.7 1.7 0 0 0 .4-1.1V3a2 2 0 1 1 4 0v.09a1.7 1.7 0 0 0 .4 1.1 1.7 1.7 0 0 0 1 .6 1.7 1.7 0 0 0 1.88-.34l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.7 1.7 0 0 0 19.4 9c.14.37.36.7.65.96.3.25.67.4 1.06.4H21a2 2 0 1 1 0 4h-.09a1.7 1.7 0 0 0-1.51.64Z"/>
        </svg>
      </button>
    </div>
  `

  root.onclick = (e) => {
    const t = e.target as HTMLElement
    if (t.closest('[data-home]')) {
      void shell?.goHome?.()
      expanded = false
      render()
      return
    }
    const act = t.closest('[data-activate]') as HTMLElement | null
    if (act?.dataset.activate) {
      void shell?.activatePlugin(act.dataset.activate)
      expanded = false
      render()
      return
    }
    const close = t.closest('[data-close]') as HTMLElement | null
    if (close?.dataset.close) {
      void shell?.closePlugin(close.dataset.close)
      return
    }
    if (t.closest('[data-settings]')) {
      void shell?.setShellView?.('settings')
      expanded = false
      render()
    }
  }
}

async function boot(): Promise<void> {
  shell?.onOrbEvent?.((payload) => {
    if (payload?.state) {
      state = payload.state
      render()
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
  render()
}

void boot()
