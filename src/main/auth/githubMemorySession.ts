import { getAppPathsGeneration } from '@main/paths/pathsService'
import { settingsStore } from '@main/settings/SettingsStore'
import type { UserProfile } from '@shared/types/plugin'

let session: { rootGeneration: number; token: string; user: UserProfile } | null = null

export function getMemoryGithubSession() {
  if (session && session.rootGeneration !== getAppPathsGeneration()) session = null
  return session
}

export function setMemoryGithubSession(value: { token: string; user: UserProfile } | null): void {
  session = value && { ...value, rootGeneration: getAppPathsGeneration() }
}

export function getActiveGithubProfile(): UserProfile | null {
  return getMemoryGithubSession()?.user ?? settingsStore.getProfileUser()
}
