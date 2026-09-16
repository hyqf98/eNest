/**
 * InstallProgressPanel — 安装进度浮层（右上）
 * 职责：展示进行中任务的名称 + 进度条（0–100%），以及 FIFO 等待列表。
 * 状态来源：shell:event 的 install-queue / install-progress；
 *          队列为空时整块卸载，不占视觉。
 * 被 ShellLayout 挂载。
 * 依赖：shellApi.onEvent、@shared/types/ipc（InstallJobInfo）。
 */
import { useEffect, useState } from 'react'
import type { InstallJobInfo } from '@shared/types/ipc'
import { shellApi } from '@renderer/services/shellApi'
import '../styles/install.css'

interface QueueSnapshot {
  active: (InstallJobInfo & { step?: string })[]
  waiting: InstallJobInfo[]
}

export function InstallProgressPanel() {
  const [queue, setQueue] = useState<QueueSnapshot>({ active: [], waiting: [] })

  useEffect(() => {
    // 启动时拉一次，避免刷新后丢失仍在跑的任务
    void shellApi.getInstallQueue?.().then((s) => {
      if (s) setQueue(s)
    })

    const off = shellApi.onEvent((payload) => {
      if (payload.type === 'install-queue') {
        setQueue({ active: payload.active, waiting: payload.waiting })
        return
      }
      if (payload.type === 'install-progress') {
        setQueue((prev) => ({
          active: prev.active.map((j) =>
            j.id === payload.jobId
              ? { ...j, progress: payload.progress, step: payload.step ?? j.step }
              : j
          ),
          waiting: prev.waiting
        }))
      }
    })
    return off
  }, [])

  if (queue.active.length === 0 && queue.waiting.length === 0) return null

  return (
    <div className="install-panel" role="status" aria-live="polite">
      {queue.active.map((job) => (
        <div key={job.id} className="install-card">
          <div className="install-card-head">
            <span className="install-card-name" title={job.name}>
              {job.name}
            </span>
            <span className="install-card-pct">{job.progress}%</span>
          </div>
          <div className="install-bar">
            <div className="install-bar-fill" style={{ width: `${job.progress}%` }} />
          </div>
          {job.step && <div className="install-card-step">{job.step}</div>}
        </div>
      ))}
      {queue.waiting.length > 0 && (
        <div className="install-waiting">
          <div className="install-waiting-title">等待安装（{queue.waiting.length}）</div>
          {queue.waiting.map((job) => (
            <div key={job.id} className="install-waiting-item" title={job.name}>
              {job.name}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
