/**
 * PermissionPromptModal — 插件运行时权限确认弹窗
 * 职责：渲染 permission-request 事件队列的队首请求，三按钮决策
 *       （本次允许 / 总是允许 / 拒绝）经 shellApi.respondPermissionRequest 回主进程。
 * 挂载点：ShellLayout 顶层渲染一次（view 条件渲染之外常驻，任意视图期间均可弹窗）。
 * 依赖：permissionPromptStore（useShellEvents 入队）、permissionLabel、notify、shellApi。
 */
import { useCallback, useState } from 'react'
import { permissionLabel } from '@shared/permissionLabels'
import { shellApi } from '@renderer/services/shellApi'
import { notify } from '@renderer/services/notifyService'
import {
  usePermissionPromptStore,
  type PermissionPromptItem
} from '@renderer/stores/permissionPromptStore'
import { useShellStore } from '@renderer/stores/shellStore'

function PromptBody({ item }: { item: PermissionPromptItem }) {
  // respond 提交后置 true：三按钮禁用，防连点导致第二次 respond 收到 invalid
  const [submitting, setSubmitting] = useState(false)

  const respond = useCallback(
    (decision: 'once' | 'always' | 'deny') => {
      if (submitting) return
      setSubmitting(true)
      void (async () => {
        try {
          await shellApi.respondPermissionRequest?.(item.requestId, decision)
        } catch {
          // 主进程可能已超时按拒绝处理；toast 提示即可
          notify.warn('权限请求已失效')
        } finally {
          usePermissionPromptStore.getState().dequeue()
        }
      })()
    },
    [item.requestId, submitting]
  )

  const pluginName =
    useShellStore((s) => s.plugins.find((p) => p.id === item.pluginId)?.name) ??
    item.pluginId

  return (
    <div className="detail-overlay perm-prompt-overlay" role="presentation">
      <div className="detail-backdrop" />
      <div
        className="detail-modal perm-prompt-modal"
        role="alertdialog"
        aria-modal="true"
        aria-label={`权限请求：${permissionLabel(item.permission)}`}
      >
        <header className="detail-header">
          <div className="detail-meta">
            <div className="detail-sub">插件权限请求</div>
            <h3 className="detail-chip perm" title={item.permission}>
              {permissionLabel(item.permission)}
            </h3>
          </div>
        </header>
        <p className="desc">
          插件「{pluginName}」请求使用「{permissionLabel(item.permission)}」权限。
        </p>
        {item.summary ? (
          <p className="hint" title={item.summary}>
            操作摘要：<code>{item.summary}</code>
          </p>
        ) : null}
        {item.osHint === 'system-pending' ? (
          <p className="hint">
            macOS 将同时弹出系统授权（屏幕录制），请在系统弹窗中允许。
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              onClick={() => void shellApi.openScreenCaptureSettings?.()}
            >
              打开系统设置
            </button>
          </p>
        ) : null}
        {item.osHint === 'denied' ? (
          <p className="hint">
            macOS 屏幕录制授权已被拒绝，需在系统设置中手动开启后重试。
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              onClick={() => void shellApi.openScreenCaptureSettings?.()}
            >
              打开系统设置
            </button>
          </p>
        ) : null}
        <div className="detail-actions">
          <button
            type="button"
            className="btn btn-ghost"
            disabled={submitting}
            onClick={() => respond('deny')}
          >
            拒绝
          </button>
          <button
            type="button"
            className="btn btn-ghost"
            disabled={submitting}
            onClick={() => respond('always')}
          >
            总是允许
          </button>
          <button
            type="button"
            className="btn btn-primary"
            disabled={submitting}
            onClick={() => respond('once')}
          >
            本次允许
          </button>
        </div>
      </div>
    </div>
  )
}

/** 渲染队首权限请求；无挂起时返回 null */
export function PermissionPromptModal() {
  const head = usePermissionPromptStore((s) => s.queue[0])
  if (!head) return null
  return <PromptBody item={head} />
}
