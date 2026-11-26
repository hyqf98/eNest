import type { UpdateStatePayload } from '@shared/types/ipc'

export function availableUpdateVersion(state: UpdateStatePayload | null): string | null {
  if (!state || (state.status !== 'available' && state.status !== 'downloading' && state.status !== 'downloaded')) return null
  return state.latestVersion?.trim().slice(0, 256) || null
}
