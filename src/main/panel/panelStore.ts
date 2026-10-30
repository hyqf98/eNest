/**
 * panelStore — 自由面板布局的持久化读写
 * 职责：从 settingsStore 读取 panels 段并做严格校验/归一；以 400ms 防抖写回，支持立即 flush。
 * 关键约束：本模块只碰设置，不创建窗口、不接触插件运行时（由 PanelManager 负责）。
 *           panels 段只由主进程写，renderer 的 shell:set-settings 写入会被剥离。
 */
import { settingsStore } from '@main/settings/SettingsStore'
import { logWarn } from '@main/logs/logService'
import {
  DEFAULT_PANEL_APPEARANCE,
  PANEL_MAX_PANELS,
  PANEL_MAX_WIDGETS,
  type PanelAppearance,
  type PanelBounds,
  type PersistedPanel,
  type PersistedPanelWidget
} from '@shared/types/panel'

const PERSIST_DEBOUNCE_MS = 400

let timer: ReturnType<typeof setTimeout> | undefined

const isFiniteNumber = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value)

function normalizeBounds(value: unknown): PanelBounds | null {
  if (!value || typeof value !== 'object') return null
  const raw = value as Partial<PanelBounds>
  if (!isFiniteNumber(raw.x) || !isFiniteNumber(raw.y) || !isFiniteNumber(raw.width) || !isFiniteNumber(raw.height)) return null
  if (raw.width < 1 || raw.height < 1) return null
  return {
    x: Math.round(raw.x),
    y: Math.round(raw.y),
    width: Math.round(raw.width),
    height: Math.round(raw.height),
    displayId: isFiniteNumber(raw.displayId) ? Math.round(raw.displayId) : -1
  }
}

function normalizeWidget(value: unknown, seen: Set<string>): PersistedPanelWidget | null {
  if (!value || typeof value !== 'object') return null
  const raw = value as Partial<PersistedPanelWidget>
  if (typeof raw.pluginId !== 'string' || !raw.pluginId || raw.pluginId.length > 200) return null
  if (seen.has(raw.pluginId)) return null
  if (!isFiniteNumber(raw.x) || !isFiniteNumber(raw.y) || !isFiniteNumber(raw.width) || !isFiniteNumber(raw.height)) return null
  seen.add(raw.pluginId)
  return {
    pluginId: raw.pluginId,
    x: Math.round(raw.x),
    y: Math.round(raw.y),
    width: Math.round(raw.width),
    height: Math.round(raw.height),
    z: isFiniteNumber(raw.z) ? Math.round(raw.z) : 0
  }
}

/** 归一单个面板记录；无效输入返回 null（由调用方丢弃，不阻断其余面板恢复）。 */
function normalizePanel(value: unknown, index: number): PersistedPanel | null {
  if (!value || typeof value !== 'object') return null
  const raw = value as Partial<PersistedPanel>
  const bounds = normalizeBounds(raw.bounds)
  if (!bounds) return null
  const id = typeof raw.id === 'string' && raw.id && raw.id.length <= 120 ? raw.id : `panel-${index}`
  const seen = new Set<string>()
  const widgets = Array.isArray(raw.widgets)
    ? raw.widgets.map(item => normalizeWidget(item, seen)).filter((item): item is PersistedPanelWidget => item !== null).slice(0, PANEL_MAX_WIDGETS)
    : []
  return { id, bounds, widgets }
}

/** 读取全部面板记录；顺序稳定，超量截断。 */
export function readPanels(): PersistedPanel[] {
  const stored = settingsStore.getAll().panels
  if (!Array.isArray(stored)) return []
  const out: PersistedPanel[] = []
  const ids = new Set<string>()
  for (const [index, item] of stored.entries()) {
    const panel = normalizePanel(item, index)
    if (!panel) continue
    // 重复 id 会让窗口映射与持久化互相覆盖，保留第一个。
    if (ids.has(panel.id)) continue
    ids.add(panel.id)
    out.push(panel)
    if (out.length >= PANEL_MAX_PANELS) break
  }
  return out
}

/** 立即写入（取消待执行的防抖）。失败只记录日志，不影响内存状态。 */
export async function flushPanels(panels: readonly PersistedPanel[]): Promise<void> {
  if (timer) { clearTimeout(timer); timer = undefined }
  try {
    await settingsStore.setAll({ panels: panels.map(panel => ({ ...panel, bounds: { ...panel.bounds }, widgets: panel.widgets.map(widget => ({ ...widget })) })) })
  } catch (error) {
    logWarn('panel', `persist failed: ${String(error)}`)
  }
}

/** 防抖写入：拖动/缩放这类高频变更只落最后一次。 */
export function schedulePanels(panels: readonly PersistedPanel[]): void {
  if (timer) clearTimeout(timer)
  timer = setTimeout(() => {
    timer = undefined
    void flushPanels(panels)
  }, PERSIST_DEBOUNCE_MS)
  timer.unref?.()
}

/** 退出路径：同步取消计时器，由调用方随后 await flushPanels。 */
export function cancelScheduledPanels(): void {
  if (timer) { clearTimeout(timer); timer = undefined }
}

/** 读取壳级面板外观设置（含默认值兜底）；opacity=0 且 material=none 时底板完全透明。 */
export function readPanelAppearance(): PanelAppearance {
  const raw = settingsStore.getAll().general.panelAppearance
  const opacity = raw && isFiniteNumber((raw as PanelAppearance).opacity) ? (raw as PanelAppearance).opacity : DEFAULT_PANEL_APPEARANCE.opacity
  const material = raw && typeof (raw as PanelAppearance).material === 'string' ? (raw as PanelAppearance).material : DEFAULT_PANEL_APPEARANCE.material
  return {
    opacity: Math.min(1, Math.max(0, opacity)),
    material: material === 'none' || material === 'blur' || material === 'system' ? material : DEFAULT_PANEL_APPEARANCE.material
  }
}

/** 自由面板功能是否已开启。 */
export function isFreePanelEnabled(): boolean {
  return settingsStore.getAll().general.freePanel?.enabled === true
}
