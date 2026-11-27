import { app, shell } from 'electron'
import { existsSync, readFileSync, writeFileSync, unlinkSync, renameSync, rmSync } from 'node:fs'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { getAppPaths, getAppPathsGeneration } from '@main/paths/pathsService'
import { isLegacyGithubCiphertext, openGithubCredential, sealGithubCredential } from '@main/vault/githubAccountStorage'
import { settingsStore } from '@main/settings/SettingsStore'
import { getMainWindow, sendShellEvent } from '@main/window/createShellWindow'
import { setOrbProfile } from '@main/window/orbRailViews'
import { logInfo, logWarn } from '@main/logs/logService'
import type { UserProfile } from '@shared/types/plugin'
import type { AccountState } from '@shared/types/account'
import type { GithubLoginSessionPayload, ShellEventPayload } from '@shared/types/ipc'
import { getGithubAuthConfig } from './authConfig'
import { listenOAuthLoopback } from './oauthLoopback'
import { deviceCredential, parseCredential, type GithubGrant } from './githubCredential'
import { getActiveGithubProfile, getMemoryGithubSession, setMemoryGithubSession } from './githubMemorySession'
import { writeClipboardText } from '@main/clipboard/clipboardNativeEvents'
import { githubRequest } from './githubTransport'

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

interface CredentialContext { generation: number; rootGeneration: number; revision: number; file: string }
let tokenCache: { context: CredentialContext; token: string | null } | undefined
let tokenRead: { context: CredentialContext; promise: Promise<string | null> } | undefined
let tokenRevision = 0
let legacyStorage: CredentialContext | undefined
let loginStorage: CredentialContext | null = null
/** 登录代次：取消 / 重新登录递增，旧轮询链自检后静默退出，杜绝取消后仍写 token */
let loginGeneration = 0
/** 浏览器授权码流在飞的回环服务器（取消时关闭） */
let activeCallback: Awaited<ReturnType<typeof listenOAuthLoopback>> | null = null
let pollingGen: number | null = null
let loginSession: GithubLoginSessionPayload | null = null
let activeAbort: AbortController | null = null
let loginTimeout: ReturnType<typeof setTimeout> | null = null
let accountLifetime = new AbortController()
let renewal: { context: CredentialContext; task: Promise<string> } | undefined
const authenticatedListeners = new Set<() => void>()

export function onGithubAuthenticated(listener: () => void): void { authenticatedListeners.add(listener) }

function invalidateAccount(): void {
  accountLifetime.abort()
  accountLifetime = new AbortController()
}

function tokenFile(): string {
  return join(getAppPaths().data, 'github.token')
}

function credentialContext(): CredentialContext {
  return { generation: loginGeneration, rootGeneration: getAppPathsGeneration(), revision: tokenRevision, file: tokenFile() }
}

function isCredentialCurrent(context: CredentialContext): boolean {
  return context.generation === loginGeneration && context.revision === tokenRevision
    && context.rootGeneration === getAppPathsGeneration() && context.file === tokenFile()
}

function persistToken(file: string, encrypted: Buffer): void {
  const temporary = `${file}.${randomUUID()}.tmp`
  try {
    writeFileSync(temporary, encrypted, { flag: 'wx', mode: 0o600 })
    renameSync(temporary, file)
  } finally { rmSync(temporary, { force: true }) }
}

async function readToken(): Promise<string | null> {
  const temporary = getMemoryGithubSession()
  if (temporary) return temporary.token
  if (tokenCache && isCredentialCurrent(tokenCache.context)) return tokenCache.token
  if (tokenRead && isCredentialCurrent(tokenRead.context)) return tokenRead.promise
  const context = credentialContext()
  const promise = (async (): Promise<string | null> => {
    try {
      if (!existsSync(context.file)) {
        tokenCache = { context, token: null }
        return null
      }
      const original = readFileSync(context.file)
      if (isLegacyGithubCiphertext(original)) {
        legacyStorage = context
        tokenCache = { context, token: null }
        if (getProfileUser()) publishProfile(null)
        else notifyProfile(null)
        return null
      }
      const signal = accountLifetime.signal
      const { result, shouldReEncrypt } = await openGithubCredential(original, signal)
      if (!isCredentialCurrent(context)) return null
      const replacement = shouldReEncrypt ? await sealGithubCredential(result, signal) : undefined
      if (!isCredentialCurrent(context) || !existsSync(context.file) || !readFileSync(context.file).equals(original)) return null
      if (replacement) persistToken(context.file, replacement)
      tokenCache = { context, token: result }
      return result
    } catch {
      // A locked keyring is retryable; never cache a decryption failure as a missing credential.
      if (isCredentialCurrent(context)) logWarn('github', 'read token failed; unlock the system keyring (existing credential preserved)')
      return null
    }
  })()
  tokenRead = { context, promise }
  try { return await promise }
  finally { if (tokenRead?.promise === promise) tokenRead = undefined }
}

function writeToken(token: string, encrypted: Buffer | null, context: CredentialContext, user: UserProfile): void {
  if (!isCredentialCurrent(context)) throw new Error('登录已取消或数据目录已变更，请重新登录')
  if (encrypted) persistToken(context.file, encrypted)
  else if (existsSync(context.file)) unlinkSync(context.file)
  setMemoryGithubSession(encrypted ? null : { token, user })
  legacyStorage = undefined
  tokenRevision++
  tokenCache = { context: credentialContext(), token }
}

async function encryptToken(token: string, signal: AbortSignal | undefined): Promise<Buffer | null> {
  try { return await sealGithubCredential(token, signal) }
  catch {
    signal?.throwIfAborted()
    return null
  }
}

function clearToken(): void {
  const file = tokenFile()
  if (existsSync(file)) unlinkSync(file)
  setMemoryGithubSession(null)
  legacyStorage = undefined
  tokenRevision++
  tokenCache = { context: credentialContext(), token: null }
}

/** 资料变化统一出口：持久化 + 事件 + 轨道头像 */
function publishProfile(user: UserProfile | null): void {
  const temporary = getMemoryGithubSession()
  if (temporary && user) temporary.user = user
  else settingsStore.setProfileUser(user)
  notifyProfile(user)
}

function notifyProfile(user: UserProfile | null): void {
  sendShellEvent({ type: 'profile-changed', profile: user })
  setOrbProfile(
    user ? { name: user.name || user.login, avatar: user.avatarDataUrl } : null
  )
}

function githubResponse(url: string, init: RequestInit & { headers?: Record<string, string> }, grantErrorBody = false) {
  return githubRequest(url, { ...init, headers: { Accept: 'application/json', ...init.headers } }, { limit: 64 * 1024, timeoutMs: REQUEST_TIMEOUT_MS, grantErrorBody })
}

function readGithubJson<T>(res: Awaited<ReturnType<typeof githubResponse>>): T {
  if (!res.ok) throw Object.assign(new Error(`GitHub ${res.status}`), { status: res.status })
  return JSON.parse(res.bytes.toString('utf8')) as T
}

async function githubJson<T>(url: string, init: RequestInit & { headers?: Record<string, string> }): Promise<T> {
  return readGithubJson<T>(await githubResponse(url, init))
}

async function requestGrant(fields: Record<string, string>, signal: AbortSignal): Promise<GithubGrant> {
  const response = await githubResponse(TOKEN_URL, { method: 'POST', signal, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(fields) }, true)
  if (response.status === 400) {
    const invalid = Object.assign(new Error('GitHub 400'), { status: response.status })
    let error: unknown
    try { error = JSON.parse(response.bytes.toString('utf8'))?.error }
    catch { signal.throwIfAborted(); throw invalid }
    if (typeof error === 'string' && /^[a-z_]{1,64}$/.test(error)) return { error }
    throw invalid
  }
  const grant = readGithubJson<GithubGrant>(response)
  return grant.error ? { error: grant.error } : grant
}

/** 拉取头像并转 data URL；失败 / 超限返回 null（渲染端不远程加载） */
async function fetchAvatarDataUrl(avatarUrl: string, signal?: AbortSignal): Promise<string | null> {
  try {
    const sized = new URL(avatarUrl)
    if (sized.origin !== 'https://avatars.githubusercontent.com' || sized.username || sized.password) return null
    sized.searchParams.set('s', String(AVATAR_SIZE))
    const res = await githubRequest(sized.href, { signal }, { timeoutMs: REQUEST_TIMEOUT_MS, limit: AVATAR_MAX_BYTES })
    if (!res.ok) return null
    const buf = res.bytes
    if (buf.byteLength === 0 || buf.byteLength > AVATAR_MAX_BYTES) return null
    const mime = res.headers.get('content-type')?.split(';')[0] || 'image/png'
    if (!/^image\/(?:png|jpeg|webp|gif)$/.test(mime)) return null
    return `data:${mime};base64,${buf.toString('base64')}`
  } catch {
    return null
  }
}

async function fetchProfile(token: string, signal?: AbortSignal): Promise<UserProfile> {
  const user = await githubJson<{ id: number; login: string; name: string | null; avatar_url: string; html_url: string }>(
    USER_URL,
    { signal, headers: { Authorization: `Bearer ${token}`, 'User-Agent': 'eNest' } }
  )
  if (!Number.isSafeInteger(user.id) || user.id <= 0 || !user.login) throw new Error('无法确认 GitHub 账号身份')
  const avatarDataUrl = user.avatar_url ? await fetchAvatarDataUrl(user.avatar_url, signal) : null
  return {
    githubId: user.id, login: user.login,
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

export async function startGithubLogin(): Promise<GithubLoginSessionPayload> {
  const config = getGithubAuthConfig()
  if (!config.available) throw new Error(config.availabilityError || '此版本尚未配置 GitHub 登录，请联系发布方完成登录配置。')
  if (isLoginPolling()) throw new Error('已有登录进行中，请先取消')
  invalidateAccount()
  const generation = ++loginGeneration
  loginStorage = credentialContext()
  pollingGen = generation
  activeAbort = new AbortController()
  try {
    if (!config.deviceFlow && config.exchangeUrl) return await startWebLogin(generation, config.clientId, config.exchangeUrl)
    return await startDeviceLogin(generation, config.clientId)
  } catch (error) {
    failLogin(generation, error)
    throw error
  }
}

function endPending(): void {
  pollingGen = null
  loginSession = null
  loginStorage = null
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
  const context = loginStorage
  if (!context || !isCredentialCurrent(context)) throw new Error('登录已取消或数据目录已变更，请重新登录')
  const profile = await fetchProfile(parseCredential(token).access, activeAbort?.signal)
  if (generation !== loginGeneration) return
  if (!isCredentialCurrent(context)) throw new Error('登录已取消或数据目录已变更，请重新登录')
  const encrypted = await encryptToken(token, activeAbort?.signal)
  if (generation !== loginGeneration) return
  // No await between the guarded credential commit and profile commit/notification.
  writeToken(token, encrypted, context, profile)
  try { settingsStore.setProfileUser(encrypted ? profile : null) }
  catch (error) { clearToken(); throw error }
  activeCallback?.complete(true)
  endPending()
  try {
    const win = getMainWindow()
    if (win && !win.isDestroyed()) {
      if (win.isMinimized()) win.restore()
      win.show()
      if (process.platform === 'darwin') app.focus({ steal: true })
      win.focus()
    }
  } catch { logWarn('github', 'Signed in; could not activate the desktop window') }
  try {
    notifyProfile(profile)
    publishLoginStatus({ phase: 'authorized' })
  } catch { logWarn('github', 'Signed in; window notification unavailable') }
  for (const listener of authenticatedListeners) {
    try { listener() } catch { logWarn('github', 'Post-login sync unavailable') }
  }
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
    body: JSON.stringify({ client_id: clientId }),
  })
  if (generation !== loginGeneration) throw new Error('登录已取消')
  if (!code.device_code || !/^[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(code.user_code) || !Number.isSafeInteger(code.expires_in) || code.expires_in <= 0 || code.expires_in > 3600) throw new Error('无法获取 GitHub 授权码，请确认应用已启用 Device Flow')
  // The known GitHub page is used instead of opening a server-provided arbitrary URL.
  const session: GithubLoginSessionPayload = { mode: 'device', userCode: code.user_code,
    verificationUri: 'https://github.com/login/device', expiresInSeconds: code.expires_in }
  loginSession = session
  loginTimeout = setTimeout(() => failLogin(generation, new Error('授权码已过期，请重新登录')), code.expires_in * 1000)
  loginTimeout.unref()
  try { await writeClipboardText(session.userCode, { excludeFromHistory: true }, activeAbort?.signal); session.copied = true }
  catch { session.copied = false }
  if (generation !== loginGeneration) throw new Error('登录已取消')
  publishLoginStatus({ phase: 'pending' })
  await shell.openExternal(session.verificationUri)
  if (generation !== loginGeneration) throw new Error('登录已取消')
  const interval = Number.isSafeInteger(code.interval) && code.interval > 0 && code.interval <= 300 ? code.interval : 5
  void pollForToken(generation, clientId, code.device_code, Math.max(POLL_MIN_INTERVAL_S, interval) * 1000)
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
    let result: GithubGrant
    try {
      result = await requestGrant({ client_id: clientId, device_code: deviceCode, grant_type: 'urn:ietf:params:oauth:grant-type:device_code' }, signal)
    } catch (error) {
      const status = (error as { status?: number }).status
      if (signal.aborted) return
      if (status && status < 500 && status !== 429) throw error
      intervalMs = Math.max(intervalMs, Math.min(60_000, intervalMs * 2)); continue
    }
    if (generation !== loginGeneration) return
    if (result.access_token) { await finishLogin(generation, deviceCredential(result, clientId)); return }
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
export async function copyGithubDeviceCode(): Promise<void> {
  if (loginSession?.mode !== 'device' || !activeAbort) throw new Error('没有待确认的设备授权')
  await writeClipboardText(loginSession.userCode, { excludeFromHistory: true }, activeAbort.signal)
}

export function disposeGithubSession(): void {
  invalidateAccount()
  loginGeneration++
  setMemoryGithubSession(null)
  tokenCache = undefined
  endPending()
}

export function logoutGithub(): void {
  invalidateAccount()
  cancelGithubLogin()
  clearToken()
  publishProfile(null)
  logInfo('github', 'logged out')
}

async function accessCredential() {
  const context = credentialContext(), signal = accountLifetime.signal
  let stored = await readToken()
  if (!stored || !isCredentialCurrent(context)) throw new Error('无法静默读取 GitHub 凭据。请解锁本机密钥库后重试，或重新登录 GitHub。')
  let credential = parseCredential(stored)
  if (credential.clientId && credential.clientId !== getGithubAuthConfig().clientId) throw new Error('登录应用已变更，请重新登录')
  if (credential.expiresAt && credential.expiresAt < Date.now() + 60_000) {
    const { refresh, clientId } = credential
    if (!refresh || !clientId || (credential.refreshExpiresAt ?? Infinity) <= Date.now()) throw Object.assign(new Error('GitHub 授权已过期，请重新登录'), { status: 401 })
    if (!renewal || !isCredentialCurrent(renewal.context)) {
      const task = (async () => {
        const grant = await requestGrant({ client_id: clientId, grant_type: 'refresh_token', refresh_token: refresh }, signal)
        if (grant.error === 'bad_refresh_token' || grant.error === 'expired_token' || grant.error === 'invalid_grant') throw Object.assign(new Error('GitHub 授权已失效，请重新登录'), { status: 401 })
        const next = deviceCredential(grant, clientId)
        const user = getProfileUser()
        if (!user || !isCredentialCurrent(context)) throw new Error('GitHub 账号已变更')
        const temporary = getMemoryGithubSession()
        const encrypted = temporary ? null : await encryptToken(next, signal)
        writeToken(next, encrypted, context, user)
        if (!encrypted && !temporary) { settingsStore.setProfileUser(null); notifyProfile(user) }
        return next
      })()
      renewal = { context, task }
      void task.finally(() => { if (renewal?.task === task) renewal = undefined }).catch(() => {})
    }
    stored = await renewal.task
    signal.throwIfAborted()
    if (context.rootGeneration !== getAppPathsGeneration()) throw new Error('数据目录已变更')
    credential = parseCredential(stored)
  }
  return { credential, context: credentialContext(), signal }
}

export async function getGithubSyncSession() {
  let current = credentialContext()
  try {
    const { credential, context, signal } = await accessCredential()
    current = context
    const profile = getProfileUser()
    if (!credential.clientId || !profile?.githubId) throw new Error('请使用 GitHub 设备授权重新登录以启用同步')
    const user = await githubJson<{ id: number; login: string }>(USER_URL, { signal, headers: { Authorization: `Bearer ${credential.access}`, 'User-Agent': 'eNest' } })
    const check = () => { if (signal.aborted || !isCredentialCurrent(context) || getProfileUser()?.githubId !== user.id) throw new Error('账号或数据目录已变更') }
    if (user.id !== profile.githubId || !/^[a-z\d][a-z\d-]{0,38}$/i.test(user.login)) throw new Error('GitHub 账号不匹配，请重新登录')
    check()
    return { token: credential.access, user, signal, check }
  } catch (error) {
    if ((error as { status?: number }).status === 401 && isCredentialCurrent(current)) { invalidateAccount(); clearToken(); publishProfile(null); throw new Error('GitHub 授权已失效，请重新登录。') }
    throw error
  }
}

export async function refreshProfileOnBoot(): Promise<void> {
  let context = credentialContext()
  try {
    if (!await readToken() || !isCredentialCurrent(context)) {
      if (isCredentialCurrent(context) && !existsSync(context.file) && getProfileUser()) publishProfile(null)
      return
    }
    const current = await accessCredential()
    context = current.context
    const profile = await fetchProfile(current.credential.access, current.signal)
    if (isCredentialCurrent(context)) {
      const previous = getProfileUser()
      if (previous && (previous.githubId === profile.githubId || !previous.githubId && previous.login === profile.login)) {
        profile.connectedAt = previous.connectedAt
        profile.avatarDataUrl ??= previous.avatarUrl === profile.avatarUrl ? previous.avatarDataUrl : null
      }
      publishProfile(profile)
      for (const listener of authenticatedListeners) listener()
    }
  } catch (err) {
    if (!isCredentialCurrent(context)) return
    if ((err as { status?: number }).status === 401) {
      invalidateAccount()
      clearToken()
      publishProfile(null)
    } else logWarn('github', 'Profile refresh unavailable; keeping cached profile')
  }
}

export function getProfileUser(): UserProfile | null {
  return getActiveGithubProfile()
}
export function getGithubCredentialNotice(): AccountState['credentialNotice'] {
  if (getMemoryGithubSession()) return 'session-only'
  if (legacyStorage && legacyStorage.rootGeneration === getAppPathsGeneration() && legacyStorage.file === tokenFile()) return 'reauth-required'
}
export async function hasGithubToken(): Promise<boolean> {
  const context = credentialContext()
  return await readToken() !== null && isCredentialCurrent(context)
}
