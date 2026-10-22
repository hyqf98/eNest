import { useEffect, useState } from 'react'
import type { HomeSurfaceState } from '@shared/types/homeSurface'
import { Button } from '@renderer/components/ui/Button'
import { shellApi } from '@renderer/services/shellApi'
import { useShellStore } from '@renderer/stores/shellStore'

/** Always host-owned, underneath the native Home; remains usable when its provider fails. */
export function HomeRecovery() {
  const [state, setState] = useState<HomeSurfaceState>({ status: 'idle', generation: 0 })
  const [retrying, setRetrying] = useState(false)
  useEffect(() => {
    let alive = true
    let events = 0
    const off = shellApi.onEvent(event => {
      if (event.type !== 'home-status') return
      events++
      if (alive) setState(event.state)
    })
    const version = events
    void shellApi.getHomeState?.().then(next => {
      if (alive && events === version) setState(next)
    }).catch(() => { if (alive && events === version) setState({ status: 'error', generation: 0 }) })
    return () => { alive = false; off() }
  }, [])

  if (state.status !== 'error' && !retrying) return null

  return <section className="home-recovery" aria-label="首页恢复" aria-live="polite" aria-busy={retrying}>
    <span className="home-recovery-mark" aria-hidden="true">eNest</span>
    <h1>首页暂时无法显示</h1>
    <p>{state.message ?? '你的插件与主题设置仍然保留。可以重试，或进入设置选择其他主题。'}</p>
    <div className="home-recovery-actions">
      <Button disabled={retrying} onClick={async () => {
        setRetrying(true)
        try { await shellApi.retryHome?.() }
        catch { setState(current => ({ ...current, status: 'error' })) }
        finally { setRetrying(false) }
      }}>{retrying ? '重试中…' : '重试首页'}</Button>
      <Button variant="ghost" onClick={() => {
        useShellStore.getState().setSettingsTab('appearance')
        useShellStore.getState().setView('settings')
      }}>打开设置</Button>
    </div>
  </section>
}
