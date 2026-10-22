import type { InstallJobInfo } from './ipc'

export interface InstallProgressItem extends InstallJobInfo {
  step?: string
  error?: string
}
export interface InstallSurfaceState {
  dragging: boolean
  jobs: InstallProgressItem[]
  theme: 'light' | 'dark'
  tokens: Record<string, string>
  animation: 'low' | 'medium' | 'high'
  appearance?: import('./appearance').ResolvedAppearance
}
