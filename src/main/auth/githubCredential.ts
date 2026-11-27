export interface GithubGrant {
  access_token?: string
  refresh_token?: string
  expires_in?: number
  refresh_token_expires_in?: number
  error?: string
  interval?: number
}

export interface GithubCredential {
  access: string
  clientId?: string
  refresh?: string
  expiresAt?: number
  refreshExpiresAt?: number
}

function secret(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 4096 && !/\s/.test(value)
}

function expiry(seconds: number | undefined): number | undefined {
  if (seconds === undefined) return undefined
  if (!Number.isSafeInteger(seconds) || seconds <= 0 || seconds > 366 * 86400) throw new Error('GitHub 返回了无效的令牌有效期')
  return Date.now() + seconds * 1000
}

export function deviceCredential(grant: GithubGrant, clientId: string): string {
  if (!secret(grant.access_token) || grant.refresh_token !== undefined && !secret(grant.refresh_token)) throw new Error('GitHub 返回了无效的凭据')
  return JSON.stringify({ access: grant.access_token, clientId, refresh: grant.refresh_token, expiresAt: expiry(grant.expires_in), refreshExpiresAt: expiry(grant.refresh_token_expires_in) } satisfies GithubCredential)
}

export function parseCredential(stored: string): GithubCredential {
  if (!stored.startsWith('{') && secret(stored)) return { access: stored }
  const value = JSON.parse(stored) as GithubCredential
  if (!secret(value.access) || !secret(value.clientId) || value.refresh !== undefined && !secret(value.refresh)) throw new Error('登录凭据无效，请重新登录')
  return value
}
