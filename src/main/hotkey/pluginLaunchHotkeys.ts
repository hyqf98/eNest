/**
 * pluginLaunchHotkeys — 每插件「快捷启动」配置的运行时消费端
 * 职责：settings.pluginLaunch（启动方式 / 全局启动热键 / 自定义触发词）：
 * - 启动热键注册表：独立于插件运行时 hotkey.register 的 pluginHotkeys——
 *   启动热键语义是「装了就能呼出」，不随插件休眠/关闭释放；
 * - 触发时按该插件配置的启动方式唤起（mode 缺省 quick = Quick 小窗内嵌）；
 * - 热键录制归属探测（其它插件启动键 → Quick 键 → 插件运行时键 → 系统），
 *   支持「接管」：清对方插件启动键 / 顶掉对方运行时键；Quick 键不可接管（引导改键）；
 * - 配置写入（校验 + 接管 + 持久化 + 重注册 + plugin-launch-changed 事件）。
 * 被 index.ts 启动调用（init）、shellHandlers 的 IPC 调用（探测/写入）、
 * quickHandlers/commandIndex（启动方式与触发词决策）、卸载/禁用路径（释放）。
 * 关键依赖：globalShortcut、settingsStore、pluginHost、PluginRegistry、
 * quickHotkey（probe/Quick 键查询）、pluginHandlers（运行时热键归属/接管）、
 * createQuickWindow / createShellWindow（唤起与事件）。
 */
import { globalShortcut } from 'electron'
import type {
  LaunchHotkeyProbeResult,
  PluginLaunchConfig,
  PluginLaunchMode,
  PluginLaunchPatch,
  PluginLaunchSettings
} from '@shared/types/plugin'
import { settingsStore } from '@main/settings/SettingsStore'
import { pluginHost } from '@main/plugin/PluginHost'
import { pluginRegistry } from '@main/plugin/PluginRegistry'
import { probeHotkey, getQuickHotkeyConfig } from '@main/hotkey/quickHotkey'
import {
  getRuntimeHotkeyOwner,
  takeoverRuntimeHotkey
} from '@main/hotkey/pluginRuntimeHotkeys'
import { showQuickWindow, hideQuickWindow } from '@main/window/createQuickWindow'
import { getMainWindow, sendShellEvent } from '@main/window/createShellWindow'
import { logError, logInfo, logWarn } from '@main/logs/logService'

/** 本模块持有的启动热键：pluginId → accelerator（每插件至多一枚） */
const registered = new Map<string, string>()

function pluginDisplayName(pluginId: string): string {
  return (
    pluginRegistry.get(pluginId)?.name ??
    pluginRegistry.getManifest(pluginId)?.name ??
    pluginId
  )
}

/** 读取全部插件启动配置（settings.pluginLaunch） */
export function getPluginLaunchSettings(): PluginLaunchSettings {
  return settingsStore.getAll().pluginLaunch ?? {}
}

/** 读取单插件启动配置 */
export function getPluginLaunch(pluginId: string): PluginLaunchConfig | undefined {
  return getPluginLaunchSettings()[pluginId]
}

/**
 * 启动方式覆盖项（已归一）：quick / shell；未配置或非法返回 undefined
 * （= 跟随入口：Quick 打开进小窗，主窗打开进大窗）。
 */
export function resolveLaunchMode(pluginId: string): PluginLaunchMode | undefined {
  const mode = getPluginLaunch(pluginId)?.mode
  return mode === 'quick' || mode === 'shell' ? mode : undefined
}

/** 用户自定义触发词（去空去重，小写化交由搜索侧统一归一） */
export function getPluginLaunchAliases(pluginId: string): string[] {
  const aliases = getPluginLaunch(pluginId)?.aliases
  if (!Array.isArray(aliases)) return []
  const seen = new Set<string>()
  const out: string[] = []
  for (const raw of aliases) {
    const a = String(raw ?? '').trim()
    if (!a || seen.has(a)) continue
    seen.add(a)
    out.push(a)
  }
  return out
}

/** 热键触发：按启动方式唤起插件（缺省 quick）；quick 时确保小窗可见 */
function fireLaunch(pluginId: string): void {
  const mode = resolveLaunchMode(pluginId) ?? 'quick'
  logInfo('launch-hotkey', `${pluginId} fired → ${mode}`)
  if (mode === 'quick') {
    // 必须先呼出再挂载：showQuickWindow 会重置列表态（隐藏全部 quick 视图），
    // 后调会把刚挂载的插件视图藏掉
    showQuickWindow()
  }
  void pluginHost
    .openPlugin(pluginId, undefined, { container: mode })
    .then(() => {
        if (mode === 'shell') {
          hideQuickWindow()
          const win = getMainWindow()
          if (win && !win.isDestroyed()) {
            if (win.isMinimized()) win.restore()
            win.show()
            win.focus()
          }
        }
      })
      .catch((err: Error) => {
        logError('launch-hotkey', `${pluginId} launch failed: ${err.message}`)
      })
}

/**
 * 全量重注册：注销本模块持有的键，再按 settings.pluginLaunch 逐插件注册。
 * 跳过未安装/已禁用插件（注册了也无法唤起）；单键失败仅记日志不中断。
 */
export function applyPluginLaunchHotkeys(): void {
  for (const [pid, acc] of registered) {
    try {
      if (globalShortcut.isRegistered(acc)) globalShortcut.unregister(acc)
    } catch {
      /* ignore */
    }
  }
  registered.clear()

  for (const [pluginId, cfg] of Object.entries(getPluginLaunchSettings())) {
    const acc = cfg?.hotkey?.trim()
    if (!acc) continue
    const summary = pluginRegistry.get(pluginId)
    if (!summary?.installed || summary.enabled === false) continue
    try {
      const ok = globalShortcut.register(acc, () => fireLaunch(pluginId))
      if (ok) {
        registered.set(pluginId, acc)
      } else {
        logWarn('launch-hotkey', `register failed: ${acc} (${pluginId})`)
      }
    } catch (err) {
      logWarn('launch-hotkey', `register throw ${acc}: ${(err as Error).message}`)
    }
  }
}

/** 启动时初始化（index.ts 调用） */
export function initPluginLaunchHotkeys(): void {
  applyPluginLaunchHotkeys()
}

/** 释放单插件启动热键（禁用/卸载时调用；配置保留，重新启用后重注册） */
export function releasePluginLaunchHotkey(pluginId: string): void {
  const acc = registered.get(pluginId)
  if (!acc) return
  try {
    if (globalShortcut.isRegistered(acc)) globalShortcut.unregister(acc)
  } catch {
    /* ignore */
  }
  registered.delete(pluginId)
}

/** 释放全部启动热键（before-quit 显式簿记清理；unregisterAll 兜底仍生效） */
export function releaseAllPluginLaunchHotkeys(): void {
  for (const [, acc] of registered) {
    try {
      globalShortcut.unregister(acc)
    } catch {
      /* ignore */
    }
  }
  registered.clear()
}

/** 清空单插件启动配置并释放热键（卸载时调用） */
export async function clearPluginLaunch(pluginId: string): Promise<void> {
  releasePluginLaunchHotkey(pluginId)
  if (!(pluginId in getPluginLaunchSettings())) return
  await settingsStore.setPluginLaunch(pluginId, null)
  sendShellEvent({ type: 'plugin-launch-changed', pluginId, config: null })
}

/**
 * 热键录制归属探测（归属链）：
 * 其它插件启动键（settings）→ Quick 当前生效键 → 插件运行时键 → 本进程其它 → 系统。
 * excludePluginId 用于录制中排除「自己当前的启动键」（重录同键 = 直接替换）。
 */
export function probeLaunchHotkey(
  acc: string,
  excludePluginId?: string
): LaunchHotkeyProbeResult {
  const normalized = String(acc ?? '').trim()
  if (!normalized) {
    return { acc: normalized, status: 'system', hint: '无效的组合键' }
  }

  // 1) 其它插件的启动热键（可接管：清对方配置）
  for (const [pid, cfg] of Object.entries(getPluginLaunchSettings())) {
    if (pid === excludePluginId) continue
    if (cfg?.hotkey?.trim() === normalized) {
      return {
        acc: normalized,
        status: 'plugin-launch',
        ownerPluginId: pid,
        ownerLabel: pluginDisplayName(pid),
        takeoverable: true
      }
    }
  }

  // 2) 壳子 Quick 热键（不可接管：顶掉会导致 Quick 呼不出，引导去 Quick 设置改键）
  const quick = getQuickHotkeyConfig()
  if (quick.activeHotkey && quick.activeHotkey === normalized) {
    return {
      acc: normalized,
      status: 'eNest-quick',
      ownerLabel: '快捷启动（Quick）热键',
      takeoverable: false
    }
  }

  // 3) 插件运行时自注册热键（hotkey.register；可接管：注销对方运行时键）
  const runtimeOwner = getRuntimeHotkeyOwner(normalized)
  if (runtimeOwner) {
    return {
      acc: normalized,
      status: 'plugin-runtime',
      ownerPluginId: runtimeOwner,
      ownerLabel: pluginDisplayName(runtimeOwner),
      takeoverable: true
    }
  }

  // 4) 本进程已持有但仍未归属（不含 excludePluginId 自己的旧启动键 = 允许替换）
  const probe = probeHotkey(normalized)
  if (probe.ours) {
    const own = excludePluginId ? getPluginLaunch(excludePluginId)?.hotkey : undefined
    if (own && own.trim() === normalized) {
      return { acc: normalized, status: 'free' }
    }
    return { acc: normalized, status: 'system', hint: '已被本应用其它功能占用' }
  }
  if (!probe.free) {
    return { acc: normalized, status: 'system', hint: probe.hint ?? '被系统或其他应用占用' }
  }
  return { acc: normalized, status: 'free' }
}

/** 探测结果的用户可读描述（IPC error 文案用） */
export function describeLaunchHotkeyProbe(probe: LaunchHotkeyProbeResult): string {
  switch (probe.status) {
    case 'free':
      return '可用'
    case 'eNest-quick':
      return `与快捷启动（Quick）热键冲突：${probe.acc}（请到 快捷启动设置 更换 Quick 热键）`
    case 'plugin-launch':
      return `已被插件「${probe.ownerLabel}」的启动热键占用：${probe.acc}（可选择接管）`
    case 'plugin-runtime':
      return `已被插件「${probe.ownerLabel}」的运行时热键占用：${probe.acc}（可选择接管）`
    default:
      return `无法注册 ${probe.acc}${probe.hint ? `：${probe.hint}` : '：被系统或其他应用占用'}`
  }
}

/**
 * 执行接管（仅 plugin-launch / plugin-runtime；调用方需先经用户确认）。
 * 返回被清键的插件 id（供调用方补发 plugin-launch-changed）。
 */
function doTakeover(
  probe: LaunchHotkeyProbeResult
): { ok: true; ownerPluginId?: string } | { ok: false; error: string } {
  if (probe.status === 'plugin-launch' && probe.ownerPluginId) {
    const owner = probe.ownerPluginId
    const current = getPluginLaunch(owner) ?? {}
    const { hotkey: _drop, ...rest } = current
    const restEmpty = !rest.mode && !(rest.aliases?.length)
    void settingsStore
      .setPluginLaunch(owner, restEmpty ? null : rest)
      .catch((err: Error) => logWarn('launch-hotkey', `takeover persist failed: ${err.message}`))
    logInfo('launch-hotkey', `takeover: removed launch hotkey of ${owner}`)
    return { ok: true, ownerPluginId: owner }
  }
  if (probe.status === 'plugin-runtime') {
    const taken = takeoverRuntimeHotkey(probe.acc)
    if (!taken) return { ok: false, error: '接管运行时热键失败' }
    return { ok: true, ownerPluginId: probe.ownerPluginId }
  }
  return { ok: false, error: '该键位不可接管' }
}

/** setPluginLaunch 返回体 */
export interface SetPluginLaunchResult {
  ok: boolean
  error?: string
  /** 冲突探测详情（失败时供渲染层展示归属与接管选项） */
  probe?: LaunchHotkeyProbeResult
  /** 成功后的最终配置（空配置返回 null） */
  config?: PluginLaunchConfig | null
}

/**
 * 写入单插件快捷启动配置（shell:set-plugin-launch 主进程侧实现）。
 * - patch 为增量合并；hotkey 传空串 = 清除；takeover=true 时对 plugin-launch /
 *   plugin-runtime 冲突执行接管（调用前 UI 必须先 probe 并向用户确认）。
 * - 冲突未接管 / 系统占用 / Quick 键冲突：不落盘，返回 probe 供 UI 展示。
 */
export async function setPluginLaunch(
  pluginId: string,
  patch: PluginLaunchPatch,
  opts?: { takeover?: boolean }
): Promise<SetPluginLaunchResult> {
  const id = String(pluginId ?? '').trim()
  if (!id) return { ok: false, error: 'pluginId required' }

  if (
    patch.mode !== undefined &&
    patch.mode !== null &&
    patch.mode !== 'quick' &&
    patch.mode !== 'shell'
  ) {
    return { ok: false, error: 'invalid mode' }
  }
  const nextHotkey =
    patch.hotkey === undefined ? undefined : String(patch.hotkey ?? '').trim()

  // 归一触发词：去空去重
  const normalizedAliases = (() => {
    if (patch.aliases === undefined) return undefined
    const seen = new Set<string>()
    const out: string[] = []
    for (const raw of patch.aliases) {
      const a = String(raw ?? '').trim()
      if (!a || seen.has(a)) continue
      seen.add(a)
      out.push(a)
    }
    return out
  })()

  let takeoverOwner: string | undefined
  if (nextHotkey) {
    const probe = probeLaunchHotkey(nextHotkey, id)
    if (probe.status !== 'free') {
      if (!probe.takeoverable || opts?.takeover !== true) {
        return { ok: false, error: describeLaunchHotkeyProbe(probe), probe }
      }
      const taken = doTakeover(probe)
      if (!taken.ok) return { ok: false, error: taken.error, probe }
      takeoverOwner = taken.ownerPluginId
    }
  }

  const current = getPluginLaunch(id) ?? {}
  const merged: PluginLaunchConfig = { ...current }
  // mode：显式 null = 清除（回到「跟随入口」）
  if (patch.mode !== undefined) {
    if (patch.mode === null) delete merged.mode
    else merged.mode = patch.mode
  }
  if (nextHotkey !== undefined) {
    if (nextHotkey) merged.hotkey = nextHotkey
    else delete merged.hotkey
  }
  if (normalizedAliases !== undefined) {
    if (normalizedAliases.length > 0) merged.aliases = normalizedAliases
    else delete merged.aliases
  }
  const isEmpty = !merged.mode && !merged.hotkey && !(merged.aliases?.length)

  await settingsStore.setPluginLaunch(id, isEmpty ? null : merged)
  applyPluginLaunchHotkeys()
  // 热键注册竞态兜底：注册失败如实回告（配置已保存，下次设置变更/重启会重试）
  if (merged.hotkey && !registered.has(id)) {
    logWarn('launch-hotkey', `${id}: config saved but hotkey not registered (${merged.hotkey})`)
  }

  sendShellEvent({ type: 'plugin-launch-changed', pluginId: id, config: isEmpty ? null : merged })
  if (takeoverOwner && takeoverOwner !== id) {
    const ownerCfg = getPluginLaunch(takeoverOwner) ?? null
    sendShellEvent({ type: 'plugin-launch-changed', pluginId: takeoverOwner, config: ownerCfg })
  }
  logInfo('launch-hotkey', `set ${id}: ${JSON.stringify(isEmpty ? null : merged)}`)
  return { ok: true, config: isEmpty ? null : merged }
}
