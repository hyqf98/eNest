/**
 * pluginRuntimeHotkeys — 插件运行时全局热键注册表
 * 职责：登记/注销插件经 enest.hotkey.register 注册的全局热键，供
 * PluginHost（closePlugin/hibernate/卸载释放）与 pluginLaunchHotkeys（冲突探测/接管）消费。
 * 独立于 pluginLaunchHotkeys（每插件启动热键，不随插件关闭释放，分账管理）。
 * 关键依赖：electron globalShortcut、quickHotkey（probeHotkey 冲突预检）。
 */
import { globalShortcut } from 'electron'
import { probeHotkey } from '@main/hotkey/quickHotkey'
import { logInfo, logWarn } from '@main/logs/logService'

/** 单插件可注册的全局热键上限（防滥用） */
const MAX_PLUGIN_HOTKEYS = 4

/**
 * 插件全局热键注册表：pluginId → accelerator 列表。
 * register 用 quickHotkey.probeHotkey 预检冲突（壳子 Quick 热键 ours=true 也算冲突，
 * 除非是同插件重复注册）；触发回调（onFire）由调用方注入（pluginHandlers 借此向
 * 该插件 webContents 推 plugin:event { type:'hotkey' }）。
 */
const pluginHotkeys = new Map<string, string[]>()

/** 注册插件全局热键：预检冲突 → globalShortcut.register → 记录归属 */
export function registerRuntimeHotkey(
  pluginId: string,
  accelerator: string,
  onFire: (accelerator: string) => void
): { ok: true } | { ok: false; error: string } {
  const acc = String(accelerator ?? '').trim()
  if (!acc) return { ok: false, error: 'accelerator required' }

  const mine = pluginHotkeys.get(pluginId) ?? []
  if (!mine.includes(acc)) {
    if (mine.length >= MAX_PLUGIN_HOTKEYS) {
      return { ok: false, error: `hotkey limit reached (max ${MAX_PLUGIN_HOTKEYS})` }
    }
    // 冲突检测：壳子 Quick 热键（ours）与其它应用占用（!free）都拒绝；
    // 本插件已注册的键（下面 includes 分支）走覆盖式重注册，不视为冲突
    const probe = probeHotkey(acc)
    if (probe.ours) {
      return { ok: false, error: `accelerator already in use (eNest): ${acc}` }
    }
    if (!probe.free) {
      return {
        ok: false,
        error: `accelerator unavailable${probe.hint ? `: ${probe.hint}` : ''}: ${acc}`
      }
    }
  }

  try {
    const ok = globalShortcut.register(acc, () => {
      logInfo('hotkey', `plugin ${pluginId} hotkey fired: ${acc}`)
      onFire(acc)
    })
    if (!ok) {
      // probe 与 register 之间存在竞态（他应用恰好抢占）——如实报失败
      return { ok: false, error: `accelerator registration failed: ${acc}` }
    }
  } catch (err) {
    return { ok: false, error: `accelerator invalid: ${(err as Error).message}` }
  }

  if (!mine.includes(acc)) {
    pluginHotkeys.set(pluginId, [...mine, acc])
  }
  return { ok: true }
}

/** 注销插件热键（单个）；未注册也返回 true（幂等） */
export function unregisterRuntimeHotkey(pluginId: string, accelerator: string): boolean {
  const acc = String(accelerator ?? '').trim()
  const mine = pluginHotkeys.get(pluginId)
  if (!mine) return true
  try {
    if (globalShortcut.isRegistered(acc)) globalShortcut.unregister(acc)
  } catch (err) {
    logWarn('hotkey', `unregister failed ${acc}: ${(err as Error).message}`)
  }
  const next = mine.filter((a) => a !== acc)
  if (next.length === 0) pluginHotkeys.delete(pluginId)
  else pluginHotkeys.set(pluginId, next)
  return true
}

/** 按 accelerator 反查运行时热键归属插件（无归属返回 undefined）；启动热键探测用 */
export function getRuntimeHotkeyOwner(accelerator: string): string | undefined {
  const acc = String(accelerator ?? '').trim()
  if (!acc) return undefined
  for (const [pid, list] of pluginHotkeys) {
    if (list.includes(acc)) return pid
  }
  return undefined
}

/**
 * 接管运行时热键：注销该键并从归属插件注册表移除（用户为另一插件配置启动热键时
 * 经冲突确认后调用）。键未被插件运行时持有时返回 false。
 */
export function takeoverRuntimeHotkey(accelerator: string): boolean {
  const owner = getRuntimeHotkeyOwner(accelerator)
  if (!owner) return false
  unregisterRuntimeHotkey(owner, accelerator)
  logInfo('hotkey', `runtime hotkey ${accelerator} taken over from ${owner}`)
  return true
}

/**
 * 批量释放插件注册的全部全局热键（closePlugin / hibernate / 卸载时
 * 由 PluginHost 在各销毁路径调用）。
 */
export function releasePluginHotkeys(pluginId: string): void {
  const mine = pluginHotkeys.get(pluginId)
  if (!mine || mine.length === 0) return
  for (const acc of mine) {
    try {
      if (globalShortcut.isRegistered(acc)) globalShortcut.unregister(acc)
    } catch (err) {
      logWarn('hotkey', `release failed ${acc}: ${(err as Error).message}`)
    }
  }
  pluginHotkeys.delete(pluginId)
}
