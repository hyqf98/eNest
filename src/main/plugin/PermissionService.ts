/**
 * PermissionService — 插件运行时权限弹窗仲裁（壳层三态的 'ask' 分支）
 * 职责：plugin:call 在 grant='ask' 时经 request() 向壳渲染层发 permission-request
 *       事件，等待用户三按钮决策（once / always / deny）；
 *       同一插件同时只挂起一个请求（后续排队），60s 超时按本次拒绝（不持久化）。
 * 响应通道：IpcChannels.PermissionResponse（handler 校验 requestId 有效且属当前
 *       挂起项，只接受壳窗口 sender），由 registerPermissionHandlers 注册。
 * 关键依赖：SettingsStore（授权持久化）、createShellWindow.sendShellEvent。
 */
import type {
  PluginPermission,
  PluginPermissionGrant
} from '@shared/types/plugin'
import { settingsStore } from '@main/settings/SettingsStore'
import { getMainWindow, sendShellEvent } from '@main/window/createShellWindow'
import { logInfo, logWarn } from '@main/logs/logService'

/** 弹窗超时：超时按本次拒绝（不持久化），避免插件调用挂死 */
const REQUEST_TIMEOUT_MS = 60_000

/** 弹窗决策（渲染层三按钮） */
export type PermissionDecision = 'once' | 'always' | 'deny'

interface PendingRequest {
  requestId: string
  pluginId: string
  permission: PluginPermission
  resolve: (allowed: boolean) => void
  timer: NodeJS.Timeout
}

/** 自增请求序号（requestId 仅需进程内唯一） */
let requestSeq = 0

export class PermissionService {
  /** pluginId → 待发请求队列（队首即挂起中的弹窗） */
  private queues = new Map<string, PendingRequest[]>()
  /** requestId → 挂起项（响应路由用） */
  private pending = new Map<string, PendingRequest>()

  /**
   * 请求一项权限的放行决策：
   * - grant='allow' → true；'deny' → false（均不弹窗）
   * - 'ask' → 发 permission-request 事件给壳渲染层并等待回应；
   *   同插件已有挂起请求时排队，前一个 settle 后再弹出。
   */
  async request(
    pluginId: string,
    perm: PluginPermission,
    summary: string,
    osHint?: 'system-pending' | 'denied'
  ): Promise<boolean> {
    const grant = settingsStore.getPermissionGrant(pluginId, perm)
    if (grant === 'allow') return true
    if (grant === 'deny') return false
    return new Promise<boolean>((resolve) => {
      const queue = this.queues.get(pluginId) ?? []
      this.queues.set(pluginId, queue)
      const isHead = queue.length === 0
      const req: PendingRequest = {
        requestId: `perm-${Date.now().toString(36)}-${++requestSeq}`,
        pluginId,
        permission: perm,
        resolve,
        // 占位 timer，入队（非队首）时无计时；弹出时重设
        timer: null as unknown as NodeJS.Timeout
      }
      queue.push(req)
      if (isHead) this.present(req, summary, osHint)
      else logInfo('perm', `${pluginId}:${perm} queued behind pending request`)
    })
  }

  /** 把队首请求发给壳渲染层并启动超时计时 */
  private present(
    req: PendingRequest,
    summary: string,
    osHint?: 'system-pending' | 'denied'
  ): void {
    this.pending.set(req.requestId, req)
    req.timer = setTimeout(() => {
      logWarn('perm', `request ${req.requestId} timeout → deny once`)
      this.settle(req.requestId, 'deny', false)
    }, REQUEST_TIMEOUT_MS)
    req.timer.unref?.()
    // Quick 小窗激活时主壳窗口可能隐藏，弹窗渲染在主壳内用户看不见；
    // 发 permission-request 前确保主壳可见并聚焦（仅此路径，不改退出/隐藏逻辑）
    const win = getMainWindow()
    if (win && !win.isDestroyed()) {
      if (win.isMinimized()) win.restore()
      win.show()
      win.focus()
    }
    sendShellEvent({
      type: 'permission-request',
      requestId: req.requestId,
      pluginId: req.pluginId,
      permission: req.permission,
      summary,
      ...(osHint ? { osHint } : {})
    })
  }

  /**
   * 渲染层响应入口（PermissionResponse handler 调用）。
   * 返回是否消费：requestId 无效 / 非当前挂起项时 false（防重放与伪造）。
   */
  resolveRequest(requestId: string, decision: PermissionDecision): boolean {
    const req = this.pending.get(requestId)
    if (!req) return false
    switch (decision) {
      case 'once':
        this.settle(requestId, decision, true)
        break
      case 'always':
        void settingsStore
          .setPermissionGrant(req.pluginId, req.permission, 'allow')
          .catch(() => {
            /* 持久化失败按本次放行 */
          })
        this.settle(requestId, decision, true)
        break
      case 'deny':
        void settingsStore
          .setPermissionGrant(req.pluginId, req.permission, 'deny')
          .catch(() => {
            /* 持久化失败按本次拒绝 */
          })
        this.settle(requestId, decision, false)
        break
    }
    return true
  }

  /**
   * 取消某插件的全部权限请求（卸载与禁用路径调用）：
   * 挂起中与排队中的请求均按本次拒绝 settle（不持久化 grant），队列整体清空。
   * 休眠/关 Tab 不调用——已授权流程不该被打断。
   */
  cancelFor(pluginId: string): void {
    const queue = this.queues.get(pluginId)
    if (!queue || queue.length === 0) return
    const reqs = [...queue]
    this.queues.delete(pluginId)
    for (const req of reqs) {
      if (this.pending.has(req.requestId)) {
        // 挂起中：走 settle（清计时、落日志、resolve）；队列已删不会弹下一项
        this.settle(req.requestId, 'deny', false)
      } else {
        // 排队中：未挂起无计时，直接拒绝
        logInfo('perm', `${pluginId}:${req.permission} cancelled (queued) → deny once`)
        req.resolve(false)
      }
    }
  }

  /** settle 挂起项：清计时、resolve、弹出下一队首 */
  private settle(requestId: string, decision: PermissionDecision, allowed: boolean): void {
    const req = this.pending.get(requestId)
    if (!req) return
    this.pending.delete(requestId)
    clearTimeout(req.timer)
    const queue = this.queues.get(req.pluginId)
    if (queue) {
      const idx = queue.indexOf(req)
      if (idx >= 0) queue.splice(idx, 1)
      if (queue.length === 0) this.queues.delete(req.pluginId)
    }
    logInfo('perm', `${req.pluginId}:${req.permission} → ${decision} (${allowed ? 'allow' : 'deny'})`)
    req.resolve(allowed)
    // 弹出同插件下一项：summary 已在入队时丢弃，重发仅带权限名
    const next = this.queues.get(req.pluginId)?.[0]
    if (next) this.present(next, `${next.permission}`)
  }
}

export const permissionService = new PermissionService()

/** grant 规范化：非法值回退 'ask'（渲染层入参防御） */
export function normalizeGrant(v: unknown): PluginPermissionGrant {
  return v === 'allow' || v === 'deny' ? v : 'ask'
}
