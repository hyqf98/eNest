/**
 * orbRailViews — 左侧圆轨 / 设置钮（主窗口内顶层 WebContentsView）
 * 取代独立透明子窗方案：视图内是真实 DOM 鼠标事件，无穿透转发、无窗口焦点/层级问题。
 * - rail 视图：左缘窄条，收起 ORB_RAIL_COLLAPSED_W（仅把手），renderer hover 触发
 *   经 IPC 拓宽到 ORB_RAIL_EXPANDED_W（同进程 setBounds，约 1 帧）。
 * - dock 视图：左下角常驻设置钮，始终可点。两者无重叠，插件内容全宽渲染（inset 0）。
 *   设置钮经 CSS left/bottom 内边距与展开轨道圆球左缘对齐（≈8–10px）。
 * - z 序：WebContentsView 无显式置顶 API，插件视图挂载后需调 raiseOrbRailViews()
 *   以 remove+re-add 置顶（electron#42061）。
 */
import { app, nativeTheme, WebContentsView, type WebPreferences } from 'electron'
import { join } from 'node:path'
import {
  ORB_DOCK_PAD_BOTTOM,
  ORB_DOCK_PAD_LEFT,
  ORB_DOCK_VIEW_H,
  ORB_DOCK_VIEW_W,
  ORB_RAIL_COLLAPSED_W,
  ORB_RAIL_EXPANDED_W,
  SHELL_PARTITION,
  TITLEBAR_HEIGHT
} from '@shared/constants'
import { IpcChannels, type OrbRailState } from '@shared/types/ipc'
import type { AnimationLevel } from '@shared/types/plugin'
import {
  getMainWindow,
  getShellBounds,
  resolvePreload,
  setPluginLeftInset
} from '@main/window/createShellWindow'
import { settingsStore } from '@main/settings/SettingsStore'
import { resolveThemeTokens, type ResolvedThemeCss } from '@main/theme/resolveThemeCss'
import { listRailEntries } from '@main/contrib/ContributionRegistry'
import { pluginRegistry } from '@main/plugin/PluginRegistry'
import { logInfo } from '@main/logs/logService'

let railView: WebContentsView | null = null
let dockView: WebContentsView | null = null
let railExpanded = false
let themeHooked = false

let lastState: OrbRailState = {
  view: 'home',
  tabStyle: 'classic',
  activeTabId: null,
  animationLevel: 'medium',
  theme: { mode: 'light', tokens: {} },
  tabs: [],
  contribEntries: []
}

export function getOrbRailState(): OrbRailState {
  return lastState
}

function isAnimLevel(v: unknown): v is AnimationLevel {
  return v === 'low' || v === 'medium' || v === 'high'
}

/** 从 settingsStore 读当前动画档位（主进程为唯一事实来源） */
function readAnimLevel(): AnimationLevel {
  try {
    const raw = settingsStore.getAll().general.animationLevel
    return isAnimLevel(raw) ? raw : 'medium'
  } catch {
    return 'medium'
  }
}

/** 解析当前主题（预设 + 主题包 + 用户覆盖，system 跟随 nativeTheme），与主壳一致 */
function readTheme(): ResolvedThemeCss {
  try {
    return resolveThemeTokens('auto')
  } catch {
    return { mode: 'light', tokens: {} }
  }
}

function sendStateTo(wc: { isDestroyed(): boolean; send(channel: string, payload: unknown): void }): void {
  if (wc.isDestroyed()) return
  wc.send(IpcChannels.ShellOrbEvent, { type: 'orb-state', state: lastState })
}

function broadcastState(): void {
  for (const view of [railView, dockView]) {
    if (view) sendStateTo(view.webContents)
  }
}

function applyRailBounds(): void {
  if (!railView) return
  const b = getShellBounds()
  const width = railExpanded ? ORB_RAIL_EXPANDED_W : ORB_RAIL_COLLAPSED_W
  // 底部为 dock 预留：dock 视图高度 + 贴边安全区，避免 tab 列表压到设置钮
  const dockReserve = ORB_DOCK_VIEW_H + ORB_DOCK_PAD_BOTTOM
  const height = Math.max(120, b.height - TITLEBAR_HEIGHT - dockReserve)
  railView.setBounds({ x: 0, y: TITLEBAR_HEIGHT, width, height })
}

function applyDockBounds(): void {
  if (!dockView) return
  const b = getShellBounds()
  // 视图贴窗口左下，按钮在 CSS 内再加 left/bottom 内边距，与展开轨道对齐
  dockView.setBounds({
    x: 0,
    y: Math.max(TITLEBAR_HEIGHT + 120, b.height - ORB_DOCK_VIEW_H),
    width: ORB_DOCK_VIEW_W,
    height: ORB_DOCK_VIEW_H
  })
}

/** URL query 携带 part / 动画档位 / 主题模式：首帧即正确，无 medium 或浅色闪变 */
function loadPart(view: WebContentsView, part: 'rail' | 'dock'): void {
  const anim = readAnimLevel()
  const themeMode = readTheme().mode
  const devUrl = process.env.ELECTRON_RENDERER_URL
  if (devUrl) {
    const base = devUrl.replace(/\/$/, '')
    void view.webContents.loadURL(
      `${base}/orb-overlay.html?part=${part}&anim=${encodeURIComponent(anim)}&theme=${themeMode}`
    )
  } else {
    void view.webContents.loadFile(join(app.getAppPath(), 'out', 'renderer', 'orb-overlay.html'), {
      query: { part, anim, theme: themeMode }
    })
  }
}

function makeView(part: 'rail' | 'dock'): WebContentsView {
  // WebContentsView 默认不透明（electron#44914）：透明底需要 RGBA 全零 backgroundColor。
  // WebPreferences 类型未收该键，但运行时支持（官方迁移指南），故用交叉类型显式传入
  const prefs: WebPreferences & { backgroundColor?: string } = {
    backgroundColor: '#00000000',
    preload: resolvePreload('shellPreload.js'),
    contextIsolation: true,
    nodeIntegration: false,
    sandbox: false,
    partition: SHELL_PARTITION,
    backgroundThrottling: false
  }
  const view = new WebContentsView({ webPreferences: prefs })
  try {
    view.setBackgroundColor('#00000000')
  } catch {
    /* 个别平台不支持方法调用时，构造参数已兜底 */
  }
  loadPart(view, part)
  view.webContents.once('did-finish-load', () => sendStateTo(view.webContents))
  return view
}

export function createOrbRailViews(): void {
  if (railView && dockView) return
  const win = getMainWindow()
  if (!win || win.isDestroyed()) return

  // 首次创建即对齐主题，供 did-finish-load 的首次状态推送携带
  lastState = { ...lastState, theme: readTheme() }

  if (!railView) {
    railView = makeView('rail')
    win.contentView.addChildView(railView)
  }
  if (!dockView) {
    dockView = makeView('dock')
    win.contentView.addChildView(dockView)
  }
  applyRailBounds()
  applyDockBounds()
  hookNativeTheme()
  // 窗口 resize 由 index.ts 统一调 layoutOrbRailViews()
  logInfo('orb', 'rail/dock views created')
}

/** system 模式下系统深浅翻转时，圆轨配色跟随（其它模式重算结果不变，广播会被去重） */
function hookNativeTheme(): void {
  if (themeHooked) return
  themeHooked = true
  nativeTheme.on('updated', () => setOrbTheme())
}

/** 插件视图挂载后调用：remove+re-add 把圆轨/设置钮重新放到最顶层 */
export function raiseOrbRailViews(): void {
  const win = getMainWindow()
  if (!win || win.isDestroyed()) return
  const cv = win.contentView
  for (const view of [railView, dockView]) {
    if (!view || !cv.children.includes(view)) continue
    cv.removeChildView(view)
    cv.addChildView(view)
  }
}

/** rail 视图展开/收起：切换宽度（renderer CSS 动画先行，这里跟进 bounds） */
export function setOrbRailExpandedView(expanded: boolean): void {
  const next = expanded === true
  if (railExpanded === next) return
  railExpanded = next
  applyRailBounds()
}

export function layoutOrbRailViews(): void {
  applyRailBounds()
  applyDockBounds()
}

export function setOrbRailState(state: OrbRailState): void {
  // animationLevel / theme 不信任 renderer：一律以 settingsStore 为准，
  // 避免主壳 hydrate 前的默认值覆盖真实档位/主题
  lastState = {
    ...state,
    animationLevel: readAnimLevel(),
    theme: readTheme(),
    // rail-entries 插槽贡献以主进程 contributions 表为唯一事实来源，不信任 renderer
    contribEntries: readRailContribEntries()
  }
  broadcastState()
  if (lastState.tabStyle === 'orb') {
    setPluginLeftInset(0)
  }
}

/**
 * rail-entries 插槽 → overlay 可消费的入口数组（数据层；DOM 渲染在
 * src/renderer/orb-overlay.ts，归后续批次接线）。跳过未安装/禁用插件的贡献。
 */
function readRailContribEntries(): OrbRailState['contribEntries'] {
  try {
    return listRailEntries()
      .filter((row) => {
        const summary = pluginRegistry.get(row.source)
        return Boolean(summary?.installed) && summary?.enabled !== false
      })
      .map((row) => ({
        id: row.id,
        pluginId: row.source,
        glyph: String(row.data?.glyph ?? '·').slice(0, 2),
        color: row.data?.color || '#5b8cff',
        title: row.data?.title || row.id,
        openCode: row.data?.openCode
      }))
  } catch {
    return []
  }
}

/** rail-entries 贡献变更（注册/卸载/禁用）后调用：重读插槽并广播给 overlay */
export function refreshOrbRailContribEntries(): void {
  const next = readRailContribEntries()
  if (JSON.stringify(next) === JSON.stringify(lastState.contribEntries)) return
  lastState = { ...lastState, contribEntries: next }
  broadcastState()
}

/** 设置页改动画档位：即时推给两个视图（独立文档不随主壳 data-anim 联动） */
export function setOrbAnimationLevel(level: AnimationLevel): void {
  if (!isAnimLevel(level) || lastState.animationLevel === level) return
  lastState = { ...lastState, animationLevel: level }
  broadcastState()
}

/** 主题变更（设置页 / 主题包 / 系统深浅翻转）：重解析并推给两个视图 */
export function setOrbTheme(): void {
  const next = readTheme()
  if (
    lastState.theme.mode === next.mode &&
    JSON.stringify(lastState.theme.tokens) === JSON.stringify(next.tokens)
  ) {
    return
  }
  lastState = { ...lastState, theme: next }
  broadcastState()
}

/** tabStyle 变化：orb 显示圆轨/设置钮（插件全宽）；classic 隐藏 */
export function applyOrbRailVisibility(tabStyle: 'classic' | 'orb'): void {
  lastState = { ...lastState, tabStyle, contribEntries: readRailContribEntries() }
  if (tabStyle === 'orb') {
    setPluginLeftInset(0)
    createOrbRailViews()
    if (railView) railView.setVisible(true)
    if (dockView) dockView.setVisible(true)
    raiseOrbRailViews()
  } else {
    if (railView) railView.setVisible(false)
    if (dockView) dockView.setVisible(false)
  }
}

export function destroyOrbRailViews(): void {
  const win = getMainWindow()
  if (win && !win.isDestroyed()) {
    for (const view of [railView, dockView]) {
      if (view) win.contentView.removeChildView(view)
    }
  }
  railView = null
  dockView = null
}
