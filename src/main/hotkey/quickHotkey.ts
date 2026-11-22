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
import {
  applyForceHotkeys, canForceHotkey, getForceHotkeyStatus, hasForceHotkeys,
  isForceRegistered, onForceHotkeyStatusChange
} from './forceHotkey'

const owner: HotkeyOwner = { kind: 'quick', id: 'launcher' }
let lastUsedHotkey = ''
let lastSaveError: string | undefined
let unsubscribeForceStatus: (() => void) | undefined

function validPatch(value: unknown): value is QuickHotkeyPatch {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const patch = value as QuickHotkeyPatch
  return (patch.enabled === undefined || typeof patch.enabled === 'boolean')
    && (patch.hotkeys === undefined || (Array.isArray(patch.hotkeys) && patch.hotkeys.every(key => !!normalizeUserShortcut(key, process.platform))))
    && (patch.activeHotkey === undefined || (typeof patch.activeHotkey === 'string' && (!patch.activeHotkey || !!normalizeUserShortcut(patch.activeHotkey, process.platform))))
    && (patch.overrideToken === undefined || (typeof patch.overrideToken === 'string' && !!patch.overrideToken))
    && (patch.force === undefined || typeof patch.force === 'boolean')
    && (patch.reset === undefined || typeof patch.reset === 'boolean')
}

function fireToggle(acc: string): void {
  lastUsedHotkey = acc
  sendShellEvent({ type: 'quick-hotkey-used', acc })
  try { toggleQuickWindow() }
  catch (error) { logError('quick', `toggle failed (${acc}): ${String(error)}`) }
}

function readSettings(): { enabled: boolean; hotkeys: string[]; activeHotkey: string; forcedHotkeys: string[] } {
  const ql = settingsStore.getQuickLauncherSettings()
  const candidates = Array.isArray(ql?.hotkeys) && ql.hotkeys.length ? ql.hotkeys : defaultQuickHotkeys()
  const valid = [...new Set(candidates.map(acc => normalizeUserShortcut(acc, process.platform)).filter((acc): acc is string => !!acc))]
  const hotkeys = valid.length ? valid : defaultQuickHotkeys()
  const preferred = normalizeUserShortcut(ql?.activeHotkey, process.platform)
  const activeHotkey = preferred && hotkeys.includes(preferred) ? preferred : hotkeys[0] ?? ''
  const forcedHotkeys = [...new Set((Array.isArray(ql?.forcedHotkeys) ? ql.forcedHotkeys : [])
    .map(acc => normalizeUserShortcut(acc, process.platform))
    .filter((acc): acc is string => !!acc && hotkeys.includes(acc)))]
  return { enabled: ql?.enabled === true, hotkeys, activeHotkey, forcedHotkeys }
}

/** 生效中的强制接管键（辅助服务已就绪且配置包含它）。 */
function activeForcedHotkey(settings: { forcedHotkeys: string[] }): string | undefined {
  return settings.forcedHotkeys.find(acc => isForceRegistered(acc))
}

function releaseForceIfIdle(): void {
  if (hasForceHotkeys() && !activeForcedHotkey(readSettings())) applyForceHotkeys([])
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
      registered: previous && getOwnedHotkeyStatus(owner).status === 'registered' ? [previous] : [],
      failed, activeHotkey: previous ?? current.activeHotkey, error,
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
    applyForceHotkeys([])
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
      releaseForceIfIdle()
      const registered = getOwnedHotkeyStatus(owner).status === 'registered' ? [acc] : []
      if (failed.length) sendShellEvent({ type: 'quick-hotkey-failed', failed, registered })
      return { ok: true, enabled, hotkeys, registered, failed, activeHotkey: acc,
        systemConfirmationRequired: getOwnedHotkeyStatus(owner).status === 'pending-system' }
    }
    failureReason = pluginConflictHint(acc) ?? result.error ?? failureReason
    failed.push(acc)
  }
  // 用户已确认过的强制接管键：普通注册失败且确属外部占用时改用低级键盘钩子。
  const forceTarget = tryOrder.find(acc => current.forcedHotkeys.includes(acc) && !getHotkeyOwner(acc)
    && probeShortcutConflict(acc, undefined, true).forceable)
  if (forceTarget) {
    const forced = applyForceHotkeys([{ accelerator: forceTarget, onFire: () => fireToggle(forceTarget) }])
    if (forced.ok) {
      applyHotkeyChanges([{ owner, registration: null }])
      const registered = isForceRegistered(forceTarget) ? [forceTarget] : []
      return { ok: true, enabled, hotkeys, registered, failed, activeHotkey: forceTarget,
        forced: [forceTarget], systemConfirmationRequired: false }
    }
    failureReason = `${forced.error ?? '强制覆盖失败'}；${failureReason}`
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
  // 强制覆盖只在用户明确请求、且键确实被外部占用时生效；未被占用时按普通保存处理。
  const forceRequested = patch.force === true && probe?.status === 'system' && probe.forceable === true
  const forcedHotkeys = patch.reset === true ? []
    : forceRequested ? [wanted]
      : wanted === previousSettings.activeHotkey ? previousSettings.forcedHotkeys.filter(acc => hotkeys.includes(acc)) : []
  const retained = (error: string): QuickHotkeyApplyResult => ({ ok: false, ...previousSettings,
    registered: previousRegistration && getOwnedHotkeyStatus(owner).status === 'registered' ? [previousRegistration.accelerator] : [],
    failed: wanted ? [wanted] : [], error, ...(probe ? { probe: probeShortcutConflict(wanted, undefined, true) } : {}),
    systemConfirmationRequired: getOwnedHotkeyStatus(owner).status === 'pending-system' })
  if (patch.reset === true) {
    // 恢复默认：先无条件释放强制接管；即使默认键当前被外部占用，也保存默认选择，
    // 让用户至少回到干净状态并看到占用提示（而不是继续被旧钩子接管）。
    if (isShortcutCaptureActive()) return retained('请先结束快捷键录制')
    applyForceHotkeys([])
    // 先释放旧绑定，保证重置后的状态与默认选择一致（默认键可能仍被外部占用）。
    applyHotkeyChanges([{ owner, registration: null }])
    const attempt = applyQuickHotkeys({ enabled, hotkeys, activeHotkey: wanted })
    const config = { enabled, hotkeys, activeHotkey: wanted, forcedHotkeys: [] }
    try { settingsStore.setQuickHotkeys(config) }
    catch (error) {
      lastSaveError = `快捷键设置保存失败：${error instanceof Error ? error.message : String(error)}`
      return retained(lastSaveError)
    }
    lastSaveError = attempt.ok ? undefined
      : `默认快捷键 ${wanted || '（无）'} 当前不可用（${(attempt.error ?? '注册失败').replace(/；已保留原配置$/, '')}）；已释放强制接管并恢复默认选择，请换一个组合键或强制覆盖。`
    sendShellEvent({ type: 'quick-config-changed', ...config })
    return { ok: attempt.ok, enabled, hotkeys, activeHotkey: wanted,
      registered: attempt.registered, failed: attempt.failed, forced: [],
      ...(lastSaveError ? { error: lastSaveError } : {}) }
  }
  if (patch.force === true) {
    if (isShortcutCaptureActive()) return retained('请先结束快捷键录制')
    if (probe?.status === 'system' && !probe.forceable) {
      const reason = getHotkeyOwner(wanted) ? '该组合键已被 eNest 内部功能占用，请先在对应设置中调整'
        : canForceHotkey(wanted).reason ?? '该组合键无法强制覆盖'
      lastSaveError = reason
      return retained(`无法强制覆盖：${reason}`)
    }
  }
  let replaced: HotkeyOwner | undefined
  if (!forceRequested && probe && (probe.status !== 'free' || patch?.overrideToken)) {
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
  let applied: QuickHotkeyApplyResult
  if (forceRequested) {
    const forced = applyForceHotkeys([{ accelerator: wanted, onFire: () => fireToggle(wanted) }])
    if (!forced.ok) return retained(forced.error ?? '强制覆盖失败')
    applyHotkeyChanges([{ owner, registration: null }])
    applied = { ok: true, enabled, hotkeys, activeHotkey: wanted,
      registered: isForceRegistered(wanted) ? [wanted] : [], failed: [], forced: [wanted] }
  } else {
    applied = replacement
      ? replacement.ok ? { ok: true, enabled, hotkeys, activeHotkey: wanted,
        registered: getOwnedHotkeyStatus(owner).status === 'registered' ? [wanted] : [], failed: [],
        systemConfirmationRequired: getOwnedHotkeyStatus(owner).status === 'pending-system' }
        : retained(replacement.error ?? '快捷键注册失败，已保留原配置')
      : applyQuickHotkeys(patch ?? {})
  }
  if (!applied.ok) { lastSaveError = applied.error; return applied }
  const config = { enabled: applied.enabled, hotkeys: applied.hotkeys, activeHotkey: applied.activeHotkey ?? '',
    forcedHotkeys: applied.forced?.length ? applied.forced : forcedHotkeys }
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

export function initQuickHotkeys(): void {
  lastSaveError = undefined
  unsubscribeForceStatus ??= onForceHotkeyStatusChange(() => {
    // 钩子就绪/退出会改变实际生效状态，设置页据此刷新「生效」徽标。
    try {
      const settings = readSettings()
      sendShellEvent({ type: 'quick-config-changed', enabled: settings.enabled, hotkeys: settings.hotkeys,
        activeHotkey: activeForcedHotkey(settings) ?? settings.activeHotkey })
    } catch (error) { logError('quick', `force status broadcast failed: ${String(error)}`) }
  })
  applyQuickHotkeys()
}

/** Called during application shutdown; includes capture leases and plugin registrations. */
export function disposeQuickHotkeys(): void {
  lastSaveError = undefined
  unsubscribeForceStatus?.()
  unsubscribeForceStatus = undefined
  applyForceHotkeys([])
  disposeHotkeyRegistry()
}

export function getQuickHotkeyConfig(): QuickHotkeyConfig {
  const { forcedHotkeys, ...settings } = readSettings()
  const registration = getOwnedHotkey(owner)
  const state = getOwnedHotkeyStatus(owner)
  const forcedAcc = forcedHotkeys.find(acc => isForceRegistered(acc))
  const forceStatus = getForceHotkeyStatus()
  const forcePending = settings.enabled && !forcedAcc && forcedHotkeys.includes(settings.activeHotkey)
  return { ...settings, platform: process.platform, activeHotkey: forcedAcc ?? registration?.accelerator ?? settings.activeHotkey,
    lastUsedHotkey,
    registered: forcedAcc ? [forcedAcc] : state.status === 'registered' && registration ? [registration.accelerator] : [],
    forced: forcedAcc ? [forcedAcc] : [],
    error: settings.enabled
      ? state.error ?? lastSaveError ?? (forcePending ? forceStatus.error ?? '强制接管服务启动中…' : undefined)
      : undefined,
    systemConfirmationRequired: state.status === 'pending-system' }
}

export function probeHotkey(acc: string): QuickHotkeyProbeResult {
  const conflict = probeShortcutConflict(acc, undefined, true)
  return { acc: conflict.accelerator, free: conflict.status === 'free', ours: !!getHotkeyOwner(conflict.accelerator),
    hint: pluginConflictHint(conflict.accelerator) ?? conflict.hint,
    ...(conflict.status === 'free' ? {} : { conflict }) }
}
