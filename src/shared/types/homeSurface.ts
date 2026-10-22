/** Trusted shell recovery state; never contains a provider path or settings. */
export interface HomeSurfaceState {
  status: 'idle' | 'loading' | 'ready' | 'error'
  generation: number
  message?: string
  recovery?: boolean
  route?: import('./workspace').WorkspaceRoute
}
