/**
 * panelHotkey — 自由面板的全局呼出快捷键
 * 职责：注册一个 native shortcut，呼出「框选区域并新建面板」。
 * 与 quickHotkey 共用 hotkeyRegistry（owner.kind = 'panel'）；
 * 功能关闭时释放快捷键，开启时按设置注册。
 */
import type { HotkeyOwner } from './hotkeyRegistry'
import { applyHotkeyChanges, getHotkeyOwner, getOwnedHotkey, getOwnedHotkeyStatus, isShortcutCaptureActive } from './hotkeyRegistry'
import { normalizeUserShortcut } from '@shared/accelerator'
import type { PanelHotkeyApplyResult } from '@shared/types/panel'
import { settingsStore } from '@main/settings/SettingsStore'
import { selectRegion } from '@main/panel/regionSelection'
import { createPanel } from '@main/panel/PanelManager'
import { logError, logWarn } from '@main/logs/logService'

const owner: HotkeyOwner = { kind: 'panel', id: 'launcher' }
/** 平台默认呼出快捷键（macOS ⌘⇧P，其他 Ctrl+Shift+P）。 */
export const DEFAULT_PANEL_HOTKEY = process.platform === 'darwin' ? 'Command+Shift+P' : 'Ctrl+Shift+P'

function readHotkey(): string {
  const raw = settingsStore.getAll().general.panelHotkey
  const normalized = typeof raw === 'string' ? normalizeUserShortcut(raw, process.platform) : null
  return normalized ?? DEFAULT_PANEL_HOTKEY
}

function fireCreate(): void {
  // 功能开关前置校验：热键在关闭时已注销，这里是兜底（设置刚改、注销尚未完成）。
  // 必须在弹全屏遮罩之前判断，否则用户会先看到遮罩再被拒。
  if (settingsStore.getAll().general.freePanel?.enabled !== true) return
  void (async () => {
    const bounds = await selectRegion()
    if (!bounds) return
    await createPanel(bounds)
  })().catch(error => logError('panel', `hotkey create failed: ${String(error)}`))
}

/** 依据开关与设置注册/释放面板快捷键；返回当前生效的快捷键（未开启为空）。 */
export function applyPanelHotkeys(): PanelHotkeyApplyResult {
  const enabled = settingsStore.getAll().general.freePanel?.enabled === true
  if (!enabled) {
    const result = applyHotkeyChanges([{ owner, registration: null }])
    return { ok: result.ok, enabled: false, hotkey: '', error: result.error }
  }
  const accelerator = readHotkey()
  const result = applyHotkeyChanges([{ owner, registration: { owner, accelerator, onFire: fireCreate } }])
  const activeHotkey = getOwnedHotkey(owner)?.accelerator ?? ''
  const status = getOwnedHotkeyStatus(owner)
  if (status.status === 'conflict') {
    logWarn('panel', `hotkey ${accelerator} unavailable: ${status.error ?? ''}`)
    return { ok: false, enabled: true, hotkey: activeHotkey, error: status.error }
  }
  return { ok: result.ok, enabled: true, hotkey: activeHotkey, error: result.error }
}

/**
 * 设置页保存面板快捷键：归一 + 占用检测 + 原生注册 + 同步持久化；任一失败保留原配置。
 * 被 eNest 其它功能（Quick / 插件绑定 / 运行时）占用时拒绝并保留原键；
 * 系统/外部应用的占用由 applyPanelHotkeys 的 native 注册失败兜底报告。
 */
export async function setPanelHotkey(raw: unknown): Promise<PanelHotkeyApplyResult> {
  const enabled = settingsStore.getAll().general.freePanel?.enabled === true
  const previous = getOwnedHotkey(owner)
  const retained = (error: string): PanelHotkeyApplyResult => ({
    ok: false, enabled, hotkey: getOwnedHotkey(owner)?.accelerator ?? readHotkey(), error
  })
  const accelerator = normalizeUserShortcut(raw, process.platform)
  if (!accelerator) {
    return retained('快捷键无效：请使用包含 Ctrl、Alt、Command 或 Super 等修饰键的组合键')
  }
  if (isShortcutCaptureActive()) return retained('请先结束快捷键录制')
  const occupied = getHotkeyOwner(accelerator)
  if (occupied && occupied.kind !== 'panel') {
    return retained(`快捷键 ${accelerator} 已被 eNest 其他功能占用`)
  }
  const applied = applyHotkeyChanges([{
    owner, registration: enabled ? { owner, accelerator, onFire: fireCreate } : null
  }])
  if (!applied.ok) return retained(applied.error ?? '快捷键注册失败，已保留原设置')
  try {
    settingsStore.setPanelHotkey(accelerator)
  } catch (error) {
    const restored = applyHotkeyChanges([{ owner, registration: previous ?? null }])
    let message = error instanceof Error ? error.message : '保存快捷键失败'
    if (!restored.ok) {
      const released = applyHotkeyChanges([{ owner, registration: null }])
      message += `；原快捷键恢复失败：${restored.error ?? '键位已被占用'}`
      if (!released.ok) message += `；未保存快捷键释放失败：${released.error ?? '未知错误'}`
    }
    return retained(message)
  }
  return { ok: true, enabled, hotkey: enabled ? getOwnedHotkey(owner)?.accelerator ?? '' : accelerator }
}

export function disposePanelHotkeys(): void {
  applyHotkeyChanges([{ owner, registration: null }])
}
