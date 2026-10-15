import { useEffect, useRef, useState } from 'react'
import type { InstallProgressItem } from '@shared/types/install'
import { shellApi } from '@renderer/services/shellApi'
import '@renderer/styles/install.css'

export function InstallProgressList({ jobs, onDismiss }: { jobs: InstallProgressItem[]; onDismiss: (id: string) => void }) {
  if (!jobs.length) return null
  const active = jobs.filter(job => job.status === 'active' || job.status === 'queued').length
  return <section className="install-panel" aria-label="插件安装进度">
    <header className="install-panel-heading"><span className="install-panel-symbol" aria-hidden="true">↧</span>
      <strong>{active ? '正在安装插件' : '安装结果'}</strong><span>{active ? `${active} 个任务` : `${jobs.length} 个插件`}</span>
    </header>
    <div className="install-panel-jobs">
      {jobs.map(job => {
        const terminal = job.status === 'done' || job.status === 'failed'
        const progress = Math.max(0, Math.min(100, job.progress))
        return <article key={job.id} className={`install-card is-${job.status}`}>
          <div className="install-card-head"><span className="install-card-name" title={job.name}>{job.name}</span>
            {terminal ? <button className="install-dismiss" type="button" aria-label={`关闭 ${job.name} 的安装结果`} onClick={() => onDismiss(job.id)}>×</button>
              : <span className="install-card-pct">{job.status === 'queued' ? '等待中' : `${progress}%`}</span>}
          </div>
          <p className="install-card-step" role={job.status === 'failed' ? 'alert' : 'status'}>
            {job.status === 'done' ? '✓ 安装完成，可以开始使用' : job.status === 'failed' ? job.error || '安装失败，请检查插件包' : job.status === 'queued' ? '等待前面的任务完成' : job.step || '正在准备插件…'}
          </p>
          {!terminal && <div className="install-bar" role="progressbar" aria-label={`${job.name} 安装进度`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={progress}>
            <div className="install-bar-fill" style={{ transform: `scaleX(${progress / 100})` }} />
          </div>}
        </article>
      })}
    </div>
  </section>
}

/** Browser preview fallback; Electron uses a host-owned surface above plugin Views. */
export function InstallProgressPanel() {
  const [jobs, setJobs] = useState<InstallProgressItem[]>([])
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>())
  const dismiss = (id: string) => setJobs(previous => previous.filter(job => job.id !== id))
  useEffect(() => {
    if (window.enestInstallNative) return
    let alive = true
    let revision = 0
    const off = shellApi.onEvent(payload => {
      if (payload.type === 'install-queue') {
        revision++
        setJobs(previous => [...payload.active, ...payload.waiting].map(job => ({ ...previous.find(item => item.id === job.id), ...job }))
          .concat(previous.filter(job => job.status === 'done' || job.status === 'failed')))
      } else if (payload.type === 'install-progress') {
        revision++
        setJobs(previous => {
          const job: InstallProgressItem = { id: payload.jobId, name: payload.name, status: 'active', progress: payload.progress, step: payload.step }
          return previous.some(item => item.id === job.id) ? previous.map(item => item.id === job.id ? job : item) : [...previous, job]
        })
      } else if (payload.type === 'install-result') {
        revision++
        setJobs(previous => [{ id: payload.jobId, name: payload.name, status: payload.ok ? 'done' as const : 'failed' as const,
          progress: payload.ok ? 100 : previous.find(item => item.id === payload.jobId)?.progress ?? 0, error: payload.error },
        ...previous.filter(item => item.id !== payload.jobId)].slice(0, 16))
        if (payload.ok) timers.current.set(payload.jobId, setTimeout(() => { dismiss(payload.jobId); timers.current.delete(payload.jobId) }, 5000))
      }
    })
    void shellApi.getInstallQueue?.().then(queue => {
      if (alive && revision === 0 && queue) setJobs([...queue.active, ...queue.waiting])
    }).catch(() => {})
    return () => { alive = false; off(); for (const timer of timers.current.values()) clearTimeout(timer); timers.current.clear() }
  }, [])
  return window.enestInstallNative ? null : <InstallProgressList jobs={jobs} onDismiss={dismiss} />
}
