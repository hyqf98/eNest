import { raiseTransientViews } from '@main/window/transientViews'
import { pathToFileURL } from 'node:url'
import { registerTrustedSurface } from '@main/ipc/ipcSecurity'
/**
 * orbRailViews — orb 圆轨 / classic 设置侧签（互斥的主窗口顶层 WebContentsView）
 * 取代独立透明子窗方案：视图内是真实 DOM 鼠标事件，无穿透转发、无窗口焦点/层级问题。
 * - orb 仅显示 rail：首页 → 插件/贡献入口 → 设置，左缘窄条收起为 ORB_RAIL_COLLAPSED_W，
 *   renderer hover 经 IPC 拓宽到 ORB_RAIL_EXPANDED_W（同进程 setBounds，约 1 帧）。
 * - classic 仅显示 dock：收起时只保留左下缘热区，进入后才拓宽原生视图。
 *   插件内容始终全宽渲染（inset 0）。
 * - z 序：WebContentsView 无显式置顶 API，插件视图挂载后需调 raiseOrbRailViews()
 *   按原生子视图顺序置顶，不摘除正在接收鼠标事件的轨道。
 */
import { app, nativeTheme, screen, WebContentsView, type WebPreferences } from 'electron'
import { join } from 'node:path'
import {
  ORB_RAIL_CAPTION_EXTRA_W,
  ORB_RAIL_COLLAPSED_W,
  ORB_RAIL_EXPANDED_W,
  SHELL_PARTITION,
  TITLEBAR_HEIGHT
} from '@shared/constants'
import { IpcChannels, type OrbRailProjection, type OrbRailState } from '@shared/types/ipc'
import type { HomeTabsSnapshot } from '@shared/types/home'
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
/*
 * 静态 import PluginHost 是安全的循环：本模块只在函数体内读 pluginHost，
 * 不在模块顶层求值；PluginHost 对本模块静态 import 的也只是函数（raiseOrbRailViews），
 * 两边在初始化期都不触碰对方的绑定。
 */
import { pluginHost } from '@main/plugin/PluginHost'
import { logWarn } from '@main/logs/logService'
import { selectThemeChrome, ThemeChromeSurface } from '@main/theme/themeChromeSurface'
import type { ThemeChromePart } from '@shared/types/themeChrome'
import { bindClassicDockReveal } from './classicDockReveal'
import { isWaylandWindowSystem } from './linuxWindowSystem'

let railView: WebContentsView | null = null
let dockView: WebContentsView | null = null
let classicView: WebContentsView | null = null
const customSurfaces = new Map<WebContentsView, ThemeChromeSurface>()
const pendingFallbacks = new Map<WebContentsView, WebContentsView>()
const dockReveals = new WeakMap<WebContentsView, ReturnType<typeof bindClassicDockReveal>>()
const failedSelections = new Map<ThemeChromePart, string>()
let unwatchPlugins: (() => void) | null = null
let railExpanded = false
/** 悬停名称浮层是否正在显示：显示时视图额外拓宽，让名称画在视图内部 */
let railCaptionOpen = false
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

/**
 * 首页自绘 Tab 条的投影（classic 模式）。
 *
 * 首页是铺满整窗的原生视图，会盖住主壳 DOM 标题栏，所以主壳那排 Tab 在首页看不见，
 * 由首页自己画一条。数据源**直接读宿主实时状态**，而不是 lastState：
 *
 * lastState.tabs 要经过「主进程发 plugin-tabs → 主壳 store 更新 → 回推
 * shell:sync-orb-state → setOrbRailState」一次完整往返才被填上。首页往往在这次
 * 往返完成前就 ready 了，于是首屏拉到空投影——用户看到的就是"刷新进入首页没有
 * Tab 条，切去设置再回来才有"。直读 PluginHost 没有这个空窗。
 *
 * tabStyle / view / activeTabId 仍取 lastState：它们是主壳视图状态，宿主实时值就是它。
 */
export function buildHomeTabsSnapshot(): HomeTabsSnapshot {
  return {
    tabStyle: lastState.tabStyle,
    view: lastState.view,
    activeTabId: lastState.activeTabId,
    tabs: pluginHost.listTabs()
  }
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
    caption: setOrbRailCaptionOpen,
    refreshPointer: refreshOrbRailPointer,
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

/** 圆轨停靠边：以主题解析结果为准（settingsStore 唯一事实来源），缺省左侧 */
function readOrbDock(): 'left' | 'right' {
  try {
    return readTheme().appearance?.layout.orbDock === 'right' ? 'right' : 'left'
  } catch {
    return 'left'
  }
}

/**
 * 持久化圆轨停靠边：写内置主题 profile 的 orbDock 字段。
 * 设置页的「圆轨停靠」与拖拽换边共用这一份数据，不存在第二套停靠状态。
 * appearanceService 广播新快照后，applyRailBounds 会按新值重排原生视图。
 */
export async function setOrbDockSide(dock: 'left' | 'right'): Promise<void> {
  if (dock !== 'left' && dock !== 'right') throw new Error('Invalid orb dock side')
  const { appearanceService } = await import('@main/theme/appearanceService')
  const { DEFAULT_THEME_IDENTITY } = await import('@shared/theme/builtinThemes')
  const snapshot = appearanceService.getAppearanceSnapshot()
  const pack = snapshot.packs.find(candidate =>
    candidate.source === DEFAULT_THEME_IDENTITY.source && candidate.id === DEFAULT_THEME_IDENTITY.id)
  if (!pack) throw new Error('Host navigation settings are unavailable')
  const field = pack.settings.groups.flatMap(group => group.fields)
    .find(candidate => candidate.binding.target === 'layout' && candidate.binding.key === 'orbDock')
  if (!field) throw new Error('orbDock binding is unavailable')
  appearanceService.updateThemeProfile({ theme: DEFAULT_THEME_IDENTITY, values: { [field.key]: dock } })
}

function applyRailBounds(): void {
  if (!railView) return
  const b = getShellBounds()
  const baseWidth = railExpanded ? ORB_RAIL_EXPANDED_W : ORB_RAIL_COLLAPSED_W
  // 悬停名称浮层需要额外的横向空间：WebContentsView 里的 DOM 画不出视图边界，
  // 所以只能把视图本身临时拓宽。只在展开态才有意义（收起态没有条目可悬停）。
  const width = railCaptionOpen && railExpanded ? baseWidth + ORB_RAIL_CAPTION_EXTRA_W : baseWidth
  // orb 的设置入口在 rail 末尾，不再为独立 dock 预留底部空间。
  const height = Math.max(120, b.height - TITLEBAR_HEIGHT)
  // 右侧停靠时视图贴右缘：展开区向窗口内侧生长，收起条留在最右侧。
  const x = readOrbDock() === 'right' ? Math.max(0, b.width - width) : 0
  railView.setBounds({ x, y: TITLEBAR_HEIGHT, width, height })
  pendingFallbacks.get(railView)?.setBounds(railView.getBounds())
}

function applyDockBounds(): void {
  const win = getMainWindow()
  if (!win || win.isDestroyed() || !dockView) return
  for (const view of [dockView, pendingFallbacks.get(dockView)]) {
    if (!view || view.webContents.isDestroyed()) continue
    let reveal = dockReveals.get(view)
    if (!reveal) {
      reveal = bindClassicDockReveal(win, view)
      dockReveals.set(view, reveal)
    }
    reveal.layout()
  }
}

/** URL query 携带 part / 动画档位 / 主题模式 / 停靠边：首帧即正确，无闪变 */
function loadPart(view: WebContentsView, part: 'rail' | 'dock'): void {
  const anim = readAnimLevel()
  const themeMode = readTheme().mode
  const dock = readOrbDock()
  const devUrl = process.env.ELECTRON_RENDERER_URL
  if (devUrl) {
    const base = devUrl.replace(/\/$/, '')
    const url = `${base}/orb-overlay.html?part=${part}&anim=${encodeURIComponent(anim)}&theme=${themeMode}&dock=${dock}`
    registerTrustedSurface(view.webContents, part === 'dock' ? 'dock' : 'orb', url)
    void view.webContents.loadURL(url).catch(error => logWarn('chrome', `${part} load failed: ${String(error)}`))
  } else {
    const file = join(app.getAppPath(), 'out', 'renderer', 'orb-overlay.html')
    registerTrustedSurface(view.webContents, part === 'dock' ? 'dock' : 'orb', pathToFileURL(file).href)
    void view.webContents.loadFile(file, {
      query: { part, anim, theme: themeMode, dock }
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
    preload: resolvePreload(part === 'rail' ? 'railPreload.js' : 'dockPreload.js'),
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

/** 插件视图挂载后，导航位于插件之上、原生临时表面之下。 */
export function raiseOrbRailViews(): void {
  const win = getMainWindow()
  if (!win || win.isDestroyed()) return
  const chrome = [...pendingFallbacks.values(), railView, dockView, classicView]
    .filter((view): view is WebContentsView => !!view && !view.webContents.isDestroyed() && view.getVisible())
  raiseTransientViews(win, chrome)
}

function readRailPointer(win: Electron.BaseWindow) {
  if (isWaylandWindowSystem()) return null
  try {
    const cursor = screen.getCursorScreenPoint(), area = win.getContentBounds()
    const x = cursor.x - area.x, y = cursor.y - area.y
    return Number.isFinite(x) && Number.isFinite(y) ? { x, y, inWindow: x >= 0 && x < area.width && y >= 0 && y < area.height } : null
  } catch { return null }
}

export function refreshOrbRailPointer(sender: Electron.WebContents): void {
  const win = getMainWindow()
  if (!win || win.isDestroyed() || !win.isFocused() || win.isMinimized() || !win.isVisible()
    || !chromeVisible || chromeSuspensions.size || !railExpanded || lastState.tabStyle !== 'orb' || !railView || sender.isDestroyed()) return
  const view = railView.webContents === sender ? railView : pendingFallbacks.get(railView)
  if (!view || view.webContents !== sender || !view.getVisible()) return
  try {
    const pointer = readRailPointer(win)
    if (!pointer?.inWindow || dragExpansionCount) return
    const { x, y } = pointer, bounds = view.getBounds()
    const local = { x: x - bounds.x, y: y - bounds.y }
    const width = Math.min(bounds.width, ORB_RAIL_EXPANDED_W)
    const left = readOrbDock() === 'right' ? bounds.width - width : 0
    if (!(local.x >= left && local.x < left + width && local.y >= 0 && local.y < bounds.height)) return
    const children = win.contentView.children, index = children.indexOf(view)
    if (index < 0 || children.slice(index + 1).some(child => {
      if (!child.getVisible()) return false
      const area = child.getBounds()
      return x >= area.x && x < area.x + area.width && y >= area.y && y < area.y + area.height
    })) return
    sender.sendInputEvent({ type: 'mouseMove', ...local })
  } catch { /* 视图可能正在销毁 */ }
}

/** rail 视图展开/收起：切换宽度（renderer CSS 动画先行，这里跟进 bounds） */
export function setOrbRailExpandedView(expanded: boolean): void {
  const next = expanded === true || dragExpansionCount > 0
  if (railExpanded === next) return
  railExpanded = next
  // 收起时条目不可见，名称浮层必须一并释放，否则收窄视图后仍占着加宽态。
  if (!next && railCaptionOpen) { railCaptionOpen = false; stopCaptionWatchdog() }
  applyRailBounds()
}

/**
 * 悬停名称浮层开合：临时把 rail 视图拓宽，让名称文字画在视图内部。
 * 只在展开态生效——收起态没有可悬停的条目，也没有名称可显示。
 * 用独立于 expand 的状态位，避免和展开/收起动画互相打断。
 */
export function setOrbRailCaptionOpen(open: boolean): void {
  const next = open === true && railExpanded
  if (railCaptionOpen === next) return
  railCaptionOpen = next
  applyRailBounds()
  if (next) startCaptionWatchdog()
  else stopCaptionWatchdog()
}

/** 名称浮层当前是否占用加宽态（供诊断/测试） */
export function isOrbRailCaptionOpen(): boolean {
  return railCaptionOpen
}

/**
 * 拓宽期间的光标看门狗。
 *
 * 为什么需要：拓宽后的视图会盖住轨道右侧一块插件区域。指针如果直接向右移出，
 * renderer 可能收不到 pointerout（视口变大时鼠标仍在视图内），浮层会残留、
 * 视图一直占着加宽尺寸。主进程按光标屏幕坐标独立判定，一旦离开轨道矩形就收回，
 * 不依赖 renderer 事件是否送达。
 */
const CAPTION_WATCH_MS = 120
let captionWatchdog: NodeJS.Timeout | null = null

function startCaptionWatchdog(): void {
  if (captionWatchdog || isWaylandWindowSystem()) return
  captionWatchdog = setInterval(() => {
    if (!railCaptionOpen || !railView || railView.webContents.isDestroyed()) { stopCaptionWatchdog(); return }
    const bounds = railView.getBounds()
    const win = getMainWindow()
    if (!win || win.isDestroyed() || !win.isVisible() || win.isMinimized()) { stopCaptionWatchdog(); return }
    const pointer = readRailPointer(win)
    if (!pointer) { stopCaptionWatchdog(); return }
    if (pointer.inWindow && pointer.x >= bounds.x - 4 && pointer.x <= bounds.x + bounds.width + 4
      && pointer.y >= bounds.y - 4 && pointer.y <= bounds.y + bounds.height + 4) return
    // 光标已离开：通知 overlay 收起，并立刻还原宽度（不等 renderer 往返）。
    railCaptionOpen = false
    applyRailBounds()
    stopCaptionWatchdog()
    // 复用既有 orb 事件通道，语义：宿主已收回拓宽，overlay 同步收起浮层。
    const owner = pendingFallbacks.get(railView) ?? railView
    if (!owner.webContents.isDestroyed()) owner.webContents.send(IpcChannels.ShellOrbEvent, { type: 'orb-caption-close' })
  }, CAPTION_WATCH_MS)
  captionWatchdog.unref?.()
}

function stopCaptionWatchdog(): void {
  if (!captionWatchdog) return
  clearInterval(captionWatchdog)
  captionWatchdog = null
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
  /*
   * 首页自绘 Tab 条也吃这份数据，必须一起刷新。
   *
   * 首页通常比主壳先就绪，它启动时 getTabs() 拿到的是空投影；之后主壳 hydrate
   * 通过 shell:sync-orb-state 推来真实 tabs，如果这里不通知首页，Tab 条会一直是空的
   * ——表现为"进设置再回首页才显示"（那次往返触发了重新拉取）。
   * 用动态 import 断开与 HomeSurfaceManager 的静态依赖环。
   */
  void import('@main/home/HomeSurfaceManager')
    .then(({ homeSurfaceManager }) => homeSurfaceManager.publishTabs())
    .catch(() => undefined)
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
  // 停靠边（orbDock）属于原生 bounds 的事实：换边后必须立即重算视图位置，
  // 只靠 renderer 的镜像 CSS 会让原生视图仍贴在旧侧。
  applyRailBounds()
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
  // 轨道被隐藏或切到 classic 时，名称浮层的拓宽态与看门狗必须一并释放，
  // 否则隐藏期间定时器仍在按不可见视图的 bounds 判定光标。
  if ((!visible || lastState.tabStyle !== 'orb') && railCaptionOpen) {
    railCaptionOpen = false
    stopCaptionWatchdog()
  }
  // 先隐藏另一模式的视图，再创建或显示当前视图，避免切换时两者同时出现。
  if (!visible || lastState.tabStyle !== 'orb') railView?.setVisible(false)
  if ((!visible || lastState.tabStyle !== 'classic') && dockView) {
    for (const view of [dockView, pendingFallbacks.get(dockView)]) {
      if (!view) continue
      view.setVisible(false)
      dockReveals.get(view)?.reset()
    }
  }
  if (!visible || lastState.tabStyle !== 'classic') classicView?.setVisible(false)
  if (!visible) for (const fallback of pendingFallbacks.values()) fallback.setVisible(false)
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

/** App 门禁控制原生 chrome；orb 仅 rail，classic 仅设置 dock。 */
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
  // 视图销毁后必须停掉光标看门狗并清掉拓宽态，否则定时器会去读已销毁的视图。
  railCaptionOpen = false
  stopCaptionWatchdog()
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
