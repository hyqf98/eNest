/** The Quick launcher owns one native shortcut; changes retain the previous key on failure. */
import type { QuickHotkeyApplyResult, QuickHotkeyConfig, QuickHotkeyProbeResult } from '@shared/types/quick'
import { normalizeUserShortcut } from '@shared/accelerator'
import { defaultQuickHotkeys, settingsStore } from '@main/settings/SettingsStore'
import { pluginRegistry } from '@main/plugin/PluginRegistry'
import { sendShellEvent } from '@main/window/createShellWindow'
import { toggleQuickWindow } from '@main/window/createQuickWindow'
import { logError } from '@main/logs/logService'
import {
  applyHotkeyChanges, disposeHotkeyRegistry, getHotkeyOwner, getOwnedHotkey,
  getOwnedHotkeyStatus, isShortcutCaptureActive, probeNativeHotkey, type HotkeyOwner
} from './hotkeyRegistry'

const owner: HotkeyOwner = { kind: 'quick', id: 'launcher' }
let lastUsedHotkey = ''
let lastSaveError: string | undefined

function fireToggle(acc: string): void {
  lastUsedHotkey = acc
  sendShellEvent({ type: 'quick-hotkey-used', acc })
  try { toggleQuickWindow() }
  catch (error) { logError('quick', `toggle failed (${acc}): ${String(error)}`) }
}

function readSettings(): { enabled: boolean; hotkeys: string[]; activeHotkey: string } {
  const ql = settingsStore.getQuickLauncherSettings()
  const candidates = Array.isArray(ql?.hotkeys) && ql.hotkeys.length ? ql.hotkeys : defaultQuickHotkeys()
  const valid = [...new Set(candidates.map(acc => normalizeUserShortcut(acc, process.platform)).filter((acc): acc is string => !!acc))]
  const hotkeys = valid.length ? valid : defaultQuickHotkeys()
  const preferred = normalizeUserShortcut(ql?.activeHotkey, process.platform)
  return { enabled: ql?.enabled !== false, hotkeys, activeHotkey: preferred && hotkeys.includes(preferred) ? preferred : hotkeys[0] ?? '' }
}

function pluginConflictHint(accelerator: string): string | undefined {
  const occupied = getHotkeyOwner(accelerator)
  if (!occupied || occupied.kind === 'quick') return undefined
  const id = occupied.pluginId
  const name = id ? pluginRegistry.get(id)?.name : undefined
  const label = name && name !== id ? `${name}（${id}）` : id ?? '未知插件'
  return `快捷键 ${accelerator} 已被插件「${label}」的${occupied.kind === 'runtime' ? '运行时快捷键' : '快捷键绑定'}占用`
}

export function applyQuickHotkeys(
  patch?: Partial<{ enabled: boolean; hotkeys: string[]; activeHotkey: string }>
): QuickHotkeyApplyResult {
  const current = readSettings()
  const retainCurrent = (error: string, failed: string[] = []): QuickHotkeyApplyResult => {
    const previous = getOwnedHotkey(owner)?.accelerator
    return { ok: false, enabled: current.enabled, hotkeys: current.hotkeys,
      registered: previous && getOwnedHotkeyStatus(owner).status === 'registered' ? [previous] : [], failed,
      activeHotkey: previous ?? current.activeHotkey, error }
  }
  if (patch && isShortcutCaptureActive()) return retainCurrent('请先结束快捷键录制')
  if (patch && ((patch.hotkeys !== undefined && (!Array.isArray(patch.hotkeys)
    || patch.hotkeys.some(acc => !normalizeUserShortcut(acc, process.platform))))
    || (patch.activeHotkey && !normalizeUserShortcut(patch.activeHotkey, process.platform)))) {
    return retainCurrent('快捷键需包含 Ctrl、Alt、Command 或 Super 等修饰键')
  }
  const enabled = patch?.enabled ?? current.enabled
  const candidates = patch?.hotkeys?.length ? patch.hotkeys : current.hotkeys
  const hotkeys = [...new Set(candidates.map(acc => normalizeUserShortcut(acc, process.platform)).filter((acc): acc is string => !!acc))]
  const preferred = normalizeUserShortcut(patch?.activeHotkey ?? current.activeHotkey, process.platform)
  const wanted = preferred && hotkeys.includes(preferred) ? preferred : hotkeys[0] ?? ''
  if (!enabled) {
    const result = applyHotkeyChanges([{ owner, registration: null }])
    return { ok: result.ok, error: result.error, enabled: false, hotkeys, registered: [], failed: [], activeHotkey: wanted }
  }
  // Explicit edits must not silently activate a different preset after a conflict.
  const tryOrder = [...new Set((patch ? [wanted] : [wanted, ...hotkeys]).filter(Boolean))]
  const failed: string[] = []
  let failureReason = '快捷键注册失败'
  for (const acc of tryOrder) {
    const result = applyHotkeyChanges([{ owner, registration: { owner, accelerator: acc, onFire: () => fireToggle(acc) } }])
    if (result.ok) {
      const registered = getOwnedHotkeyStatus(owner).status === 'registered' ? [acc] : []
      if (failed.length) sendShellEvent({ type: 'quick-hotkey-failed', failed, registered })
      return { ok: true, enabled, hotkeys, registered, failed, activeHotkey: acc }
    }
    failureReason = pluginConflictHint(acc) ?? result.error ?? failureReason
    failed.push(acc)
  }
  const result = retainCurrent(`${failureReason}；已保留原配置`, failed)
  sendShellEvent({ type: 'quick-hotkey-failed', failed, registered: result.registered })
  return result
}

/** Commit native ownership and durable preferences together, with exact rollback on write failure. */
export function saveQuickHotkeys(
  patch: Partial<{ enabled: boolean; hotkeys: string[]; activeHotkey: string }>
): QuickHotkeyApplyResult {
  const previousSettings = readSettings()
  const previousRegistration = getOwnedHotkey(owner)
  const applied = applyQuickHotkeys(patch ?? {})
  if (!applied.ok) { lastSaveError = applied.error; return applied }
  const config = { enabled: applied.enabled, hotkeys: applied.hotkeys, activeHotkey: applied.activeHotkey ?? '' }
  try {
    settingsStore.setQuickHotkeys(config)
  } catch (error) {
    const restored = applyHotkeyChanges([{ owner, registration: previousRegistration ?? null }])
    let message = `快捷键设置保存失败：${error instanceof Error ? error.message : String(error)}`
    if (!restored.ok) {
      // The old key may have been claimed after release. Never leave an unsaved replacement active.
      applyHotkeyChanges([{ owner, registration: null }])
      message += `；原快捷键 ${previousRegistration?.accelerator ?? previousSettings.activeHotkey} 恢复失败：${restored.error}`
    }
    lastSaveError = message
    const actual = getOwnedHotkey(owner)
    const registered = actual && getOwnedHotkeyStatus(owner).status === 'registered' ? [actual.accelerator] : []
    sendShellEvent({ type: 'quick-hotkey-failed', failed: applied.failed, registered })
    return { ok: false, ...previousSettings, registered, failed: applied.failed, error: message }
  }
  lastSaveError = undefined
  sendShellEvent({ type: 'quick-config-changed', ...config })
  return applied
}

export function initQuickHotkeys(): void { lastSaveError = undefined; applyQuickHotkeys() }

/** Called during application shutdown; includes capture leases and plugin registrations. */
export function disposeQuickHotkeys(): void { lastSaveError = undefined; disposeHotkeyRegistry() }

export function getQuickHotkeyConfig(): QuickHotkeyConfig {
  const settings = readSettings()
  const registration = getOwnedHotkey(owner)
  const state = getOwnedHotkeyStatus(owner)
  return { ...settings, platform: process.platform, activeHotkey: registration?.accelerator ?? settings.activeHotkey,
    lastUsedHotkey, registered: state.status === 'registered' && registration ? [registration.accelerator] : [], error: state.error ?? lastSaveError }
}

export function probeHotkey(acc: string): QuickHotkeyProbeResult {
  if (!normalizeUserShortcut(acc, process.platform)) return { acc, free: false, ours: false, hint: '快捷键需包含 Ctrl、Alt、Command 或 Super 等修饰键' }
  const conflict = pluginConflictHint(acc)
  if (conflict) return { acc, free: false, ours: true, hint: conflict }
  return { acc, ...probeNativeHotkey(acc) }
}
