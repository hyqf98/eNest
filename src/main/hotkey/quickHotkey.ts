/**
 * quickHotkey — 快捷启动全局热键
 * 职责：按设置注册/注销 Electron globalShortcut；
 * 互斥模型：仅注册「当前激活」的那一枚 accelerator，点选谁就谁生效。
 * 注册失败时回退列表中下一枚可用键；不引入原生输入监听。
 * 被 index.ts 启动调用，quickHandlers 更新设置时调用。
 * 关键依赖：globalShortcut、settingsStore、createQuickWindow、sendShellEvent。
 */
import { globalShortcut } from 'electron'
import type { QuickHotkeyApplyResult, QuickHotkeyConfig, QuickHotkeyProbeResult } from '@shared/types/quick'
import { defaultQuickHotkeys, settingsStore } from '../settings/SettingsStore'
import { sendShellEvent } from '../window/createShellWindow'
import { toggleQuickWindow } from '../window/createQuickWindow'
import { logError, logInfo, logWarn } from '../logs/logService'

/** 当前真正注册成功的 accelerator（互斥下最多一枚） */
let registeredHotkey = ''
let lastGoodHotkey = ''
/** 最近一次真正用来呼出小窗的 accelerator，供设置页展示 */
let lastUsedHotkey = ''

function fireToggle(acc: string): void {
  lastUsedHotkey = acc
  try {
    sendShellEvent({ type: 'quick-hotkey-used', acc })
  } catch (err) {
    logWarn('quick', `notify used failed: ${(err as Error).message}`)
  }
  try {
    toggleQuickWindow()
  } catch (err) {
    logError('quick', `toggle failed (${acc}): ${(err as Error).message}`)
  }
}

function readSettings(): { enabled: boolean; hotkeys: string[]; activeHotkey: string } {
  const general = settingsStore.getAll().general
  const ql = general.quickLauncher
  const defaults = defaultQuickHotkeys()
  const hotkeys =
    Array.isArray(ql?.hotkeys) && ql.hotkeys.length > 0 ? ql.hotkeys : defaults
  const active =
    ql?.activeHotkey && hotkeys.includes(ql.activeHotkey)
      ? ql.activeHotkey
      : (hotkeys.find((h) => !!h) ?? '')
  return { enabled: ql?.enabled !== false, hotkeys, activeHotkey: active }
}

function unregisterRegistered(): void {
  if (!registeredHotkey) return
  try {
    if (globalShortcut.isRegistered(registeredHotkey)) {
      globalShortcut.unregister(registeredHotkey)
    }
  } catch (err) {
    logWarn('quick', `unregister failed ${registeredHotkey}: ${(err as Error).message}`)
  }
  registeredHotkey = ''
}

/** 解析生效键：优先用户点选；空则列表首项 */
function resolveActive(
  preferred: string | undefined,
  hotkeys: string[]
): string {
  if (preferred && hotkeys.includes(preferred)) return preferred
  return hotkeys.find((h) => !!h) ?? ''
}

/**
 * 应用热键：互斥注册——只注册 activeHotkey 对应的那一枚。
 * 该枚失败时按列表顺序尝试后备；全部失败则不注册并上报。
 */
export function applyQuickHotkeys(
  patch?: Partial<{ enabled: boolean; hotkeys: string[]; activeHotkey: string }>
): QuickHotkeyApplyResult {
  const current = readSettings()
  const enabled = patch?.enabled ?? current.enabled
  const hotkeys =
    patch?.hotkeys && patch.hotkeys.length > 0 ? [...patch.hotkeys] : current.hotkeys
  const preferred =
    patch && 'activeHotkey' in patch ? patch.activeHotkey : current.activeHotkey
  const activeWanted = resolveActive(preferred, hotkeys)

  unregisterRegistered()

  if (!enabled) {
    lastGoodHotkey = ''
    logInfo('quick', 'hotkeys disabled')
    return {
      ok: true,
      enabled: false,
      hotkeys,
      registered: [],
      failed: [],
      activeHotkey: activeWanted
    }
  }

  if (!activeWanted) {
    logWarn('quick', 'no active hotkey to register')
    sendShellEvent({ type: 'quick-hotkey-failed', failed: hotkeys, registered: [] })
    return {
      ok: false,
      enabled,
      hotkeys,
      registered: [],
      failed: [...hotkeys],
      activeHotkey: '',
      error: '未选择生效快捷键'
    }
  }

  /** 注册顺序：先生效键，再按列表顺序后备（仅当生效键失败时） */
  const tryOrder = [activeWanted, ...hotkeys.filter((h) => h && h !== activeWanted)]
  const registered: string[] = []
  const failed: string[] = []
  let activeNow = ''

  for (const acc of tryOrder) {
    try {
      const ok = globalShortcut.register(acc, () => fireToggle(acc))
      if (ok) {
        registered.push(acc)
        registeredHotkey = acc
        activeNow = acc
        if (acc !== activeWanted) failed.push(activeWanted)
        break
      }
      failed.push(acc)
    } catch (err) {
      failed.push(acc)
      logError('quick', `register throw ${acc}: ${(err as Error).message}`)
    }
  }

  if (!activeNow && lastGoodHotkey) {
    try {
      if (globalShortcut.register(lastGoodHotkey, () => fireToggle(lastGoodHotkey))) {
        registered.push(lastGoodHotkey)
        registeredHotkey = lastGoodHotkey
        activeNow = lastGoodHotkey
      }
    } catch {
      /* ignore rollback errors */
    }
  }

  if (!activeNow) {
    sendShellEvent({ type: 'quick-hotkey-failed', failed: tryOrder, registered: [] })
    return {
      ok: false,
      enabled,
      hotkeys,
      registered: [],
      failed: tryOrder,
      activeHotkey: activeWanted,
      error: '快捷键注册失败'
    }
  }

  lastGoodHotkey = activeNow
  if (failed.length > 0) {
    sendShellEvent({ type: 'quick-hotkey-failed', failed, registered })
  }
  logInfo('quick', `hotkey active: ${activeNow} (wanted ${activeWanted})`)
  return {
    ok: true,
    enabled,
    hotkeys,
    registered,
    failed,
    activeHotkey: activeNow
  }
}

export function initQuickHotkeys(): void {
  applyQuickHotkeys()
}

export function disposeQuickHotkeys(): void {
  // 兜底：清掉本应用注册的全部全局键（含插件热键/历史残留），避免退出后仍能呼出
  try {
    globalShortcut.unregisterAll()
  } catch (err) {
    logWarn('quick', `unregisterAll failed: ${(err as Error).message}`)
    try {
      unregisterRegistered()
    } catch {
      /* ignore */
    }
  }
  registeredHotkey = ''
  lastGoodHotkey = ''
}

export function getQuickHotkeyConfig(): QuickHotkeyConfig {
  const { enabled, hotkeys, activeHotkey } = readSettings()
  return {
    enabled,
    hotkeys,
    platform: process.platform,
    activeHotkey: registeredHotkey || activeHotkey,
    lastUsedHotkey
  }
}

/** 常见系统/输入法占用提示（仅文案，不尝试抢系统键） */
function conflictHint(acc: string, platform: string): string | undefined {
  const a = acc.toLowerCase()
  if (platform === 'darwin') {
    if (a === 'command+space' || a === 'super+space') return '通常被 Spotlight 占用'
    if (a === 'control+space') return '常被中文输入法切换占用'
    if (a === 'command+tab') return '系统应用切换器，无法被应用注册'
    if (a === 'command+q' || a === 'command+w') return '系统/应用保留组合'
  } else {
    if (a === 'alt+tab') return '系统窗口切换，无法被应用注册'
    if (a === 'control+shift+escape') return '系统任务管理器'
  }
  return undefined
}

/**
 * 录制探测：临时 register 再立刻 unregister。
 * - ours：本应用已持有该键
 * - free=false：被系统或其他应用占用
 */
export function probeHotkey(acc: string): QuickHotkeyProbeResult {
  const platform = process.platform
  if (globalShortcut.isRegistered(acc)) {
    return { acc, free: true, ours: true, hint: undefined }
  }
  try {
    const ok = globalShortcut.register(acc, () => undefined)
    if (ok) {
      globalShortcut.unregister(acc)
      return { acc, free: true, ours: false }
    }
    return { acc, free: false, ours: false, hint: conflictHint(acc, platform) }
  } catch {
    return { acc, free: false, ours: false, hint: conflictHint(acc, platform) }
  }
}
