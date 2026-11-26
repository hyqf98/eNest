/** Own all native shortcuts here so capture and disposal preserve exact ownership. */
import { globalShortcut } from 'electron'
import { randomUUID } from 'node:crypto'
import { normalizeAccelerator } from '@shared/accelerator'
import { logError, logWarn } from '@main/logs/logService'

export interface HotkeyOwner {
  kind: 'quick' | 'runtime' | 'shortcut'
  id: string
  pluginId?: string
}
export interface HotkeyRegistration {
  owner: HotkeyOwner
  accelerator: string
  onFire: () => void | Promise<unknown>
}
export type HotkeyChange = { owner: HotkeyOwner; registration: HotkeyRegistration | null }
export interface HotkeyApplyResult { ok: boolean; error?: string }

const ownerKey = (owner: HotkeyOwner): string => `${owner.kind}:${owner.id}`
let registrations = new Map<string, HotkeyRegistration>()
let acceleratorRegistrations = new Map<string, HotkeyRegistration>()
const nativeKeys = new Set<string>()
const verifiedKeys = new Set<string>()
const nativeErrors = new Map<string, string>()
const captures = new Map<string, { ownerWcId: number; timer: ReturnType<typeof setTimeout> }>()
const listeners = new Set<() => void>()

export function onHotkeyRegistryChange(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

function changed(): void {
  for (const listener of listeners) {
    try { listener() } catch (error) { logWarn('hotkey', `state listener failed: ${String(error)}`) }
  }
}

export function sameHotkeyOwner(a: HotkeyOwner, b: HotkeyOwner): boolean {
  return ownerKey(a) === ownerKey(b)
}

export function getHotkeyRegistrations(): HotkeyRegistration[] {
  return [...registrations.values()]
}

export function getOwnedHotkey(owner: HotkeyOwner): HotkeyRegistration | undefined {
  return registrations.get(ownerKey(owner))
}

export function getHotkeyOwner(accelerator: string): HotkeyOwner | undefined {
  const acc = normalizeAccelerator(accelerator, process.platform)
  if (!acc) return undefined
  return acceleratorRegistrations.get(acc)?.owner
}

export function requiresSystemShortcutConfirmation(): boolean {
  return process.platform === 'linux' && (process.env.XDG_SESSION_TYPE === 'wayland' || !!process.env.WAYLAND_DISPLAY)
}

export function getOwnedHotkeyStatus(owner: HotkeyOwner): { status: 'registered' | 'pending-system' | 'suspended' | 'conflict' | 'missing'; error?: string } {
  const registration = getOwnedHotkey(owner)
  if (!registration) return { status: 'missing' }
  if (captures.size) return { status: 'suspended' }
  if (nativeKeys.has(registration.accelerator)) {
    if (requiresSystemShortcutConfirmation() && !verifiedKeys.has(registration.accelerator)) return { status: 'pending-system', error: '已提交系统，请在系统弹窗中确认后按快捷键测试。' }
    return { status: 'registered' }
  }
  return { status: 'conflict', error: nativeErrors.get(registration.accelerator) ?? '快捷键注册失败，可能已被其他应用占用' }
}

function registerNative(accelerator: string): void {
  const ok = globalShortcut.register(accelerator, () => {
    if (captures.size) return
    const registration = acceleratorRegistrations.get(accelerator)
    if (!registration) return
    if (requiresSystemShortcutConfirmation() && !verifiedKeys.has(accelerator)) { verifiedKeys.add(accelerator); changed() }
    try {
      void Promise.resolve(registration.onFire()).catch(error => logError('hotkey', `shortcut failed: ${String(error)}`))
    } catch (error) { logError('hotkey', `shortcut failed: ${String(error)}`) }
  })
  if (!ok) throw new Error(`快捷键 ${accelerator} 注册失败，可能已被系统或其他应用占用`)
  nativeKeys.add(accelerator)
  nativeErrors.delete(accelerator)
}

function unregisterNative(accelerator: string): void {
  globalShortcut.unregister(accelerator)
  nativeKeys.delete(accelerator)
  verifiedKeys.delete(accelerator)
}

/** Register additions before releasing previous keys; failure leaves the previous owners intact. */
export function applyHotkeyChanges(changes: HotkeyChange[]): HotkeyApplyResult {
  const next = new Map(registrations)
  for (const change of changes) {
    const key = ownerKey(change.owner)
    if (!change.registration) { next.delete(key); continue }
    if (!sameHotkeyOwner(change.owner, change.registration.owner)) return { ok: false, error: '快捷键归属不匹配' }
    const acc = normalizeAccelerator(change.registration.accelerator, process.platform)
    if (!acc) return { ok: false, error: '无效的快捷键' }
    next.set(key, { ...change.registration, accelerator: acc })
  }
  const desired = new Map<string, HotkeyRegistration>()
  for (const registration of next.values()) {
    if (desired.has(registration.accelerator)) return { ok: false, error: `快捷键 ${registration.accelerator} 已被 eNest 占用` }
    desired.set(registration.accelerator, registration)
  }
  if (captures.size) {
    registrations = next
    acceleratorRegistrations = desired
    changed()
    return { ok: true }
  }
  const added: string[] = []
  const removed: string[] = []
  try {
    const affectedOwners = new Set(changes.map(change => ownerKey(change.owner)))
    for (const [acc, registration] of desired) {
      if (nativeKeys.has(acc)) continue
      // A failed restore for another owner must not block unrelated settings changes.
      if (acceleratorRegistrations.has(acc) && !affectedOwners.has(ownerKey(registration.owner))) continue
      registerNative(acc)
      added.push(acc)
    }
    for (const acc of [...nativeKeys]) {
      if (desired.has(acc)) continue
      unregisterNative(acc)
      removed.push(acc)
    }
  } catch (error) {
    for (const acc of added) {
      try { unregisterNative(acc) } catch (rollbackError) { logWarn('hotkey', `rollback release failed: ${String(rollbackError)}`) }
    }
    for (const acc of removed) {
      try { registerNative(acc) } catch (rollbackError) { nativeErrors.set(acc, String(rollbackError)) }
    }
    changed()
    return { ok: false, error: (error as Error).message }
  }
  registrations = next
  acceleratorRegistrations = desired
  for (const acc of nativeErrors.keys()) if (!desired.has(acc)) nativeErrors.delete(acc)
  changed()
  return { ok: true }
}

/** Probe never releases keys owned by eNest, including temporarily suspended keys. */
export function probeNativeHotkey(accelerator: string): { free: boolean; ours: boolean; hint?: string } {
  const acc = normalizeAccelerator(accelerator, process.platform)
  if (!acc) return { free: false, ours: false, hint: '无效的快捷键' }
  if (getHotkeyOwner(acc)) return { free: true, ours: true }
  if (requiresSystemShortcutConfirmation()) return { free: true, ours: false, hint: '尚未检查系统占用；保存后由系统弹窗确认，请按快捷键测试。' }
  try {
    if (globalShortcut.isRegistered(acc)) return { free: true, ours: true }
    if (!globalShortcut.register(acc, () => undefined)) return { free: false, ours: false, hint: '已被系统或其他应用占用' }
    globalShortcut.unregister(acc)
    return { free: true, ours: false }
  } catch { return { free: false, ours: false, hint: '无效或不可用的快捷键' } }
}

function resumeCapturedHotkeys(): void {
  if (captures.size) { changed(); return }
  for (const registration of registrations.values()) {
    if (nativeKeys.has(registration.accelerator)) continue
    try { registerNative(registration.accelerator) }
    catch (error) { nativeErrors.set(registration.accelerator, (error as Error).message) }
  }
  changed()
}

export function beginShortcutCapture(ownerWcId: number): string {
  if (!Number.isInteger(ownerWcId) || ownerWcId <= 0) throw new Error('invalid capture owner')
  // Renewing the same renderer lease must not briefly restore its global shortcuts.
  for (const [token, capture] of captures) {
    if (capture.ownerWcId !== ownerWcId) continue
    clearTimeout(capture.timer)
    captures.delete(token)
  }
  const token = randomUUID()
  const timer = setTimeout(() => endShortcutCapture(token, ownerWcId), 30_000)
  timer.unref?.()
  captures.set(token, { ownerWcId, timer })
  try {
    for (const acc of [...nativeKeys]) unregisterNative(acc)
  } catch (error) {
    clearTimeout(timer)
    captures.delete(token)
    resumeCapturedHotkeys()
    throw error
  }
  changed()
  return token
}

export function endShortcutCapture(token: string, ownerWcId: number): void {
  const capture = captures.get(token)
  if (!capture || capture.ownerWcId !== ownerWcId) return
  clearTimeout(capture.timer)
  captures.delete(token)
  resumeCapturedHotkeys()
}

export function endShortcutCapturesForOwner(ownerWcId: number): void {
  for (const [token, capture] of captures) {
    if (capture.ownerWcId === ownerWcId) endShortcutCapture(token, ownerWcId)
  }
}

export function isShortcutCaptureActive(): boolean { return captures.size > 0 }

export function isShortcutCaptureActiveForOwner(ownerWcId: number): boolean {
  return [...captures.values()].some(capture => capture.ownerWcId === ownerWcId)
}

export function disposeHotkeyRegistry(): void {
  for (const capture of captures.values()) clearTimeout(capture.timer)
  captures.clear()
  try { globalShortcut.unregisterAll() }
  catch (error) { logWarn('hotkey', `unregisterAll failed: ${String(error)}`) }
  registrations.clear()
  acceleratorRegistrations.clear()
  nativeKeys.clear()
  verifiedKeys.clear()
  nativeErrors.clear()
  changed()
}
