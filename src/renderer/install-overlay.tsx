import { useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import type { InstallSurfaceState } from '@shared/types/install'
import { InstallDropOverlay } from '@renderer/components/InstallDropOverlay'
import { InstallProgressList } from '@renderer/components/InstallProgressPanel'
import '@renderer/styles/tokens.css'
import '@renderer/styles/install.css'

declare global {
  interface Window {
    enestInstallNative?: boolean
    enestInstall?: { ready: () => void; dismiss: (id: string) => void; onState: (callback: (state: InstallSurfaceState) => void) => () => void }
  }
}
function InstallSurface() {
  const [state, setState] = useState<InstallSurfaceState | null>(null)
  useEffect(() => {
    const off = window.enestInstall?.onState(next => {
      const root = document.documentElement
      root.dataset.theme = next.theme
      root.dataset.anim = next.animation
      for (const [key, value] of Object.entries(next.tokens)) root.style.setProperty(key, value)
      root.className = `native-install${next.dragging ? ' is-dragging' : ''}`
      setState(next)
    })
    window.enestInstall?.ready()
    return off
  }, [])
  return <><InstallDropOverlay visible={state?.dragging ?? false} />
    {!state?.dragging && <InstallProgressList jobs={state?.jobs ?? []} onDismiss={id => window.enestInstall?.dismiss(id)} />}</>
}
createRoot(document.getElementById('root')!).render(<InstallSurface />)
