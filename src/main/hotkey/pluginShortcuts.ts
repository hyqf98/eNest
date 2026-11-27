/** User-owned plugin bindings. Native registration is lazy and never launches a plugin. */
import { randomUUID } from 'node:crypto'
import { normalizeAccelerator, normalizeUserShortcut } from '@shared/accelerator'
import type {
  PluginShortcutBinding, PluginShortcutInput, PluginShortcutLaunchResult,
  PluginShortcutMutationResult, PluginShortcutsSnapshot, PluginShortcutState, ShortcutProbeResult
} from '@shared/types/shortcuts'
import { defaultQuickHotkeys, settingsStore } from '@main/settings/SettingsStore'
import { pluginRegistry } from '@main/plugin/PluginRegistry'
import { launchPlugin } from '@main/launcher/pluginLauncher'
import { sendShellEvent } from '@main/window/createShellWindow'
import { logWarn } from '@main/logs/logService'
import {
  applyHotkeyChanges, getHotkeyOwner, getHotkeyRegistrations, getOwnedHotkey,
  getOwnedHotkeyStatus, isShortcutCaptureActive, onHotkeyRegistryChange,
  type HotkeyChange, type HotkeyOwner, type HotkeyRegistration
} from './hotkeyRegistry'
import { consumeShortcutOverride, overrideOwner, probeShortcutConflict } from './shortcutConflicts'
import { listRuntimeHotkeys } from './pluginRuntimeHotkeys'
import { canForceHotkey } from './forceHotkey'
import { configuredChordOwner, registerForcedDispatcher, syncForcedHotkeys, type ForcedSync } from './forcedHotkeys'

export { beginShortcutCapture, endShortcutCapture, endShortcutCapturesForOwner } from './hotkeyRegistry'

const bindingOwner = (binding: Pick<PluginShortcutBinding, 'id' | 'pluginId'>): HotkeyOwner => ({
  kind: 'shortcut', id: binding.id, pluginId: binding.pluginId
})
const failures = new Map<string, string>()
let bindingIndex = new Map<string, PluginShortcutBinding>()
let pendingMutation: Promise<unknown> = Promise.resolve()
let unsubscribeRegistry: (() => void) | undefined
let unsubscribePlugins: (() => void) | undefined
let publishPending = false
let forcePublish = false
let lastSnapshot = ''

function remember(bindings: PluginShortcutBinding[]): void {
  bindingIndex = new Map(bindings.map(binding => [binding.id, binding]))
}

function inactiveState(binding: PluginShortcutBinding): PluginShortcutState | undefined {
  if (!binding.enabled) return { id: binding.id, status: 'disabled' }
  const plugin = pluginRegistry.get(binding.pluginId)
  if (!plugin?.installed) return { id: binding.id, status: 'plugin-missing', error: '插件未安装' }
  if (plugin.enabled === false) return { id: binding.id, status: 'plugin-disabled', error: '插件已停用' }
  return undefined
}

export function getPluginShortcuts(): PluginShortcutsSnapshot {
  const bindings = settingsStore.getPluginShortcuts()
  const states: PluginShortcutState[] = bindings.map(binding => {
    const inactive = inactiveState(binding)
    if (inactive) return inactive
    // A binding held by the hook has no normal registration, so it is asked about first.
    if (configuredChordOwner(binding.accelerator)?.bindingId === binding.id) return { id: binding.id, status: 'forced' }
    const registration = getOwnedHotkey(bindingOwner(binding))
    const state = getOwnedHotkeyStatus(bindingOwner(binding))
    if (registration?.accelerator === normalizeAccelerator(binding.accelerator, process.platform) && state.status !== 'missing') {
      return { id: binding.id, status: state.status, ...(state.error ? { error: state.error } : {}) }
    }
    return { id: binding.id, status: 'conflict', error: failures.get(binding.id) ?? '快捷键尚未注册，请检查占用后重试' }
  })
  return { bindings, states, runtime: listRuntimeHotkeys() }
}

function publish(force = false): void {
  forcePublish ||= force
  if (publishPending) return
  publishPending = true
  queueMicrotask(() => {
    publishPending = false
    const forced = forcePublish
    forcePublish = false
    const snapshot = getPluginShortcuts()
    const signature = JSON.stringify(snapshot)
    // Quick has its own registration state; capture must also notify a page with no bindings.
    if (!forced && signature === lastSnapshot) return
    lastSnapshot = signature
    sendShellEvent({ type: 'plugin-shortcuts-changed', snapshot })
  })
}

function registrationFor(binding: PluginShortcutBinding): HotkeyRegistration {
  return { owner: bindingOwner(binding), accelerator: binding.accelerator,
    onFire: () => launchBoundShortcut(binding.id, 'shortcut') }
}

export function probePluginShortcut(accelerator: string, excludeId?: string): ShortcutProbeResult {
  return probeShortcutConflict(accelerator, excludeId)
}

function describeProbe(probe: ShortcutProbeResult): string {
  if (probe.status === 'invalid') return probe.hint ?? '无效的快捷键'
  if (probe.status === 'system') return probe.hint ?? '快捷键已被系统或其他应用占用'
  return `快捷键已被${probe.ownerLabel ? `「${probe.ownerLabel}」` : '其他绑定'}占用，请更换组合键`
}

function serialize<T>(operation: () => T): Promise<T> {
  const result = pendingMutation.then(operation, operation)
  pendingMutation = result.catch(() => undefined)
  return result
}

/** A failed durable write cannot leave an unsaved replacement shortcut active. */
function restoreAfterWriteFailure(previous: HotkeyChange[], error: unknown): string {
  // Restore both sides together when a confirmed replacement transferred an existing key.
  const all = applyHotkeyChanges(previous)
  if (all.ok) return String(error)
  applyHotkeyChanges(previous.map(item => ({ owner: item.owner, registration: null })))
  const restoreErrors: string[] = []
  // Restore independently: one OS-level conflict must not suppress other deleted bindings.
  for (const original of previous) {
    const restored = applyHotkeyChanges([original])
    if (restored.ok) {
      failures.delete(original.owner.id)
      continue
    }
    const unsaved = getOwnedHotkey(original.owner)
    const released = applyHotkeyChanges([{ owner: original.owner, registration: null }])
    let message = `设置未保存，原快捷键${original.registration ? ` ${original.registration.accelerator}` : ''}恢复失败：${restored.error ?? '键位已被占用'}`
    if (!released.ok) message += `；未保存快捷键 ${unsaved?.accelerator ?? ''} 释放失败：${released.error}`
    failures.set(original.owner.id, message)
    restoreErrors.push(message)
  }
  return `${String(error)}${restoreErrors.length ? `；${restoreErrors.join('；')}` : ''}`
}

export function savePluginShortcut(input: PluginShortcutInput): Promise<PluginShortcutMutationResult> {
  return serialize(() => {
    if (!input || typeof input !== 'object' || typeof input.pluginId !== 'string'
      || (input.mode !== 'quick' && input.mode !== 'shell') || typeof input.enabled !== 'boolean'
      || (input.id !== undefined && (typeof input.id !== 'string' || !input.id))
      || (input.overrideToken !== undefined && (typeof input.overrideToken !== 'string' || !input.overrideToken))
      || (input.force !== undefined && typeof input.force !== 'boolean')) {
      return { ok: false, error: '快捷键配置无效' }
    }
    if (isShortcutCaptureActive()) return { ok: false, error: '请先结束快捷键录制' }
    const acc = normalizeUserShortcut(input.accelerator, process.platform)
    if (!acc) return { ok: false, error: '快捷键需包含 Ctrl、Alt、Command 或 Super 等修饰键' }
    const bindings = settingsStore.getPluginShortcuts()
    const old = input.id ? bindings.find(binding => binding.id === input.id) : undefined
    if (input.id && !old) return { ok: false, error: '快捷键绑定不存在，请刷新后重试', snapshot: getPluginShortcuts() }
    const pluginId = input.pluginId.trim()
    const plugin = pluginRegistry.get(pluginId)
    if (!plugin?.installed && !(old && old.pluginId === pluginId && !input.enabled)) {
      return { ok: false, error: '插件未安装，无法绑定快捷键' }
    }
    if (!old && bindings.length >= 256) return { ok: false, error: '快捷键绑定已达到上限（256 条）' }
    const inactive = !input.enabled || !plugin?.installed || plugin.enabled === false
    // The authorization follows the chord, not the request: it survives edits that keep the same
    // key (mode, on/off) and is dropped by any other chord. `forced` from the caller never counts.
    const keepsForced = old?.forced === true && normalizeAccelerator(old.accelerator, process.platform) === acc
    const binding: PluginShortcutBinding = { id: old?.id ?? randomUUID(), pluginId,
      accelerator: acc, mode: input.mode, enabled: input.enabled, ...(keepsForced ? { forced: true } : {}) }
    const probe = inactive ? undefined : probePluginShortcut(acc, binding.id)
    // A takeover is only meaningful for an externally occupied chord. If the other app released the
    // key meanwhile, the request is simply dropped and the binding is saved normally, as Quick does.
    const forceableRequest = input.force === true && probe?.status === 'system'
    if (input.force === true && !probe) return { ok: false, error: '已关闭的快捷键无需强制覆盖，请先启用它', snapshot: getPluginShortcuts() }
    if (forceableRequest) {
      if (!probe!.forceable) {
        const reason = getHotkeyOwner(acc) ? '该组合键已被 eNest 内部功能占用，请先在对应设置中调整'
          : canForceHotkey(acc).reason ?? '该组合键无法强制覆盖'
        return { ok: false, error: `无法强制覆盖：${reason}`, probe, snapshot: getPluginShortcuts() }
      }
      return forcePluginShortcut({ ...binding, forced: true })
    }
    /*
     * Re-enabling or re-saving an already authorized chord needs no second confirmation: the user
     * granted it before. This mirrors the restore path and Quick's own behavior, so a takeover
     * survives being switched off and on while the other app still holds the key.
     */
    if (keepsForced && probe?.status === 'system' && probe.forceable) return forcePluginShortcut(binding)
    let conflict: ShortcutProbeResult | undefined
    if (probe && (probe.status !== 'free' || input.overrideToken)) {
      if (!consumeShortcutOverride(input.overrideToken, probe)) return { ok: false,
        error: input.overrideToken ? '快捷键占用已变化或确认已过期，请重新检查后确认。' : describeProbe(probe), probe, snapshot: getPluginShortcuts() }
      conflict = probe
    }
    const owner = bindingOwner(binding)
    const replaced = conflict && overrideOwner(conflict)
    const changes: HotkeyChange[] = [{ owner, registration: inactive ? null : registrationFor(binding) },
      ...(replaced ? [{ owner: replaced, registration: null }] : [])]
    const previous = changes.map(change => ({ owner: change.owner, registration: getOwnedHotkey(change.owner) ?? null }))
    // Built before anything changes: it states the intent to the hook, which cannot read unsaved settings.
    const next = (old ? bindings.map(item => item.id === binding.id ? binding : item) : [...bindings, binding])
      .map(item => item.id === conflict?.ownerBindingId ? { ...item, enabled: false } : item)
    // Any authorized binding may be affected by this save (a chord change, an on/off switch, or a
    // new binding sharing its key), so the hook is restated whenever one exists.
    const wasForced = bindings.some(item => item.forced)
    const synced = wasForced ? syncForcedHotkeys({ bindings: next }) : undefined
    if (synced && !synced.ok) return { ok: false, error: synced.error, snapshot: getPluginShortcuts() }
    const applied = applyHotkeyChanges(changes)
    if (!applied.ok) {
      if (wasForced) syncForcedHotkeys()
      return { ok: false, error: applied.error, snapshot: getPluginShortcuts() }
    }
    const quick = conflict?.status === 'quick' ? settingsStore.getQuickLauncherSettings() : undefined
    const quickConfig = conflict?.status === 'quick' ? { enabled: false, hotkeys: quick?.hotkeys ?? defaultQuickHotkeys(),
      activeHotkey: quick?.activeHotkey ?? acc } : undefined
    try { if (replaced) settingsStore.setShortcutConfiguration(next, quickConfig); else settingsStore.setPluginShortcuts(next) }
    catch (error) {
      if (wasForced) syncForcedHotkeys()
      return { ok: false, error: restoreAfterWriteFailure(previous, error), snapshot: getPluginShortcuts() }
    }
    // The save changed which keys are registered, so the hook is aligned with the saved state.
    if (wasForced) syncForcedHotkeys()
    remember(next)
    failures.delete(binding.id)
    if (quickConfig) sendShellEvent({ type: 'quick-config-changed', ...quickConfig })
    publish()
    return { ok: true, binding, snapshot: getPluginShortcuts() }
  })
}

/**
 * Take an externally occupied chord over with the keyboard hook, on the user's explicit request.
 * `binding.forced` is trusted here only because the caller sets it after verifying the request.
 */
function forcePluginShortcut(binding: PluginShortcutBinding): PluginShortcutMutationResult {
  const bindings = settingsStore.getPluginShortcuts()
  const owner = bindingOwner(binding)
  const previousRegistration = getOwnedHotkey(owner) ?? null
  const old = bindings.find(item => item.id === binding.id)
  // The hook only takes chords no eNest owner holds, so this binding's normal key is released first.
  const released = applyHotkeyChanges([{ owner, registration: null }])
  if (!released.ok) return { ok: false, error: released.error, snapshot: getPluginShortcuts() }
  const next = (old ? bindings.map(item => item.id === binding.id ? binding : item) : [...bindings, binding])
  // The new bindings are passed as intent: they are saved only once the hook really took the chord.
  const synced: ForcedSync = syncForcedHotkeys({ bindings: next })
  const restore = (): void => { applyHotkeyChanges([{ owner, registration: previousRegistration }]); syncForcedHotkeys() }
  if (!synced.ok || !synced.chords.some(chord => chord.bindingId === binding.id)) {
    restore()
    const error = synced.error ?? (getHotkeyOwner(binding.accelerator)
      ? '该组合键已被 eNest 内部功能占用，请先在对应设置中调整' : '该组合键无法强制覆盖')
    return { ok: false, error, snapshot: getPluginShortcuts() }
  }
  try { settingsStore.setPluginShortcuts(next) }
  catch (error) {
    // Never leave an unsaved takeover intercepting keys: restore both the hook and the normal key.
    restore()
    return { ok: false, error: `快捷键设置保存失败：${error instanceof Error ? error.message : String(error)}`, snapshot: getPluginShortcuts() }
  }
  // The hook and the settings page both fire by binding id: without this the key press finds nothing.
  remember(next)
  failures.delete(binding.id)
  publish()
  return { ok: true, binding, snapshot: getPluginShortcuts() }
}

export function removePluginShortcut(id: string): Promise<PluginShortcutMutationResult> {
  return serialize(() => removeBindings(binding => binding.id === id))
}

function removeBindings(matches: (binding: PluginShortcutBinding) => boolean): PluginShortcutMutationResult {
  const bindings = settingsStore.getPluginShortcuts()
  const removed = bindings.filter(matches)
  if (!removed.length) return { ok: true, snapshot: getPluginShortcuts() }
  const previous = removed.map(binding => ({ owner: bindingOwner(binding), registration: getOwnedHotkey(bindingOwner(binding)) ?? null }))
  const next = bindings.filter(binding => !matches(binding))
  // A deleted binding must stop being taken over too; its removal is stated before it is saved.
  const removedForced = removed.some(binding => binding.forced)
  const synced = removedForced ? syncForcedHotkeys({ bindings: next }) : undefined
  if (synced && !synced.ok) return { ok: false, error: synced.error, snapshot: getPluginShortcuts() }
  const result = applyHotkeyChanges(removed.map(binding => ({ owner: bindingOwner(binding), registration: null })))
  if (!result.ok) {
    if (synced) syncForcedHotkeys()
    return { ok: false, error: result.error, snapshot: getPluginShortcuts() }
  }
  try { settingsStore.setPluginShortcuts(next) }
  catch (error) {
    if (synced) syncForcedHotkeys()
    return { ok: false, error: restoreAfterWriteFailure(previous, error), snapshot: getPluginShortcuts() }
  }
  remember(next)
  for (const binding of removed) failures.delete(binding.id)
  publish()
  return { ok: true, snapshot: getPluginShortcuts() }
}

async function launchBoundShortcut(id: string, source: 'shortcut' | 'settings'): Promise<PluginShortcutLaunchResult> {
  const binding = bindingIndex.get(id)
  if (!binding) return { ok: false, error: '快捷键绑定不存在' }
  if (source === 'shortcut' && (!binding.enabled || isShortcutCaptureActive())) return { ok: false, cancelled: true }
  const plugin = pluginRegistry.get(binding.pluginId)
  if (!plugin?.installed || plugin.enabled === false) return { ok: false, error: '插件未安装或已停用' }
  return launchPlugin({ pluginId: binding.pluginId, mode: binding.mode, source })
}

/** The hook routes a plugin takeover here; the same guards as a normal key press apply. */
function fireForcedBinding(id: string): void {
  void launchBoundShortcut(id, 'shortcut')
}

export function launchPluginShortcut(id: string): Promise<PluginShortcutLaunchResult> {
  return launchBoundShortcut(id, 'settings')
}

/** Registry changes only reconcile affected keys; a failed binding never blocks its peers. */
export function reconcilePluginShortcuts(): void {
  const bindings = settingsStore.getPluginShortcuts()
  remember(bindings)
  const active = new Map(bindings.filter(binding => !inactiveState(binding)).map(binding => [binding.id, binding]))
  const stale = getHotkeyRegistrations().filter(item => item.owner.kind === 'shortcut' && !active.has(item.owner.id))
  if (stale.length) applyHotkeyChanges(stale.map(item => ({ owner: item.owner, registration: null })))
  for (const binding of active.values()) {
    if (!normalizeUserShortcut(binding.accelerator, process.platform)) {
      applyHotkeyChanges([{ owner: bindingOwner(binding), registration: null }])
      failures.set(binding.id, '快捷键需包含 Ctrl、Alt、Command 或 Super 等修饰键')
      continue
    }
    const existing = getOwnedHotkey(bindingOwner(binding))
    const status = getOwnedHotkeyStatus(bindingOwner(binding)).status
    if (existing?.accelerator === normalizeAccelerator(binding.accelerator, process.platform)
      && (status === 'registered' || status === 'pending-system' || status === 'suspended')) continue
    const result = applyHotkeyChanges([{ owner: bindingOwner(binding), registration: registrationFor(binding) }])
    if (result.ok) { failures.delete(binding.id); continue }
    failures.set(binding.id, result.error ?? '快捷键注册失败')
    const previous = getOwnedHotkey(bindingOwner(binding))
    if (previous && previous.accelerator !== normalizeAccelerator(binding.accelerator, process.platform)) {
      applyHotkeyChanges([{ owner: bindingOwner(binding), registration: null }])
    }
  }
  /*
   * 对齐低级键盘钩子，与小窗口的恢复逻辑一致：
   * 已授权强制接管的绑定，普通注册失败且确属外部占用时回落到钩子；
   * 原先由钩子持有、现在能普通注册的键交还；绑定被停用、卸载或删除时释放。
   * 无条件执行：释放恰恰发生在"这条绑定不再活动或不再带授权"的时候，
   * 若只在仍有授权时才对齐，钩子里会留下孤儿条目继续吞别的程序的键。
   */
  syncForcedHotkeys()
  for (const id of failures.keys()) if (!active.has(id)) failures.delete(id)
  publish()
}

export function releasePluginShortcuts(pluginId: string): void {
  const owned = getHotkeyRegistrations().filter(item => item.owner.kind === 'shortcut' && item.owner.pluginId === pluginId)
  if (owned.length) applyHotkeyChanges(owned.map(item => ({ owner: item.owner, registration: null })))
  publish()
}

export function removePluginShortcuts(pluginId: string): Promise<PluginShortcutMutationResult> {
  return serialize(() => removeBindings(binding => binding.pluginId === pluginId))
}

export function initPluginShortcuts(): void {
  // Registered before any reconcile: the hook skips an owner whose dispatch is not yet known,
  // and Quick's own init may sync the hook first.
  registerForcedDispatcher('plugin', fireForcedBinding)
  unsubscribeRegistry ??= onHotkeyRegistryChange(() => publish(true))
  unsubscribePlugins ??= pluginRegistry.onInstalledChanged(reconcilePluginShortcuts)
  reconcilePluginShortcuts()
}

export function disposePluginShortcuts(): void {
  // Plugin takeovers must not outlive their registrations: release them with the normal keys.
  syncForcedHotkeys({ bindings: [] })
  unsubscribeRegistry?.()
  unsubscribeRegistry = undefined
  unsubscribePlugins?.()
  unsubscribePlugins = undefined
  const owned = getHotkeyRegistrations().filter(item => item.owner.kind === 'shortcut')
  const result = applyHotkeyChanges(owned.map(item => ({ owner: item.owner, registration: null })))
  if (!result.ok) logWarn('shortcut', result.error ?? 'shortcut disposal failed')
  bindingIndex.clear()
  failures.clear()
}
