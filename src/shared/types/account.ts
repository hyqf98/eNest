import type { UserProfile } from '@shared/types/plugin'

/** A browser callback or an explicitly enabled device-code provider. */
export type AccountLoginSession =
  | { mode: 'web'; verificationUri: string; expiresInSeconds: number }
  | { mode: 'device'; userCode: string; verificationUri: string; expiresInSeconds: number; copied?: boolean }

/** Providers are supplied by the host; plugins cannot add account login handlers. */
export interface AccountLoginProvider {
  id: string
  name: string
  available: boolean
  deviceFlow?: boolean
}

export interface AccountState {
  user: UserProfile | null
  providerId: string | null
  providers: AccountLoginProvider[]
  pendingProviderId: string | null
  session: AccountLoginSession | null
  credentialNotice?: 'session-only' | 'reauth-required'
}

export type AccountLoginResult =
  | { ok: true; data: AccountLoginSession }
  | { ok: false; error: string }
