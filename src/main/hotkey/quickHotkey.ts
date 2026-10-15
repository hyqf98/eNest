/** The Quick launcher owns one native shortcut; changes retain the previous key on failure. */
import type { QuickHotkeyApplyResult, QuickHotkeyConfig, QuickHotkeyPatch, QuickHotkeyProbeResult } from '@shared/types/quick'
import { normalizeUserShortcut } from '@shared/accelerator'
import { defaultQuickHotkeys, settingsStore } from '@main/settings/SettingsStore'
import { pluginRegistry } from '@main/plugin/PluginRegistry'
import { sendShellEvent } from '@main/window/createShellWindow'
import { toggleQuickWindow } from '@main/window/createQuickWindow'
import { logError } from '@main/logs/logService'
import {
  applyHotkeyChanges, disposeHotkeyRegistry, getHotkeyOwner, getOwnedHotkey,
  getOwnedHotkeyStatus, isShortcutCaptureActive, type HotkeyOwner
} from './hotkeyRegistry'
import { consumeShortcutOverride, overrideOwner, probeShortcutConflict } from './shortcutConflicts'

const owner: HotkeyOwner = { kind: 'quick', id: 'launcher' }
let lastUsedHotkey = ''
let lastSaveError: string | undefined

function validPatch(value: unknown): value is QuickHotkeyPatch {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const patch = value as QuickHotkeyPatch
  return (patch.enabled === undefined || typeof patch.enabled === 'boolean')
    && (patch.hotkeys === undefined || (Array.isArray(patch.hotkeys) && patch.hotkeys.every(key => !!normalizeUserShortcut(key, process.platform))))
    && (patch.activeHotkey === undefined || (typeof patch.activeHotkey === 'string' && (!patch.activeHotkey || !!normalizeUserShortcut(patch.activeHotkey, process.platform))))
    && (patch.overrideToken === undefined || (typeof patch.overrideToken === 'string' && !!patch.overrideToken))
}

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
  patch?: QuickHotkeyPatch
): QuickHotkeyApplyResult {
  const current = readSettings()
  const retainCurrent = (error: string, failed: string[] = []): QuickHotkeyApplyResult => {
    const previous = getOwnedHotkey(owner)?.accelerator
    return { ok: false, enabled: current.enabled, hotkeys: current.hotkeys,
      registered: previous && getOwnedHotkeyStatus(owner).status === 'registered' ? [previous] : [], failed,
      activeHotkey: previous ?? current.activeHotkey, error,
      systemConfirmationRequired: getOwnedHotkeyStatus(owner).status === 'pending-system' }
  }
  if (patch !== undefined && !validPatch(patch)) return retainCurrent('快捷键配置无效：请使用包含 Ctrl、Alt、Command 或 Super 等修饰键的组合键')
  if (patch && isShortcutCaptureActive()) return retainCurrent('请先结束快捷键录制')
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
      return { ok: true, enabled, hotkeys, registered, failed, activeHotkey: acc,
        systemConfirmationRequired: getOwnedHotkeyStatus(owner).status === 'pending-system' }
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
  patch: QuickHotkeyPatch
): QuickHotkeyApplyResult {
  const previousSettings = readSettings()
  const previousRegistration = getOwnedHotkey(owner)
  if (!validPatch(patch)) return { ok: false, ...previousSettings, failed: [],
    registered: previousRegistration && getOwnedHotkeyStatus(owner).status === 'registered' ? [previousRegistration.accelerator] : [],
    error: '快捷键配置无效：请使用包含 Ctrl、Alt、Command 或 Super 等修饰键的组合键' }
  const candidates = Array.isArray(patch?.hotkeys) && patch.hotkeys.length ? patch.hotkeys : previousSettings.hotkeys
  const hotkeys = [...new Set(candidates.map(key => normalizeUserShortcut(key, process.platform)).filter((key): key is string => !!key))]
  const preferred = normalizeUserShortcut(patch?.activeHotkey ?? previousSettings.activeHotkey, process.platform)
  const wanted = preferred && hotkeys.includes(preferred) ? preferred : hotkeys[0] ?? ''
  const enabled = patch?.enabled ?? previousSettings.enabled
  const probe = enabled && wanted ? probeShortcutConflict(wanted, undefined, true) : undefined
  const retained = (error: string): QuickHotkeyApplyResult => ({ ok: false, ...previousSettings,
    registered: previousRegistration && getOwnedHotkeyStatus(owner).status === 'registered' ? [previousRegistration.accelerator] : [],
    failed: wanted ? [wanted] : [], error, ...(probe ? { probe: probeShortcutConflict(wanted, undefined, true) } : {}),
    systemConfirmationRequired: getOwnedHotkeyStatus(owner).status === 'pending-system' })
  let replaced: HotkeyOwner | undefined
  if (probe && (probe.status !== 'free' || patch?.overrideToken)) {
    // Validation and capture checks still apply before accepting a replacement token.
    if (isShortcutCaptureActive()) return retained('请先结束快捷键录制')
    if (!consumeShortcutOverride(patch?.overrideToken, probe)) {
      const error = patch?.overrideToken ? '快捷键占用已变化或确认已过期，请重新检查后确认。'
        : pluginConflictHint(wanted) ?? probe.hint ?? '快捷键已被其他绑定占用，请确认是否覆盖。'
      lastSaveError = error
      return retained(error)
    }
    replaced = overrideOwner(probe)
  }
  const replacedRegistration = replaced ? getOwnedHotkey(replaced) : undefined
  const replacement = replaced ? applyHotkeyChanges([
    { owner: replaced, registration: null }, { owner, registration: { owner, accelerator: wanted, onFire: () => fireToggle(wanted) } }
  ]) : undefined
  const applied: QuickHotkeyApplyResult = replacement
    ? replacement.ok ? { ok: true, enabled, hotkeys, activeHotkey: wanted,
      registered: getOwnedHotkeyStatus(owner).status === 'registered' ? [wanted] : [], failed: [],
      systemConfirmationRequired: getOwnedHotkeyStatus(owner).status === 'pending-system' }
      : retained(replacement.error ?? '快捷键注册失败，已保留原配置')
    : applyQuickHotkeys(patch ?? {})
  if (!applied.ok) { lastSaveError = applied.error; return applied }
  const config = { enabled: applied.enabled, hotkeys: applied.hotkeys, activeHotkey: applied.activeHotkey ?? '' }
  try {
    if (replaced) settingsStore.setShortcutConfiguration(settingsStore.getPluginShortcuts().map(binding =>
      binding.id === replaced.id ? { ...binding, enabled: false } : binding), config)
    else settingsStore.setQuickHotkeys(config)
  } catch (error) {
    const originals = [{ owner, registration: previousRegistration ?? null },
      ...(replaced ? [{ owner: replaced, registration: replacedRegistration ?? null }] : [])]
    const restored = applyHotkeyChanges(originals)
    let message = `快捷键设置保存失败：${error instanceof Error ? error.message : String(error)}`
    if (!restored.ok) {
      // The old key may have been claimed after release. Never leave an unsaved replacement active.
      applyHotkeyChanges(originals.map(item => ({ owner: item.owner, registration: null })))
      for (const original of originals) {
        const result = applyHotkeyChanges([original])
        if (!result.ok) message += `；原快捷键 ${original.registration?.accelerator ?? ''} 恢复失败：${result.error}`
      }
    }
    lastSaveError = message
    const actual = getOwnedHotkey(owner)
    const registered = actual && getOwnedHotkeyStatus(owner).status === 'registered' ? [actual.accelerator] : []
    sendShellEvent({ type: 'quick-hotkey-failed', failed: applied.failed, registered })
    return { ok: false, ...previousSettings, registered, failed: applied.failed, error: message,
      ...(enabled && wanted ? { probe: probeShortcutConflict(wanted, undefined, true) } : {}) }
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
    lastUsedHotkey, registered: state.status === 'registered' && registration ? [registration.accelerator] : [], error: settings.enabled ? state.error ?? lastSaveError : undefined,
    systemConfirmationRequired: state.status === 'pending-system' }
}

export function probeHotkey(acc: string): QuickHotkeyProbeResult {
  const conflict = probeShortcutConflict(acc, undefined, true)
  return { acc: conflict.accelerator, free: conflict.status === 'free', ours: !!getHotkeyOwner(conflict.accelerator),
    hint: pluginConflictHint(conflict.accelerator) ?? conflict.hint,
    ...(conflict.status === 'free' ? {} : { conflict }) }
}
