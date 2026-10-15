import type { AccountState, AccountLoginResult } from '@shared/types/account'
import { getGithubAuthConfig } from './authConfig'
import { startGithubLogin, cancelGithubLogin, logoutGithub, getProfileUser, getGithubLoginSession, isLoginPolling } from './githubAuthService'

// Add another provider's adapter here; Settings renders the host's provider list.
const providers = {
  github: { name: 'GitHub', available: () => getGithubAuthConfig().available, login: startGithubLogin, cancel: cancelGithubLogin, logout: logoutGithub, user: getProfileUser, session: getGithubLoginSession, pending: isLoginPolling },
} as const

function provider(id: unknown) {
  if (typeof id !== 'string' || !Object.hasOwn(providers, id)) throw new Error('不支持此登录方式')
  return providers[id as keyof typeof providers]
}

export function getAccountState(): AccountState {
  const entries = Object.entries(providers)
  const connected = entries.find(([, item]) => item.user())
  const pending = entries.find(([, item]) => item.pending())
  return {
    user: connected?.[1].user() ?? null, providerId: connected?.[0] ?? null,
    providers: entries.map(([id, item]) => ({ id, name: item.name, available: item.available() })),
    pendingProviderId: pending?.[0] ?? null, session: pending?.[1].session() ?? null,
  }
}

export async function loginAccount(id: unknown): Promise<AccountLoginResult> {
  try { return { ok: true, data: await provider(id).login() } }
  catch (error) { return { ok: false, error: error instanceof Error ? error.message : '登录未能开始，请重试' } }
}
export function cancelAccountLogin(id: unknown): void { provider(id).cancel() }
export function logoutAccount(id: unknown): void { provider(id).logout() }
