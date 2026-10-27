/**
 * panelWindows — 自由面板的原生窗口与 chrome 表面
 * 职责：创建/销毁面板窗口（无边框、透明、置顶）、挂载 chrome WebContentsView、
 *      应用材质与外观、按组件矩形排布插件原生视图。
 * 关键约束：
 *  - 本模块**不 import PanelManager**；窗口事件通过回调注册，由 Manager 订阅。
 *  - 本模块**不 import PluginHost**；插件视图的挂载/布局由 Manager 通过窄接口驱动。
 *  - 拖动期间不得改动 alwaysOnTop / vibrancy / backgroundMaterial，也不得重建 child view。
 * 被 PanelManager 调用；自身只持有原生对象。
 */
import { app, BaseWindow, screen, View, WebContentsView } from 'electron'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { SHELL_PARTITION } from '@shared/constants'
import { IpcChannels } from '@shared/types/ipc'
import {
  PANEL_MAX_WIDGETS,
  PANEL_MIN_HEIGHT,
  PANEL_MIN_WIDTH,
  PANEL_WIDGET_BAR_HEIGHT,
  PANEL_WIDGET_INSET,
  type PanelAppearance,
  type PanelBounds,
  type PanelDragFeedback,
  type PanelState,
  type PanelWidgetRect,
  type PanelWidgetState
} from '@shared/types/panel'
import { registerTrustedSurface, revokeTrustedSurface } from '@main/ipc/ipcSecurity'
import { resolvePreload } from '@main/window/createShellWindow'
import { resolveThemeTokens } from '@main/theme/resolveThemeCss'
import { raiseTransientViews } from '@main/window/transientViews'
import { logWarn } from '@main/logs/logService'
import { toIntegerRect } from '@main/panel/panelGeometry'

/** 面板圆角（与 CSS --panel-radius 视觉一致；容器 View 负责裁切）。 */
const PANEL_CORNER_RADIUS = 14

/** 面板窗口记录；只保存原生对象与当前快照。 */
export interface PanelWindowRecord {
  id: string
  window: BaseWindow
  chrome: WebContentsView
  /** 承载 chrome + 插件视图的容器；圆角与裁剪挂在它上面。 */
  container: View
  state: PanelState
  /** chrome 是否已加载完成（未完成前不推送 state）。 */
  ready: boolean
  /** 关闭流程进行中：阻止窗口事件再次触发 close。 */
  closing: boolean
  removeListeners: () => void
}

export interface PanelWindowHost {
  /** 窗口几何变化（用户拖动/缩放面板窗口）。 */
  geometryChanged(id: string, bounds: PanelBounds): void
  /** 窗口被用户关闭（Cmd+W / 关闭按钮）。 */
  closeRequested(id: string): void
}

const records = new Map<string, PanelWindowRecord>()
let host: PanelWindowHost | null = null
let nativeListenerUsers = 0

export function bindPanelWindowHost(value: PanelWindowHost | null): void {
  host = value
}

export function getPanelWindowRecord(id: string): PanelWindowRecord | undefined {
  return records.get(id)
}

export function getPanelWindow(id: string): BaseWindow | null {
  return records.get(id)?.window ?? null
}

export function getPanelContentParent(id: string): View | null {
  return records.get(id)?.container ?? null
}

export function getPanelChrome(id: string): WebContentsView | null {
  return records.get(id)?.chrome ?? null
}

/** 由 wcId 反查面板（拖拽落点与 IPC 校验用）。 */
export function getPanelForSender(wcId: number): string | null {
  for (const record of records.values()) {
    if (!record.chrome.webContents.isDestroyed() && record.chrome.webContents.id === wcId) return record.id
  }
  return null
}

/** 由原生窗口反查面板 id：跨窗口拖入（Tab/独立窗口 → 面板）的落点判定走这里。 */
export function getPanelIdForWindow(win: BaseWindow): string | null {
  if (win.isDestroyed()) return null
  for (const record of records.values()) {
    if (!record.window.isDestroyed() && record.window === win) return record.id
  }
  return null
}

/** 面板内容区的屏幕绝对矩形 + chrome 的 wcId，供跨窗口拖入的落点判定与反馈广播。 */
export function getPanelSurfaceBounds(panelId: string): { x: number; y: number; width: number; height: number; senderId: number } | null {
  const record = records.get(panelId)
  if (!record || record.window.isDestroyed() || record.chrome.webContents.isDestroyed()) return null
  const content = record.window.getContentBounds()
  return { ...content, senderId: record.chrome.webContents.id }
}

/** 面板内容区尺寸（DIP）。 */
export function getPanelContentSize(id: string): { width: number; height: number } {
  const record = records.get(id)
  if (!record || record.window.isDestroyed()) return { width: PANEL_MIN_WIDTH, height: PANEL_MIN_HEIGHT }
  const { width, height } = record.window.getContentBounds()
  return { width: Math.max(1, width), height: Math.max(1, height) }
}

/** 组件矩形 → 插件原生视图矩形（去掉组件条与内缩）。 */
export function widgetViewBounds(rect: PanelWidgetRect): PanelWidgetRect {
  return toIntegerRect({
    x: rect.x + PANEL_WIDGET_INSET,
    y: rect.y + PANEL_WIDGET_BAR_HEIGHT + PANEL_WIDGET_INSET,
    width: rect.width - PANEL_WIDGET_INSET * 2,
    height: rect.height - PANEL_WIDGET_BAR_HEIGHT - PANEL_WIDGET_INSET * 2
  })
}

/** 把面板矩形钳制到所在显示器的工作区，避免窗口跑到屏幕外。 */
export function constrainPanelBounds(bounds: PanelBounds): PanelBounds {
  const display = bounds.displayId >= 0
    ? screen.getAllDisplays().find(item => item.id === bounds.displayId) ?? screen.getDisplayMatching(bounds)
    : screen.getDisplayMatching(bounds)
  const area = display.workArea
  const width = Math.max(PANEL_MIN_WIDTH, Math.min(Math.round(bounds.width), area.width))
  const height = Math.max(PANEL_MIN_HEIGHT, Math.min(Math.round(bounds.height), area.height))
  return {
    x: Math.round(Math.max(area.x, Math.min(bounds.x, area.x + area.width - width))),
    y: Math.round(Math.max(area.y, Math.min(bounds.y, area.y + area.height - height))),
    width,
    height,
    displayId: display.id
  }
}

function onDisplaysChanged(): void {
  for (const record of records.values()) {
    if (record.window.isDestroyed()) continue
    const current = record.window.getBounds()
    // 显示器拓扑变化后按「当前所在屏幕」重新钳制；displayId 交给 getDisplayMatching 重新判定。
    const next = constrainPanelBounds({ ...current, displayId: -1 })
    if (next.x === current.x && next.y === current.y && next.width === current.width && next.height === current.height) continue
    record.window.setBounds({ x: next.x, y: next.y, width: next.width, height: next.height })
  }
}

function acquireNativeListeners(): () => void {
  if (++nativeListenerUsers === 1) {
    screen.on('display-metrics-changed', onDisplaysChanged)
    screen.on('display-removed', onDisplaysChanged)
  }
  let released = false
  return () => {
    if (released) return
    released = true
    if (--nativeListenerUsers === 0) {
      screen.removeListener('display-metrics-changed', onDisplaysChanged)
      screen.removeListener('display-removed', onDisplaysChanged)
    }
  }
}

function panelUrl(id: string): string {
  const dev = process.env.ELECTRON_RENDERER_URL
  const base = dev
    ? new URL('panel.html', dev.replace(/\/?$/, '/'))
    : pathToFileURL(join(app.getAppPath(), 'out', 'renderer', 'panel.html'))
  base.searchParams.set('panelId', id)
  return base.href
}

/** 应用材质：只在创建与外观设置变化时调用，绝不进入拖动路径。 */
export function applyPanelAppearance(record: PanelWindowRecord, appearance: PanelAppearance): void {
  if (record.window.isDestroyed()) return
  record.state = { ...record.state, appearance }
  try {
    // 材质语义（原生能力映射；CSS 侧用 data-material 配合底板浓度）：
    // - none：不应用原生材质，CSS 半透明纯色底板 + opacity 控制浓度。
    // - blur：标准桌面毛玻璃（macOS vibrancy under-window / Windows acrylic）。
    // - system：更重的系统材质（macOS hud 浮窗 / Windows mica）。
    // CSS backdrop-filter 只能采样同页面像素、看不到桌面，因此模糊一律交给原生窗口层。
    if (process.platform === 'darwin') {
      record.window.setVibrancy(appearance.material === 'blur' ? 'under-window' : appearance.material === 'system' ? 'hud' : null)
    } else if (process.platform === 'win32') {
      record.window.setBackgroundMaterial(appearance.material === 'blur' ? 'acrylic' : appearance.material === 'system' ? 'mica' : 'none')
    }
  } catch (error) {
    logWarn('panel', `apply material failed: ${String(error)}`)
  }
  pushState(record)
}

/** 推送状态快照给 chrome；chrome 未就绪时静默丢弃（就绪后由 ready 回调补推）。 */
export function pushState(record: PanelWindowRecord): void {
  if (record.closing || record.window.isDestroyed()) return
  const wc = record.chrome.webContents
  if (wc.isDestroyed() || !record.ready) return
  try { wc.send(IpcChannels.PanelState, record.state) } catch { /* chrome 正在销毁 */ }
}

/** 推送拖动反馈；仅在吸附状态变化时调用，避免逐帧 IPC。 */
export function pushDragFeedback(record: PanelWindowRecord, feedback: PanelDragFeedback): void {
  if (record.closing || record.window.isDestroyed()) return
  const wc = record.chrome.webContents
  if (wc.isDestroyed() || !record.ready) return
  try { wc.send(IpcChannels.PanelDrag, feedback) } catch { /* chrome 正在销毁 */ }
}

/** 重排 chrome 与容器。插件视图由 Manager 通过 setPluginViewBounds 单独设置。 */
export function layoutPanelChrome(record: PanelWindowRecord): void {
  if (record.window.isDestroyed()) return
  const { width, height } = record.window.getContentBounds()
  // container 必须显式铺满客户区：View 默认尺寸不是全屏，不设置会把 chrome 与插件视图裁掉。
  try { record.container.setBounds({ x: 0, y: 0, width: Math.max(1, width), height: Math.max(1, height) }) } catch { /* 容器可能已销毁 */ }
  record.chrome.setBounds({ x: 0, y: 0, width: Math.max(1, width), height: Math.max(1, height) })
  record.state = { ...record.state, width: Math.max(1, width), height: Math.max(1, height) }
}

/** 更新单个组件的原生视图 bounds（拖动高频路径，只做 setBounds）。 */
export function setPluginViewBounds(view: View, rect: PanelWidgetRect): void {
  try { view.setBounds(widgetViewBounds(rect)) } catch { /* view 可能已销毁 */ }
}

/** 解析一次主题，同时产出精简 theme 与完整 appearance（chrome 用后者应用 V2 语义）。 */
function themeSnapshot(): { theme: PanelState['theme']; resolved?: PanelState['resolvedAppearance'] } {
  const resolved = resolveThemeTokens('auto')
  return {
    theme: {
      mode: resolved.mode,
      tokens: resolved.tokens,
      animationLevel: resolved.appearance?.animation.effective ?? 'medium'
    },
    resolved: resolved.appearance
  }
}

/** 原生裁切半径跟随主题 panelRadius，与 CSS --appearance-panel-radius 保持同源。 */
function nativePanelRadius(): number {
  const radius = resolveThemeTokens('auto').appearance?.components.panelRadius
  return typeof radius === 'number' && Number.isFinite(radius) && radius >= 0 ? radius : PANEL_CORNER_RADIUS
}

export interface CreatePanelOptions {
  id: string
  bounds: PanelBounds
  appearance: PanelAppearance
  widgets: PanelWidgetState[]
  guard?: () => boolean
}

/**
 * 创建面板窗口。窗口先隐藏，chrome 加载完成后再显示，
 * 避免出现空白原生窗口闪一下。
 */
export async function createPanelWindow(options: CreatePanelOptions): Promise<PanelWindowRecord> {
  if (options.guard?.() === false) throw new Error('panel creation cancelled')
  const existing = records.get(options.id)
  if (existing && !existing.window.isDestroyed()) return existing
  const bounds = constrainPanelBounds(options.bounds)
  const win = new BaseWindow({
    x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height,
    show: false, frame: false, transparent: true, hasShadow: false,
    resizable: true, movable: true, minimizable: false, maximizable: false, fullscreenable: false,
    skipTaskbar: true, alwaysOnTop: true, roundedCorners: true, backgroundColor: '#00000000',
    minWidth: PANEL_MIN_WIDTH, minHeight: PANEL_MIN_HEIGHT, title: 'eNest'
  })
  const container = new View()
  const chrome = new WebContentsView({
    webPreferences: {
      preload: resolvePreload('panelPreload.js'), partition: SHELL_PARTITION,
      contextIsolation: true, nodeIntegration: false, sandbox: true
    }
  })
  chrome.setBackgroundColor('#00000000')

  const snapshot = themeSnapshot()
  const state: PanelState = {
    id: options.id, width: bounds.width, height: bounds.height,
    widgets: options.widgets.slice(0, PANEL_MAX_WIDGETS),
    appearance: options.appearance, theme: snapshot.theme, resolvedAppearance: snapshot.resolved,
    widgetLimit: PANEL_MAX_WIDGETS
  }
  const record: PanelWindowRecord = {
    id: options.id, window: win, chrome, container, state, ready: false, closing: false,
    removeListeners: () => {}
  }
  records.set(options.id, record)

  // container 提供圆角裁剪（同 Quick 的 surface idiom）：透明 BaseWindow + View 背景裁切。
  container.setBackgroundBlur(0)
  container.setBorderRadius(nativePanelRadius())
  container.addChildView(chrome)
  win.contentView.addChildView(container)
  // 注意：chrome 是 container 的子视图，不能 registerTransientView(win, chrome)——
  // raiseTransientViews 会把已挂在 contentView 的视图重排到最顶，若误登记会把底板顶到插件之上。
  // 面板内的层叠顺序由 PanelManager 对 container 的 child 重排管理。

  if (process.platform === 'darwin') win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
  // level 只在创建后设置一次：show 之后重设 level 在 macOS 26/27 会崩溃。
  win.setAlwaysOnTop(true, 'floating')
  applyPanelAppearance(record, options.appearance)

  const url = panelUrl(options.id)
  registerTrustedSurface(chrome.webContents, 'panel', url)

  const geometry = (): PanelBounds => {
    const current = win.getBounds()
    return { ...current, displayId: screen.getDisplayMatching(current).id }
  }
  const onResize = (): void => {
    layoutPanelChrome(record)
    if (!record.closing) host?.geometryChanged(record.id, geometry())
  }
  const onMove = (): void => { if (!record.closing) host?.geometryChanged(record.id, geometry()) }
  const onClose = (event: Electron.Event): void => {
    if (record.closing) return
    event.preventDefault()
    host?.closeRequested(record.id)
  }
  const onClosed = (): void => {
    record.removeListeners()
    records.delete(record.id)
    if (!record.chrome.webContents.isDestroyed()) record.chrome.webContents.close({ waitForBeforeUnload: false })
    // 异常兜底：窗口被 destroy()/渲染进程崩溃绕过 close 事件时，插件运行时仍挂在
    // 这个已消失的父级上。正常路径（record.closing = true）由 closePanel 释放，这里不重复。
    if (!record.closing) host?.closeRequested(record.id)
  }
  win.on('resize', onResize)
  win.on('move', onMove)
  win.on('close', onClose)
  win.once('closed', onClosed)
  record.removeListeners = () => {
    win.removeListener('resize', onResize)
    win.removeListener('move', onMove)
    win.removeListener('close', onClose)
  }
  const releaseNative = acquireNativeListeners()
  const previousRemove = record.removeListeners
  record.removeListeners = () => { previousRemove(); releaseNative() }

  chrome.webContents.once('render-process-gone', () => {
    logWarn('panel', `chrome renderer gone: ${options.id}`)
    host?.closeRequested(record.id)
  })

  try {
    await Promise.race([
      chrome.webContents.loadURL(url),
      new Promise<never>((_, reject) => {
        const timer = setTimeout(() => reject(new Error('panel chrome did not load')), 10_000)
        timer.unref?.()
      })
    ])
    if (records.get(options.id) !== record || options.guard?.() === false) throw new Error('panel creation cancelled')
  } catch (error) {
    if (records.get(options.id) === record) destroyPanelWindow(options.id)
    throw error
  }

  layoutPanelChrome(record)
  record.ready = true
  pushState(record)
  win.showInactive()
  raiseTransientViews(win)
  return record
}

/** chrome 就绪回调：由 IPC 层在收到 ready 时调用，补推一次完整状态。 */
export function markPanelChromeReady(id: string): void {
  const record = records.get(id)
  if (!record || record.ready) return
  record.ready = true
  pushState(record)
}

export function isPanelWindowVisible(id: string): boolean {
  const record = records.get(id)
  return !!record && !record.window.isDestroyed() && record.window.isVisible() && !record.window.isMinimized()
}

export function destroyPanelWindow(id: string): void {
  const record = records.get(id)
  if (!record) return
  record.closing = true
  records.delete(id)
  record.removeListeners()
  const wc = record.chrome.webContents
  revokeTrustedSurface(wc)
  if (!wc.isDestroyed()) wc.close({ waitForBeforeUnload: false })
  if (!record.window.isDestroyed()) record.window.destroy()
}

export function destroyAllPanelWindows(): void {
  for (const id of [...records.keys()]) destroyPanelWindow(id)
}

/** 主题变更时刷新所有面板 chrome 的 token 快照。 */
export function broadcastPanelTheme(): void {
  const radius = nativePanelRadius()
  for (const record of records.values()) {
    if (record.window.isDestroyed()) continue
    const snapshot = themeSnapshot()
    record.state = { ...record.state, theme: snapshot.theme, resolvedAppearance: snapshot.resolved }
    // 原生裁切半径与 CSS 同源：主题换了 panelRadius 后容器也要跟着变，否则圆角会割裂。
    try { record.container.setBorderRadius(radius) } catch { /* 容器可能已销毁 */ }
    pushState(record)
  }
}

/** 外观设置变更时刷新所有面板材质。 */
export function broadcastPanelAppearance(appearance: PanelAppearance): void {
  for (const record of records.values()) applyPanelAppearance(record, appearance)
}
