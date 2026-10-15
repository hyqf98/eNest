import { net, safeStorage, shell } from 'electron'
import { existsSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs'
import { createHash, randomBytes } from 'node:crypto'
import { join } from 'node:path'
import { getAppPaths } from '@main/paths/pathsService'
import { settingsStore } from '@main/settings/SettingsStore'
import { getMainWindow, sendShellEvent } from '@main/window/createShellWindow'
import { setOrbProfile } from '@main/window/orbRailViews'
import { logInfo, logWarn } from '@main/logs/logService'
import type { UserProfile } from '@shared/types/plugin'
import type { GithubLoginSessionPayload, ShellEventPayload } from '@shared/types/ipc'
import { getGithubAuthConfig } from './authConfig'
import { listenOAuthLoopback } from './oauthLoopback'

const DEVICE_CODE_URL = 'https://github.com/login/device/code'
const AUTHORIZE_URL = 'https://github.com/login/oauth/authorize'
const TOKEN_URL = 'https://github.com/login/oauth/access_token'
const USER_URL = 'https://api.github.com/user'
const SCOPE = 'read:user'
/** 头像请求边长（px）与 data URL 上限；超过则放弃缓存，轨道回落 glyph */
const AVATAR_SIZE = 160
const AVATAR_MAX_BYTES = 256 * 1024
const REQUEST_TIMEOUT_MS = 15_000
/** 设备流轮询下限（GitHub 文档默认 5s；slow_down 时递增） */
const POLL_MIN_INTERVAL_S = 3
/** 浏览器授权码流：等待回调 / 整体完成的上限 */
const WEB_LOGIN_TIMEOUT_MS = 120_000

/** shell:github-login 响应：渲染层展示 user_code（设备流）或等待文案（浏览器流） */
export type { GithubLoginSessionPayload }

let tokenCache: string | null | undefined // undefined = 未读盘
/** 登录代次：取消 / 重新登录递增，旧轮询链自检后静默退出，杜绝取消后仍写 token */
let loginGeneration = 0
/** 浏览器授权码流在飞的回环服务器（取消时关闭） */
let activeCallback: Awaited<ReturnType<typeof listenOAuthLoopback>> | null = null
let pollingGen: number | null = null
let loginSession: GithubLoginSessionPayload | null = null
let activeAbort: AbortController | null = null
let loginTimeout: ReturnType<typeof setTimeout> | null = null

function secureStorageAvailable(): boolean {
  return safeStorage.isEncryptionAvailable() &&
    !(process.platform === 'linux' && safeStorage.getSelectedStorageBackend() === 'basic_text')
}

function tokenFile(): string {
  return join(getAppPaths().data, 'github.token')
}

function readToken(): string | null {
  if (tokenCache !== undefined) return tokenCache
  tokenCache = null
  try {
    const file = tokenFile()
    if (!existsSync(file)) return null
    if (!secureStorageAvailable()) return null
    tokenCache = safeStorage.decryptString(readFileSync(file))
  } catch (err) {
    logWarn('github', `read token failed: ${(err as Error).message}`)
    tokenCache = null
  }
  return tokenCache
}

function writeToken(token: string): void {
  if (!secureStorageAvailable()) {
    throw new Error('系统密钥库不可用（safeStorage），出于安全不保存登录凭据')
  }
  writeFileSync(tokenFile(), safeStorage.encryptString(token), { mode: 0o600 })
  tokenCache = token
}

function clearToken(): void {
  tokenCache = null
  try {
    const file = tokenFile()
    if (existsSync(file)) unlinkSync(file)
  } catch (err) {
    logWarn('github', `clear token failed: ${(err as Error).message}`)
  }
}

/** 资料变化统一出口：持久化 + 事件 + 轨道头像 */
function publishProfile(user: UserProfile | null): void {
  settingsStore.setProfileUser(user)
  notifyProfile(user)
}

function notifyProfile(user: UserProfile | null): void {
  sendShellEvent({ type: 'profile-changed', profile: user })
  setOrbProfile(
    user ? { name: user.name || user.login, avatar: user.avatarDataUrl } : null
  )
}

async function githubJson<T>(url: string, init: RequestInit & { headers?: Record<string, string> }): Promise<T> {
  const res = await net.fetch(url, {
    ...init,
    headers: { Accept: 'application/json', ...init.headers },
    signal: init.signal ? AbortSignal.any([init.signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]) : AbortSignal.timeout(REQUEST_TIMEOUT_MS)
  })
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw Object.assign(new Error(`GitHub ${res.status}`), {
      status: res.status,
      body: body.slice(0, 200)
    })
  }
  return (await res.json()) as T
}

/** 拉取头像并转 data URL；失败 / 超限返回 null（渲染端不远程加载） */
async function fetchAvatarDataUrl(avatarUrl: string, signal?: AbortSignal): Promise<string | null> {
  try {
    const sized = new URL(avatarUrl)
    sized.searchParams.set('s', String(AVATAR_SIZE))
    const res = await net.fetch(sized.href, { signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]) : AbortSignal.timeout(REQUEST_TIMEOUT_MS) })
    if (!res.ok) return null
    const buf = Buffer.from(await res.arrayBuffer())
    if (buf.byteLength === 0 || buf.byteLength > AVATAR_MAX_BYTES) return null
    const mime = res.headers.get('content-type')?.split(';')[0] || 'image/png'
    if (!/^image\//.test(mime)) return null
    return `data:${mime};base64,${buf.toString('base64')}`
  } catch {
    return null
  }
}

async function fetchProfile(token: string, signal?: AbortSignal): Promise<UserProfile> {
  const user = await githubJson<{ login: string; name: string | null; avatar_url: string; html_url: string }>(
    USER_URL,
    { signal, headers: { Authorization: `Bearer ${token}`, 'User-Agent': 'eNest' } }
  )
  const avatarDataUrl = user.avatar_url ? await fetchAvatarDataUrl(user.avatar_url, signal) : null
  return {
    login: user.login,
    name: user.name ?? null,
    avatarUrl: user.avatar_url ?? null,
    avatarDataUrl,
    htmlUrl: user.html_url ?? null,
    connectedAt: Date.now()
  }
}

function publishLoginStatus(status: Omit<Extract<ShellEventPayload, { type: 'github-login-status' }>, 'type'>): void {
  sendShellEvent({ ...status, type: 'github-login-status' })
  sendShellEvent({ ...status, type: 'account-login-status', providerId: 'github' })
}

/** The release supplies public app configuration; the client secret stays on the publisher's server. */
export async function startGithubLogin(): Promise<GithubLoginSessionPayload> {
  const config = getGithubAuthConfig()
  if (!config.available) throw new Error('此版本暂未开通 GitHub 登录，请稍后再试')
  if (isLoginPolling()) throw new Error('已有登录进行中，请先取消')
  const generation = ++loginGeneration
  pollingGen = generation
  activeAbort = new AbortController()
  try {
    if (config.exchangeUrl) return await startWebLogin(generation, config.clientId, config.exchangeUrl)
    return await startDeviceLogin(generation, config.clientId)
  } catch (error) {
    if (generation === loginGeneration) endPending()
    throw error
  }
}

function endPending(): void {
  pollingGen = null
  loginSession = null
  if (loginTimeout) clearTimeout(loginTimeout)
  loginTimeout = null
  activeAbort?.abort()
  activeAbort = null
  activeCallback?.close()
  activeCallback = null
}

function failLogin(generation: number, error: unknown): void {
  if (generation !== loginGeneration) return
  loginGeneration++ // Invalidate any network request still completing after timeout.
  activeCallback?.complete(false)
  endPending()
  publishLoginStatus({ phase: 'error', message: error instanceof Error ? error.message : '登录失败，请重试' })
}

async function finishLogin(generation: number, token: string): Promise<void> {
  if (generation !== loginGeneration) return
  const profile = await fetchProfile(token, activeAbort?.signal)
  if (generation !== loginGeneration) return
  writeToken(token)
  try { settingsStore.setProfileUser(profile) }
  catch (error) { clearToken(); throw error }
  activeCallback?.complete(true)
  endPending()
  // Credentials are stored and profile persistence is scheduled. Window teardown cannot undo login.
  try {
    notifyProfile(profile)
    publishLoginStatus({ phase: 'authorized' })
    const win = getMainWindow()
    if (win && !win.isDestroyed()) {
      if (win.isMinimized()) win.restore()
      win.show()
      win.focus()
    }
  } catch { logWarn('github', 'Signed in; window notification unavailable') }
  logInfo('github', `authorized as @${profile.login}`)
}

async function startWebLogin(generation: number, clientId: string, exchangeUrl: string): Promise<GithubLoginSessionPayload> {
  const verifier = randomBytes(48).toString('base64url')
  const challenge = createHash('sha256').update(verifier).digest('base64url')
  const state = randomBytes(24).toString('hex')
  const callback = await listenOAuthLoopback(state)
  if (generation !== loginGeneration) { callback.close(); throw new Error('登录已取消') }
  activeCallback = callback
  const authorize = new URL(AUTHORIZE_URL)
  authorize.search = new URLSearchParams({ client_id: clientId, redirect_uri: callback.redirectUri,
    scope: SCOPE, state, code_challenge: challenge, code_challenge_method: 'S256' }).toString()
  const session: GithubLoginSessionPayload = { mode: 'web', verificationUri: authorize.href, expiresInSeconds: WEB_LOGIN_TIMEOUT_MS / 1000 }
  loginSession = session
  loginTimeout = setTimeout(() => failLogin(generation, new Error('等待授权超时，请重新登录')), WEB_LOGIN_TIMEOUT_MS)
  loginTimeout.unref()
  await shell.openExternal(authorize.href)
  if (generation !== loginGeneration) throw new Error('登录已取消')
  publishLoginStatus({ phase: 'pending' })
  void (async () => {
    const result = await callback.result
    if (generation !== loginGeneration) return
    if (!result.code) throw new Error(result.error || '授权未完成')
    const token = await githubJson<{ access_token?: string; error?: string }>(exchangeUrl, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: activeAbort?.signal,
      body: JSON.stringify({ code: result.code, code_verifier: verifier, redirect_uri: callback.redirectUri }),
    })
    if (!token.access_token || typeof token.access_token !== 'string') throw new Error('授权交换失败，请重新登录')
    await finishLogin(generation, token.access_token)
  })().catch(error => failLogin(generation, error))
  return session
}

/** Optional device flow is enabled only by the publisher, never silently substituted. */
async function startDeviceLogin(generation: number, clientId: string): Promise<GithubLoginSessionPayload> {
  const code = await githubJson<{ device_code: string; user_code: string; verification_uri: string; expires_in: number; interval: number }>(DEVICE_CODE_URL, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: activeAbort?.signal,
    body: JSON.stringify({ client_id: clientId, scope: SCOPE }),
  })
  if (generation !== loginGeneration) throw new Error('登录已取消')
  if (!code.device_code || !code.user_code || !Number.isFinite(code.expires_in) || code.expires_in <= 0) throw new Error('无法获取 GitHub 授权码')
  // The known GitHub page is used instead of opening a server-provided arbitrary URL.
  const session: GithubLoginSessionPayload = { mode: 'device', userCode: code.user_code,
    verificationUri: 'https://github.com/login/device', expiresInSeconds: code.expires_in }
  loginSession = session
  loginTimeout = setTimeout(() => failLogin(generation, new Error('授权码已过期，请重新登录')), code.expires_in * 1000)
  loginTimeout.unref()
  await shell.openExternal(session.verificationUri)
  if (generation !== loginGeneration) throw new Error('登录已取消')
  publishLoginStatus({ phase: 'pending' })
  void pollForToken(generation, clientId, code.device_code, Math.max(POLL_MIN_INTERVAL_S, code.interval || 5) * 1000)
    .catch(error => failLogin(generation, error))
  return session
}

async function pollForToken(generation: number, clientId: string, deviceCode: string, intervalMs: number): Promise<void> {
  while (generation === loginGeneration && pollingGen === generation) {
    const signal = activeAbort!.signal
    await new Promise<void>(resolve => {
      const done = () => { clearTimeout(timer); signal.removeEventListener('abort', done); resolve() }
      const timer = setTimeout(done, intervalMs)
      signal.addEventListener('abort', done, { once: true })
    })
    if (generation !== loginGeneration || signal.aborted) return
    const result = await githubJson<{ access_token?: string; error?: string }>(TOKEN_URL, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, signal,
      body: JSON.stringify({ client_id: clientId, device_code: deviceCode, grant_type: 'urn:ietf:params:oauth:grant-type:device_code' }),
    })
    if (generation !== loginGeneration) return
    if (result.access_token) { await finishLogin(generation, result.access_token); return }
    if (result.error === 'slow_down') { intervalMs += 5000; continue }
    if (result.error === 'authorization_pending') continue
    throw new Error(result.error === 'access_denied' ? '已取消 GitHub 授权' : '授权未完成，请重新登录')
  }
}

export function cancelGithubLogin(): void {
  loginGeneration++
  endPending()
  publishLoginStatus({ phase: 'cancelled' })
}
export function isLoginPolling(): boolean { return pollingGen !== null }
export function getGithubLoginSession(): GithubLoginSessionPayload | null { return loginSession }

export function logoutGithub(): void {
  cancelGithubLogin()
  clearToken()
  publishProfile(null)
  logInfo('github', 'logged out')
}

export async function refreshProfileOnBoot(): Promise<void> {
  const generation = loginGeneration
  const token = readToken()
  if (!token) return
  try {
    const profile = await fetchProfile(token)
    if (generation === loginGeneration) publishProfile(profile)
  } catch (err) {
    if (generation !== loginGeneration) return
    if ((err as { status?: number }).status === 401) {
      clearToken()
      publishProfile(null)
    } else logWarn('github', 'Profile refresh unavailable; keeping cached profile')
  }
}

export function getProfileUser(): UserProfile | null {
  const user = settingsStore.getAll().profile?.user
  return user && typeof user.login === 'string' ? user : null
}
export function hasGithubToken(): boolean { return readToken() !== null }
