/**
 * Single writer of the low-level keyboard hook.
 *
 * Quick and plugin bindings each state which chords they want taken over; only this module writes
 * the hook. The hook holds one entry per virtual key and every write replaces the whole set, so two
 * owners writing it independently would erase each other on their next save.
 */
import { normalizeAccelerator } from '@shared/accelerator'
import type { PluginShortcutBinding } from '@shared/types/shortcuts'
import { defaultQuickHotkeys, settingsStore } from '@main/settings/SettingsStore'
import { pluginRegistry } from '@main/plugin/PluginRegistry'
import { applyForceHotkeys, forcedHotkeyKey, isForceRegistered, type ForceHotkeyEntry } from './forceHotkey'
import { getHotkeyOwner } from './hotkeyRegistry'

export type ForcedSource = 'quick' | 'plugin'

export interface ForcedChord {
  source: ForcedSource
  accelerator: string
  /** Binding id for plugins; undefined for Quick. */
  bindingId?: string
}

/** Chords configured on the hook. Only those whose helper is ready actually intercept keys. */
let held: ForcedChord[] = []

function quickForcedChord(): ForcedChord | undefined {
  const settings = settingsStore.getQuickLauncherSettings()
  if (settings.enabled !== true) return undefined
  const hotkeys = Array.isArray(settings.hotkeys) && settings.hotkeys.length
    ? settings.hotkeys.map(key => normalizeAccelerator(key, process.platform)).filter((key): key is string => !!key)
    : defaultQuickHotkeys()
  const authorized = (Array.isArray(settings.forcedHotkeys) ? settings.forcedHotkeys : [])
    .map(key => normalizeAccelerator(key, process.platform))
    .filter((key): key is string => !!key && hotkeys.includes(key))
  if (!authorized.length) return undefined
  // Only the chord Quick is on may be held; an authorized but inactive preset stays released.
  const acc = normalizeAccelerator(settings.activeHotkey, process.platform)
  if (!acc || !authorized.includes(acc) || getHotkeyOwner(acc)) return undefined
  return { source: 'quick', accelerator: acc }
}

export interface QuickIntent { accelerator: string }

export interface ForcedIntent {
  /** Quick's real intent before its settings are persisted: `null` releases, a chord takes over. */
  quick?: QuickIntent | null
  /** The bindings about to be persisted. Without it the stored bindings are read. */
  bindings?: PluginShortcutBinding[]
}

/** Chords the hook should hold now: one per authorized owner that normal registration could not get. */
function forcedChords(intent: ForcedIntent = {}): ForcedChord[] {
  const chords: ForcedChord[] = []
  // Callers that have not persisted yet pass the real intent; otherwise it is read from settings.
  const quick = intent.quick === null ? undefined : intent.quick ?? quickForcedChord()
  if (quick) chords.push({ source: 'quick', accelerator: quick.accelerator })
  for (const binding of intent.bindings ?? settingsStore.getPluginShortcuts()) {
    // The authorization only applies while the binding is active and its key is free of eNest owners.
    if (!binding.forced || !binding.enabled) continue
    const plugin = pluginRegistry.get(binding.pluginId)
    if (!plugin?.installed || plugin.enabled === false) continue
    const acc = normalizeAccelerator(binding.accelerator, process.platform)
    if (!acc || getHotkeyOwner(acc)) continue
    chords.push({ source: 'plugin', accelerator: acc, bindingId: binding.id })
  }
  return chords
}

/** The owner currently holding a chord through the hook. Undefined until the helper is ready. */
export function forcedChordOwner(accelerator: string): ForcedChord | undefined {
  const acc = normalizeAccelerator(accelerator, process.platform)
  if (!acc || !isForceRegistered(acc)) return undefined
  return held.find(chord => chord.accelerator === acc)
}

/** The owner the hook is configured to hold, whether or not the helper is ready yet. */
export function configuredChordOwner(accelerator: string): ForcedChord | undefined {
  const acc = normalizeAccelerator(accelerator, process.platform)
  return acc ? held.find(chord => chord.accelerator === acc) : undefined
}

/*
 * Owners register their own dispatch instead of being imported: this module reads the settings and
 * registry they sit beside, so importing them back would close a module cycle.
 */
const quickFire: { current?: (accelerator: string) => void } = {}
const pluginFire: { current?: (bindingId: string) => void } = {}

/** Register once at owner init; a newer registration replaces the previous one. */
export function registerForcedDispatcher(source: ForcedSource, fire: (arg: string) => void): void {
  ;(source === 'quick' ? quickFire : pluginFire).current = fire
}

export interface ForcedSync {
  /** The hook accepted the configuration. It does not mean the helper is ready yet. */
  ok: boolean
  error?: string
  /** Chords configured on the hook, in priority order. */
  chords: ForcedChord[]
}

/**
 * Reconcile the hook with what both sides want now.
 * `intent` states what is about to be persisted, so a takeover can be tried before it is saved.
 * Fires are routed back by chord identity, so each owner keeps its own guards.
 */
export function syncForcedHotkeys(intent: ForcedIntent = {}): ForcedSync {
  const keys = new Set<number>()
  const entries: ForceHotkeyEntry[] = []
  const chords: ForcedChord[] = []
  for (const chord of forcedChords(intent)) {
    const key = forcedHotkeyKey(chord.accelerator)
    const fire = chord.source === 'quick' ? quickFire.current : pluginFire.current
    // A second chord on an already-held key cannot be told apart by the hook and is left alone.
    if (key === undefined || keys.has(key) || !fire) continue
    keys.add(key)
    chords.push(chord)
    const argument = chord.source === 'quick' ? chord.accelerator : chord.bindingId!
    entries.push({ accelerator: chord.accelerator, onFire: () => fire(argument) })
  }
  const result = applyForceHotkeys(entries)
  held = result.ok ? chords : []
  return result.ok ? { ok: true, chords } : { ok: false, error: result.error, chords: [] }
}
