import { raiseTransientViews } from '@main/window/transientViews'
import { pathToFileURL } from 'node:url'
import { registerTrustedSurface } from '@main/ipc/ipcSecurity'
/**
 * orbRailViews — orb 圆轨 / classic 常驻设置钮（互斥的主窗口顶层 WebContentsView）
 * 取代独立透明子窗方案：视图内是真实 DOM 鼠标事件，无穿透转发、无窗口焦点/层级问题。
 * - orb 仅显示 rail：首页 → 插件/贡献入口 → 设置，左缘窄条收起为 ORB_RAIL_COLLAPSED_W，
 *   renderer hover 经 IPC 拓宽到 ORB_RAIL_EXPANDED_W（同进程 setBounds，约 1 帧）。
 * - classic 仅显示 dock：固定 80×72 贴左下，头像设置钮常驻，18px 内间距由 CSS 提供。
 *   插件内容始终全宽渲染（inset 0）。
 * - z 序：WebContentsView 无显式置顶 API，插件视图挂载后需调 raiseOrbRailViews()
 *   以 remove+re-add 置顶（electron#42061）。
 */
import { app, nativeTheme, WebContentsView, type WebPreferences } from 'electron'
import { join } from 'node:path'
import {
  ORB_DOCK_VIEW_H,
  ORB_DOCK_VIEW_W,
  ORB_RAIL_COLLAPSED_W,
  ORB_RAIL_EXPANDED_W,
  SHELL_PARTITION,
  TITLEBAR_HEIGHT
} from '@shared/constants'
import { IpcChannels, type OrbRailProjection, type OrbRailState } from '@shared/types/ipc'
import type { AnimationLevel } from '@shared/types/plugin'
import {
  getMainWindow,
  getShellBounds,
  getPluginTopInset,
  resolvePreload,
  sendShellEvent,
  setPluginLeftInset
} from '@main/window/createShellWindow'
import { settingsStore } from '@main/settings/SettingsStore'
import { resolveThemeTokens, type ResolvedThemeCss } from '@main/theme/resolveThemeCss'
import { readRailContributionEntries } from '@main/contrib/railContributions'
import { pluginRegistry } from '@main/plugin/PluginRegistry'
import { logWarn } from '@main/logs/logService'
import { selectThemeChrome, ThemeChromeSurface } from '@main/theme/themeChromeSurface'
import type { ThemeChromePart } from '@shared/types/themeChrome'

let railView: WebContentsView | null = null
let dockView: WebContentsView | null = null
let classicView: WebContentsView | null = null
const customSurfaces = new Map<WebContentsView, ThemeChromeSurface>()
const pendingFallbacks = new Map<WebContentsView, WebContentsView>()
const failedSelections = new Map<ThemeChromePart, string>()
let unwatchPlugins: (() => void) | null = null
let railExpanded = false
let dragExpansionCount = 0
let themeHooked = false
// App owns the launch/preview gate; changing tab style must never reopen that gate.
let chromeVisible = false
const chromeSuspensions = new Set<symbol>()
const onNativeThemeUpdated = (): void => setOrbTheme()

let lastState: OrbRailState = {
  view: 'home',
  tabStyle: 'classic',
  activeTabId: null,
  animationLevel: 'medium',
  theme: { mode: 'light', tokens: {} },
  profile: null,
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
    const effective = readTheme().appearance?.animation.effective
    if (effective) return effective
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

/** Use the host-cached avatar; the settings surface never fetches account images. */
function readProfile(): OrbRailState['profile'] {
  try {
    const user = settingsStore.getAll().profile?.user
    if (!user || typeof user.login !== 'string') return null
    return { name: user.name || user.login, avatar: user.avatarDataUrl ?? null }
  } catch {
    return null
  }
}

function sendStateTo(wc: { isDestroyed(): boolean; send(channel: string, payload: unknown): void }): void {
  if (wc.isDestroyed()) return
  wc.send(IpcChannels.ShellOrbEvent, { type: 'orb-state', state: lastState })
}

function broadcastState(): void {
  for (const view of [railView, dockView, classicView, ...pendingFallbacks.values()]) {
    if (!view) continue
    const custom = customSurfaces.get(view)
    if (custom) custom.publish()
    else sendStateTo(view.webContents)
  }
  sendShellEvent({ type: 'theme-chrome-status', surface: 'classic', ready: !!classicView && customSurfaces.get(classicView)?.isReady() === true })
}

function disposeChromeView(view: WebContentsView | null): void {
  if (!view) return
  const fallback = pendingFallbacks.get(view)
  pendingFallbacks.delete(view)
  if (fallback) disposeChromeView(fallback)
  const win = getMainWindow()
  if (win && !win.isDestroyed() && win.contentView.children.includes(view)) win.contentView.removeChildView(view)
  const custom = customSurfaces.get(view)
  if (custom) { customSurfaces.delete(view); custom.dispose() }
  else if (!view.webContents.isDestroyed()) view.webContents.close({ waitForBeforeUnload: false })
}

function availableSelection(part: ThemeChromePart) {
  const selected = selectThemeChrome(part)
  if (selected?.signature === failedSelections.get(part)) return null
  return selected
}

function reconcileChromeViews(): void {
  for (const [part, view] of [['rail', railView], ['dock', dockView], ['classic', classicView]] as const) {
    if (!view) continue
    const activeMode = part === 'rail' ? lastState.tabStyle === 'orb' : lastState.tabStyle === 'classic'
    const selection = availableSelection(part)
    if (!activeMode || view.webContents.isDestroyed() || (customSurfaces.get(view)?.signature ?? null) !== (selection?.signature ?? null)) {
      // Keep an already rendered builtin when a pending custom document fails.
      const fallback = activeMode && !selection ? pendingFallbacks.get(view) ?? null : null
      if (fallback) pendingFallbacks.delete(view)
      disposeChromeView(view)
      if (part === 'rail') railView = fallback
      else if (part === 'dock') dockView = fallback
      else classicView = null
    }
  }
}

function makeCustomView(part: ThemeChromePart): WebContentsView | null {
  const selected = availableSelection(part)
  if (!selected) return null
  const surface = new ThemeChromeSurface(part, selected, {
    state: () => lastState,
    active: () => chromeVisible && chromeSuspensions.size === 0 && (part === 'rail' ? lastState.tabStyle === 'orb' : lastState.tabStyle === 'classic'),
    expand: setOrbRailExpandedView,
    changed: () => syncChromeVisibility(),
    failed: signature => {
      failedSelections.set(part, signature)
      queueMicrotask(() => syncChromeVisibility())
    }
  })
  customSurfaces.set(surface.view, surface)
  return surface.view
}

function applyClassicBounds(): void {
  if (!classicView) return
  const bounds = getShellBounds()
  // Traffic controls and a narrow native move region always remain host-owned.
  classicView.setBounds({ x: 96, y: 0, width: Math.max(1, bounds.width - 120), height: TITLEBAR_HEIGHT })
}

function applyRailBounds(): void {
  if (!railView) return
  const b = getShellBounds()
  const width = railExpanded ? ORB_RAIL_EXPANDED_W : ORB_RAIL_COLLAPSED_W
  // orb 的设置入口在 rail 末尾，不再为独立 dock 预留底部空间。
  const height = Math.max(120, b.height - TITLEBAR_HEIGHT)
  railView.setBounds({ x: 0, y: TITLEBAR_HEIGHT, width, height })
  pendingFallbacks.get(railView)?.setBounds(railView.getBounds())
}

function applyDockBounds(): void {
  if (!dockView) return
  const b = getShellBounds()
  // classic 原生命中区固定贴左下；按钮的 18px 内间距由 overlay CSS 提供。
  dockView.setBounds({
    x: 0,
    y: Math.max(TITLEBAR_HEIGHT, b.height - ORB_DOCK_VIEW_H),
    width: ORB_DOCK_VIEW_W,
    height: ORB_DOCK_VIEW_H
  })
  pendingFallbacks.get(dockView)?.setBounds(dockView.getBounds())
}

/** URL query 携带 part / 动画档位 / 主题模式：首帧即正确，无 medium 或浅色闪变 */
function loadPart(view: WebContentsView, part: 'rail' | 'dock'): void {
  const anim = readAnimLevel()
  const themeMode = readTheme().mode
  const devUrl = process.env.ELECTRON_RENDERER_URL
  if (devUrl) {
    const base = devUrl.replace(/\/$/, '')
    const url = `${base}/orb-overlay.html?part=${part}&anim=${encodeURIComponent(anim)}&theme=${themeMode}`
    registerTrustedSurface(view.webContents, part === 'dock' ? 'dock' : 'orb', url)
    void view.webContents.loadURL(url).catch(error => logWarn('chrome', `${part} load failed: ${String(error)}`))
  } else {
    const file = join(app.getAppPath(), 'out', 'renderer', 'orb-overlay.html')
    registerTrustedSurface(view.webContents, part === 'dock' ? 'dock' : 'orb', pathToFileURL(file).href)
    void view.webContents.loadFile(file, {
      query: { part, anim, theme: themeMode }
    }).catch(error => logWarn('chrome', `${part} load failed: ${String(error)}`))
  }
}

function makeView(part: 'rail' | 'dock'): WebContentsView {
  const custom = makeCustomView(part)
  if (custom) {
    const fallback = makeBuiltinView(part)
    pendingFallbacks.set(custom, fallback)
    getMainWindow()?.contentView.addChildView(fallback)
    return custom
  }
  return makeBuiltinView(part)
}

function makeBuiltinView(part: 'rail' | 'dock'): WebContentsView {
  // WebContentsView 默认不透明（electron#44914）：透明底需要 RGBA 全零 backgroundColor。
  // WebPreferences 类型未收该键，但运行时支持（官方迁移指南），故用交叉类型显式传入
  const prefs: WebPreferences & { backgroundColor?: string } = {
    backgroundColor: '#00000000',
    preload: resolvePreload('shellPreload.js'),
    contextIsolation: true,
    nodeIntegration: false,
    sandbox: true,
    partition: SHELL_PARTITION
  }
  const view = new WebContentsView({ webPreferences: prefs })
  // Creation/attachment must not flash chrome through a launch screen or native modal.
  view.setVisible(false)
  try {
    view.setBackgroundColor('#00000000')
  } catch {
    /* 个别平台不支持方法调用时，构造参数已兜底 */
  }
  view.webContents.on('did-finish-load', () => {
    sendStateTo(view.webContents)
    syncChromeVisibility()
  })
  loadPart(view, part)
  return view
}

export function createOrbRailViews(): void {
  const win = getMainWindow()
  if (!win || win.isDestroyed()) return
  reconcileChromeViews()

  // 首次创建即对齐主题与账号资料，供 did-finish-load 的首次状态推送携带
  lastState = { ...lastState, theme: readTheme(), profile: readProfile() }

  // 只懒创建当前模式需要的视图；切换后保留的另一视图由可见性门禁隐藏。
  if (lastState.tabStyle === 'orb' && !railView) {
    railView = makeView('rail')
    win.contentView.addChildView(railView)
  } else if (lastState.tabStyle === 'classic' && !dockView) {
    dockView = makeView('dock')
    win.contentView.addChildView(dockView)
  }
  if (lastState.tabStyle === 'classic' && !classicView) {
    classicView = makeCustomView('classic')
    if (classicView) win.contentView.addChildView(classicView)
  }
  applyRailBounds()
  applyDockBounds()
  applyClassicBounds()
  hookNativeTheme()
  unwatchPlugins ??= pluginRegistry.onInstalledChanged(() => syncChromeVisibility())
  // 窗口 resize 由 index.ts 统一调 layoutOrbRailViews()
}

/** system 模式下系统深浅翻转时，圆轨配色跟随（其它模式重算结果不变，广播会被去重） */
function hookNativeTheme(): void {
  if (themeHooked) return
  themeHooked = true
  nativeTheme.on('updated', onNativeThemeUpdated)
}

/** 插件视图挂载后调用：remove+re-add 把圆轨/设置钮重新放到最顶层 */
export function raiseOrbRailViews(): void {
  const win = getMainWindow()
  if (!win || win.isDestroyed()) return
  const cv = win.contentView
  for (const view of [...pendingFallbacks.values(), railView, dockView, classicView]) {
    if (!view || !view.getVisible() || view.webContents.isDestroyed() || !cv.children.includes(view)) continue
    cv.removeChildView(view)
    cv.addChildView(view)
  }
  raiseTransientViews(win)
}

/** rail 视图展开/收起：切换宽度（renderer CSS 动画先行，这里跟进 bounds） */
export function setOrbRailExpandedView(expanded: boolean): void {
  const next = expanded === true || dragExpansionCount > 0
  if (railExpanded === next) return
  railExpanded = next
  applyRailBounds()
}

export function layoutOrbRailViews(): void {
  applyRailBounds()
  applyDockBounds()
  applyClassicBounds()
  if (classicView) classicView.setVisible(chromeVisible && chromeSuspensions.size === 0 && lastState.tabStyle === 'classic' && getPluginTopInset() === 0 && customSurfaces.get(classicView)?.isReady() === true)
  raiseOrbRailViews()
}

export function setOrbRailState(state: OrbRailProjection): void {
  // animationLevel / theme / profile 不信任 renderer：一律以 settingsStore 为准，
  // 避免主壳 hydrate 前的默认值覆盖真实档位/主题
  const next = {
    ...state,
    animationLevel: readAnimLevel(),
    theme: readTheme(),
    profile: readProfile(),
    // rail-entries 插槽贡献以主进程 contributions 表为唯一事实来源，不信任 renderer
    contribEntries: readRailContribEntries()
  }
  if (JSON.stringify(next) === JSON.stringify(lastState)) return
  lastState = next
  broadcastState()
  if (lastState.tabStyle === 'orb') {
    setPluginLeftInset(0)
  }
}

/**
 * rail-entries 插槽 → orb-overlay 的入口数组。跳过未安装/禁用插件的贡献。
 */
function readRailContribEntries(): OrbRailState['contribEntries'] {
  try {
    return readRailContributionEntries()
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
  const tabStyle = next.appearance?.layout.tabStyle ?? lastState.tabStyle
  if (
    lastState.tabStyle === tabStyle &&
    lastState.theme.mode === next.mode &&
    JSON.stringify(lastState.theme.tokens) === JSON.stringify(next.tokens) &&
    lastState.theme.appearance?.revision === next.appearance?.revision
  ) {
    return
  }
  lastState = { ...lastState, tabStyle, theme: next, animationLevel: next.appearance?.animation.effective ?? lastState.animationLevel }
  broadcastState()
  // 全局导航偏好变更不能越过 App 门禁或原生模态暂停。
  syncChromeVisibility()
}

/** 账号资料变化（GitHub 登录 / 刷新 / 退出）：dock 头像即时更新 */
export function setOrbProfile(profile: OrbRailState['profile']): void {
  if (JSON.stringify(lastState.profile) === JSON.stringify(profile)) return
  lastState = { ...lastState, profile }
  broadcastState()
}

function syncChromeVisibility(): void {
  reconcileChromeViews()
  const visible = chromeVisible && chromeSuspensions.size === 0
  if (railView?.webContents.isDestroyed()) railView = null
  if (dockView?.webContents.isDestroyed()) dockView = null
  // 先隐藏另一模式的视图，再创建或显示当前视图，避免切换时两者同时出现。
  if (!visible || lastState.tabStyle !== 'orb') railView?.setVisible(false)
  if (!visible || lastState.tabStyle !== 'classic') dockView?.setVisible(false)
  if (!visible || lastState.tabStyle !== 'classic') classicView?.setVisible(false)
  for (const fallback of pendingFallbacks.values()) fallback.setVisible(false)
  sendShellEvent({ type: 'theme-chrome-status', surface: 'classic', ready: !!classicView && customSurfaces.get(classicView)?.isReady() === true })
  if (!visible) return
  createOrbRailViews()
  const view = lastState.tabStyle === 'orb' ? railView : dockView
  if (view) view.setVisible(!customSurfaces.has(view) || customSurfaces.get(view)!.isReady())
  if (view) {
    const fallback = pendingFallbacks.get(view)
    if (fallback && customSurfaces.get(view)?.isReady()) {
      pendingFallbacks.delete(view)
      disposeChromeView(fallback)
    } else fallback?.setVisible(true)
  }
  if (classicView) classicView.setVisible(getPluginTopInset() === 0 && customSurfaces.get(classicView)?.isReady() === true)
  raiseOrbRailViews()
}

/** App 门禁控制原生 chrome；orb 仅 rail，classic 仅常驻设置 dock。 */
export function applyOrbRailVisibility(tabStyle: 'classic' | 'orb', visible: boolean): void {
  chromeVisible = visible
  lastState = { ...lastState, tabStyle, contribEntries: readRailContribEntries() }
  setPluginLeftInset(0)
  syncChromeVisibility()
}

/** Native modals temporarily mask chrome without changing App's launch/preview gate. */
export function suspendOrbRailViews(): () => void {
  const token = Symbol('native-modal')
  chromeSuspensions.add(token)
  syncChromeVisibility()
  return () => {
    if (chromeSuspensions.delete(token)) syncChromeVisibility()
  }
}

export function destroyOrbRailViews(): void {
  for (const view of [railView, dockView, classicView]) disposeChromeView(view)
  railView = null
  dockView = null
  classicView = null
  failedSelections.clear()
  unwatchPlugins?.()
  unwatchPlugins = null
  railExpanded = false
  dragExpansionCount = 0
  chromeVisible = false
  chromeSuspensions.clear()
  if (themeHooked) nativeTheme.removeListener('updated', onNativeThemeUpdated)
  themeHooked = false
}

/** Host drag geometry is resolved from native Views, never a renderer-supplied origin. */
export function getOrbDragSurface(wcId: number) {
  const window = getMainWindow()
  if (!window || window.isDestroyed() || !chromeVisible || chromeSuspensions.size || lastState.tabStyle !== 'orb') return null
  const native = railView ? pendingFallbacks.get(railView) ?? railView : null
  const view = native?.getVisible() && native.webContents.id === wcId && !customSurfaces.has(native) ? native : null
  return view ? { window, view } : null
}
export function acquireOrbDragExpansion(): () => void {
  dragExpansionCount++
  setOrbRailExpandedView(true)
  let released = false
  return () => {
    if (released) return
    released = true
    dragExpansionCount = Math.max(0, dragExpansionCount - 1)
    if (!dragExpansionCount) setOrbRailExpandedView(false)
  }
}
