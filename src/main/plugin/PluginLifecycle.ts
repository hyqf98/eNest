/**
 * PluginLifecycle — 插件生命周期状态机（纯逻辑，无 Electron / IO 依赖）
 *
 * 为什么独立成模块：
 * 1. 状态转移表可单测、可文档化，PluginHost 只负责副作用（View / IPC / 日志）；
 * 2. 卸载路径 `any → clearing-storage → uninstalled` 与运行态正交，
 *    若混进 Host 会把「关闭视图」和「抹掉数据」两套语义搅在一起。
 *
 * 状态机（与 docs/engineering/LIFECYCLE_REVIEW.md §4 对齐，按任务规格扩展）：
 *
 *   installed → opening → ready → active ⇄ background → closing → closed
 *                                 ↘ crash          ↓ hibernate
 *   uninstall: any → clearing-storage → uninstalled  hibernated --open/reopen--> opening
 *
 * 休眠（hibernate）：后台空闲插件销毁渲染进程但保留逻辑 Tab 与 session 快照；
 * 唤醒（open）复用现有冷启动路径（opening → ready → active）。
 *
 * 对标 uTools：
 * - active/background 对应面板显隐；enter/out 成对，插件可 pause/resume
 * - closing/closed 对应 outPlugin(true) / 卸载杀死；crash 对应 render-process-gone
 */

/** 插件运行时状态 */
export type PluginLifecycleState =
  | 'installed'
  | 'opening'
  | 'ready'
  | 'active'
  | 'background'
  | 'hibernated'
  | 'closing'
  | 'closed'
  | 'crash'
  | 'clearing-storage'
  | 'uninstalled'

/** 触发状态转移的动作 */
export type PluginLifecycleAction =
  | 'open'
  | 'reload'
  | 'load-ok'
  | 'load-fail'
  | 'activate'
  | 'deactivate'
  | 'close'
  | 'destroyed'
  | 'crash'
  | 'hibernate'
  | 'uninstall'
  | 'uninstalled'

/**
 * 转移表：from + action → to。
 * 未列出的组合视为非法（nextState 返回 null），调用方应忽略或告警，不硬推。
 */
const TRANSITIONS: Record<
  PluginLifecycleState,
  Partial<Record<PluginLifecycleAction, PluginLifecycleState>>
> = {
  installed: {
    open: 'opening',
    uninstall: 'clearing-storage',
    close: 'closed',
    crash: 'crash'
  },
  opening: {
    'load-ok': 'ready',
    'load-fail': 'closed',
    reload: 'opening',
    close: 'closing',
    crash: 'crash',
    uninstall: 'clearing-storage'
  },
  ready: {
    activate: 'active',
    reload: 'opening',
    close: 'closing',
    crash: 'crash',
    uninstall: 'clearing-storage'
  },
  active: {
    deactivate: 'background',
    reload: 'opening',
    close: 'closing',
    crash: 'crash',
    uninstall: 'clearing-storage'
  },
  background: {
    activate: 'active',
    reload: 'opening',
    close: 'closing',
    crash: 'crash',
    hibernate: 'hibernated',
    uninstall: 'clearing-storage'
  },
  hibernated: {
    // 唤醒 = 冷启动语义，复用 open 路径（opening → ready → active）
    open: 'opening',
    reload: 'opening',
    close: 'closed',
    crash: 'crash',
    uninstall: 'clearing-storage'
  },
  closing: {
    destroyed: 'closed',
    crash: 'crash',
    uninstall: 'clearing-storage'
  },
  closed: {
    // 关闭后可再次打开（冷启动）；卸载时从 closed 也能进清理
    open: 'opening',
    uninstall: 'clearing-storage'
  },
  crash: {
    open: 'opening',
    close: 'closing',
    destroyed: 'closed',
    uninstall: 'clearing-storage'
  },
  'clearing-storage': {
    uninstalled: 'uninstalled'
  },
  uninstalled: {}
}

/** 计算下一状态；非法转移返回 null */
export function nextState(
  from: PluginLifecycleState,
  action: PluginLifecycleAction
): PluginLifecycleState | null {
  return TRANSITIONS[from][action] ?? null
}

/** 是否允许该转移 */
export function canTransition(
  from: PluginLifecycleState,
  action: PluginLifecycleAction
): boolean {
  return nextState(from, action) !== null
}

/** 初始状态：已安装、尚未打开 */
export const INITIAL_LIFECYCLE_STATE: PluginLifecycleState = 'installed'
