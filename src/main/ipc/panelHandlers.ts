/**
 * panelHandlers — 自由面板 IPC
 * 职责：入参校验 + 功能开关前置守卫 + 转发到 PanelManager。
 * 关键约束：
 *  - 面板 chrome 的 role = 'panel'，只放行 PanelGetState / PanelCommand / PanelDragTick（见 ipcSecurity）。
 *  - 壳渲染层的 role = 'shell'，只放行新建/关闭/列表三个通道。
 *  - 所有面板命令在功能未开启时一律拒绝。
 */
import { IpcChannels } from '@shared/types/ipc'
import type { PanelBounds, PanelCommand, PanelDragMode, PanelResizeEdge } from '@shared/types/panel'
import { handleShellIpc, onShellIpc } from '@main/ipc/ipcSecurity'
import { selectRegion } from '@main/panel/regionSelection'
import { setPanelHotkey } from '@main/hotkey/panelHotkey'
import {
  assertFreePanelEnabled,
  closePanel,
  createPanel,
  getPanelIdForSender,
  getPanelState,
  handlePanelCommand,
  listPanels,
  markPanelReady,
  panelDragTick,
  panelWindowDragTick
} from '@main/panel/PanelManager'

let registered = false

const DRAG_MODES: readonly PanelDragMode[] = ['move', 'resize']
const RESIZE_EDGES: readonly PanelResizeEdge[] = ['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw']

function validInteractionId(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
}

function validPoint(raw: unknown): { x: number; y: number } | null {
  if (!raw || typeof raw !== 'object') return null
  const point = raw as Record<string, unknown>
  if (typeof point.x !== 'number' || typeof point.y !== 'number') return null
  if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) return null
  if (Math.abs(point.x) > 100_000 || Math.abs(point.y) > 100_000) return null
  return { x: point.x, y: point.y }
}

function validRect(raw: unknown): { x: number; y: number; width: number; height: number } | null {
  const point = validPoint(raw)
  if (!point) return null
  const rect = raw as Record<string, unknown>
  if (typeof rect.width !== 'number' || typeof rect.height !== 'number') return null
  if (!Number.isFinite(rect.width) || !Number.isFinite(rect.height)) return null
  if (rect.width <= 0 || rect.height <= 0 || rect.width > 100_000 || rect.height > 100_000) return null
  return { ...point, width: rect.width, height: rect.height }
}

function validBounds(raw: unknown): PanelBounds | null {
  const rect = validRect(raw)
  if (!rect) return null
  const displayId = (raw as Record<string, unknown>).displayId
  return { ...rect, displayId: typeof displayId === 'number' && Number.isFinite(displayId) ? displayId : -1 }
}

/** 面板命令入参归一：只保留契约里声明的字段，拒绝未知 action。 */
function normalizeCommand(raw: unknown): PanelCommand | null {
  if (!raw || typeof raw !== 'object') return null
  const input = raw as Record<string, unknown>
  const action = input.action
  switch (action) {
    case 'list-candidates':
      return { action }
    case 'add-widget': {
      if (typeof input.pluginId !== 'string' || !input.pluginId || input.pluginId.length > 200) return null
      const rect = input.rect === undefined ? undefined : validRect(input.rect)
      if (input.rect !== undefined && !rect) return null
      return { action, pluginId: input.pluginId, rect: rect ?? undefined }
    }
    case 'remove-widget':
    case 'dock-widget':
    case 'raise-widget':
    case 'retry-widget': {
      if (typeof input.pluginId !== 'string' || !input.pluginId || input.pluginId.length > 200) return null
      return { action, pluginId: input.pluginId }
    }
    case 'close-panel':
      return { action }
    case 'set-appearance': {
      const appearance = input.appearance
      if (!appearance || typeof appearance !== 'object') return null
      const raw = appearance as Record<string, unknown>
      const out: { opacity?: number; material?: 'none' | 'blur' | 'system' } = {}
      if (raw.opacity !== undefined) {
        if (typeof raw.opacity !== 'number' || !Number.isFinite(raw.opacity)) return null
        out.opacity = raw.opacity
      }
      if (raw.material !== undefined) {
        if (raw.material !== 'none' && raw.material !== 'blur' && raw.material !== 'system') return null
        out.material = raw.material
      }
      return { action, appearance: out }
    }
    case 'widget-drag-begin': {
      if (!validInteractionId(input.interactionId)) return null
      if (typeof input.pluginId !== 'string' || !input.pluginId || input.pluginId.length > 200) return null
      if (!DRAG_MODES.includes(input.mode as PanelDragMode)) return null
      const edge = input.edge
      if (edge !== undefined && !RESIZE_EDGES.includes(edge as PanelResizeEdge)) return null
      const pointer = validPoint(input.pointer)
      if (!pointer) return null
      return { action, interactionId: input.interactionId, pluginId: input.pluginId, mode: input.mode as PanelDragMode, edge: edge as PanelResizeEdge | undefined, pointer }
    }
    case 'widget-drag-end':
      if (!validInteractionId(input.interactionId)) return null
      return { action, interactionId: input.interactionId, cancel: input.cancel === true }
    case 'window-drag-begin': {
      if (!validInteractionId(input.interactionId)) return null
      if (!DRAG_MODES.includes(input.mode as PanelDragMode)) return null
      const edge = input.edge
      if (edge !== undefined && !RESIZE_EDGES.includes(edge as PanelResizeEdge)) return null
      // 移动不需要 edge；缩放必须有 edge，否则拒绝。
      if (input.mode === 'resize' && edge === undefined) return null
      const pointer = input.pointer === undefined ? undefined : validPoint(input.pointer)
      if (input.pointer !== undefined && !pointer) return null
      return { action, interactionId: input.interactionId, mode: input.mode as PanelDragMode, edge: edge as PanelResizeEdge | undefined, pointer: pointer ?? undefined }
    }
    case 'window-drag-end':
      if (!validInteractionId(input.interactionId)) return null
      return { action, interactionId: input.interactionId, cancel: input.cancel === true }
    case 'overlay-open':
    case 'overlay-close':
      return { action }
    default:
      return null
  }
}

export function registerPanelHandlers(): void {
  if (registered) return
  registered = true

  // —— 面板 chrome 表面 ——

  handleShellIpc(IpcChannels.PanelGetState, (event) => {
    const panelId = getPanelIdForSender(event.sender.id)
    if (!panelId) throw new Error('IPC denied: not a panel surface')
    markPanelReady(panelId)
    return getPanelState(panelId)
  })

  handleShellIpc(IpcChannels.PanelCommand, async (event, raw: unknown) => {
    const panelId = getPanelIdForSender(event.sender.id)
    if (!panelId) throw new Error('IPC denied: not a panel surface')
    if (typeof raw !== 'object' || raw === null) return { ok: false, error: '无效命令' }
    // 关闭面板与外观设置之外，其余命令都需要功能开启。
    try { assertFreePanelEnabled() } catch { return { ok: false, error: '自由面板未开启' } }
    const command = normalizeCommand(raw)
    if (!command) return { ok: false, error: '无效命令' }
    return handlePanelCommand(panelId, command)
  })

  onShellIpc(IpcChannels.PanelDragTick, (event, interactionId: unknown) => {
    if (!validInteractionId(interactionId)) return
    // 同一保活通道服务两种拖动：组件拖动与整块面板移动/缩放。
    panelDragTick(event.sender.id, interactionId)
    panelWindowDragTick(event.sender.id, interactionId)
  })

  // —— 壳渲染层 ——

  handleShellIpc(IpcChannels.PanelList, () => {
    try { assertFreePanelEnabled() } catch { return [] }
    return listPanels()
  })

  handleShellIpc(IpcChannels.PanelCreate, async () => {
    assertFreePanelEnabled()
    const bounds = await selectRegion()
    if (!bounds) return { ok: false, cancelled: true }
    const created = await createPanel(bounds)
    return { ok: true, ...created }
  })

  handleShellIpc(IpcChannels.PanelClose, async (_event, panelId: unknown) => {
    assertFreePanelEnabled()
    if (typeof panelId !== 'string' || !panelId || panelId.length > 120) throw new Error('无效面板')
    await closePanel(panelId)
    return { ok: true }
  })

  // 保存面板呼出快捷键：主进程归一 + 占用检测 + 重注册，返回真实结果（镜像 quick:set-hotkeys）。
  handleShellIpc(IpcChannels.PanelSetHotkey, async (_event, accelerator: unknown) => {
    assertFreePanelEnabled()
    return setPanelHotkey(accelerator)
  })

  // pick-region 与 create 同义：保留独立通道便于将来「只框选不创建」的场景。
  handleShellIpc(IpcChannels.PanelPickRegion, async () => {
    assertFreePanelEnabled()
    return selectRegion()
  })
}
