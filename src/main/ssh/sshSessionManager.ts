import type { LocalFileHandle, LocalFilePickOptions } from '@shared/types/local-files'
import { authorizePluginPermission } from '@main/plugin/PluginPermissions'
import { resolveLocalFileHandle, resolveLocalDirectoryTarget, pickLocalFiles } from '@main/plugin/localFiles'
/**
 * sshSessionManager — SSH 会话 / exec / metrics / sftp / completion 宿主服务
 * 职责：以 ssh2 建立 shell/exec 通道；入参 secretRef 经 vault 解密；
 *      经 sendPluginEvent 推送 ssh.data / ssh.exit / ssh.error / ssh.metrics；
 *      提供 SFTP 最小集与静态词典 + 远程路径补全。
 * 被 pluginHandlers 分发调用（method 以 ssh.* 开头）。
 * 关键依赖：ssh2、@main/vault/secretVault、@main/ssh/commandDict、PluginHost 事件通道。
 */
import { createWriteStream, createReadStream, existsSync, readFileSync, statSync } from 'node:fs'
import { createHash, randomUUID } from 'node:crypto'
import { homedir } from 'node:os'
import { StringDecoder } from 'node:string_decoder'
import { pipeline } from 'node:stream/promises'
import { basename, join, posix } from 'node:path'
import { Client, type ClientChannel, type ConnectConfig, type SFTPWrapper } from 'ssh2'
import type {
  SshCompletionItem,
  SshCompletionResult,
  SshConnectInput,
  SshExecInput,
  SshExecResult,
  SshMetricsSample,
  SshSessionInfo,
  SftpEntry,
  SftpListInput,
  SftpDownloadInput,
  SftpUploadInput,
  SftpTransferResult
} from '@shared/types/ssh-db'
import type { PluginEventPayload } from '@shared/types/ipc'
import { resolveSecret } from '@main/vault/secretVault'
import {
  SSH_COMMAND_DICT,
  SSH_SUBCOMMANDS,
  detectDangerous,
  lookupDictCmd
} from '@main/ssh/commandDict'
import { pluginHost } from '@main/plugin/PluginHost'
import { logInfo, logWarn } from '@main/logs/logService'
import { verifySshHost } from '@main/ssh/sshTrust'
import { openSshProxy } from '@main/ssh/sshProxy'
import { systemSnapshot, releaseSystemState } from '@main/ssh/sshSystem'
import { acquirePluginActivity } from '@main/plugin/activityRegistry'
import { getRuntimeScope, type PluginRuntimeScope } from '@main/plugin/PluginRuntimeScope'

export interface SshSession {
  scope: PluginRuntimeScope
  controller: AbortController
  releaseScopeActivity: () => void
  detachScope?: () => void
  onScopeAbort?: () => void
  disposed?: boolean
  jumpClient?: Client
  jumpClients?: Client[]
  sftpOpening?: Promise<SFTPWrapper>
  releaseActivity?: () => void
  cleanup?: Set<() => void>
  sessionId: string
  pluginId: string
  profileId?: string
  host: string
  port: number
  username: string
  status: 'connecting' | 'connected' | 'disconnected' | 'exited'
  fingerprint?: string
  serverIdent?: string
  connectedAt?: number
  cols: number
  rows: number
  client: Client
  shell?: ClientChannel
  sftp?: SFTPWrapper
  metricsTimer?: NodeJS.Timeout
  metricsIntervalMs: number
  lastSample?: SshMetricsSample
  /** 远程路径补全缓存：前缀 → 结果，3s TTL */
  pathCache: Map<string, { ts: number; items: string[] }>
}

const sessions = new Map<string, SshSession>()
let sessionSeq = 0
const authChallenges = new Map<string, { session: SshSession; count: number; finish: (answers: string[]) => void; cleanup: () => void }>()

function attachInteractiveAuth(session: SshSession, client: Client, host: string): void {
  client.on('keyboard-interactive', (_name, instructions, _lang, prompts, finish) => {
    if (!isSessionCurrent(session)) { finish([]); return }
    const challengeId = randomUUID()
    const cleanup = (): void => { authChallenges.delete(challengeId); session.cleanup?.delete(cleanup) }
    authChallenges.set(challengeId, { session, count: prompts.length, finish, cleanup })
    session.cleanup ??= new Set(); session.cleanup.add(cleanup)
    emitToPlugin(session.pluginId, { type: 'ssh.auth', sessionId: session.sessionId, challengeId, host, instructions, prompts: prompts.map(p => ({ prompt: p.prompt, echo: p.echo ?? false })) })
  })
}

export function sshRespondAuth(pluginId: string, challengeId: string, answers: string[] | null): boolean {
  const challenge = authChallenges.get(challengeId)
  if (!challenge || challenge.session.pluginId !== pluginId) throw new Error('认证请求已过期')
  assertSessionCurrent(challenge.session)
  if (answers && (answers.length !== challenge.count || answers.some(value => typeof value !== 'string' || value.length > 16384))) throw new Error('认证回答无效')
  challenge.cleanup()
  if (!answers) { sshDisconnect(pluginId, challenge.session.sessionId); return false }
  challenge.finish(answers)
  return true
}

/** 向插件 webContents 推送事件（Host 公开访问器，无反射）；找不到视图时静默丢弃 */
function emitToPlugin(pluginId: string, payload: PluginEventPayload): void {
  if ('sessionId' in payload && typeof payload.sessionId === 'string') {
    const session = sessions.get(payload.sessionId)
    if (!session || session.pluginId !== pluginId || !isSessionCurrent(session)) return
  }
  pluginHost.sendEvent(pluginId, payload)
}

function isSessionCurrent(session: SshSession): boolean {
  return !session.disposed && !session.controller.signal.aborted && !session.scope.signal.aborted &&
    session.scope.isCurrent() && sessions.get(session.sessionId) === session
}

function assertSessionCurrent(session: SshSession): void {
  if (!isSessionCurrent(session)) throw new Error('SSH session is closing')
}

/** Reserve ownership before asynchronous connection/channel creation starts. */
function ownedStep<T>(session: SshSession, operation: (resolve: (value: T) => void, reject: (error: Error) => void) => void, timeoutMs = 20_000): Promise<T> {
  assertSessionCurrent(session)
  return new Promise<T>((resolve, reject) => {
    let settled = false
    const finish = (error?: Error, value?: T): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      session.controller.signal.removeEventListener('abort', aborted)
      if (error) reject(error); else resolve(value as T)
    }
    const aborted = () => finish(new Error('SSH session is closing'))
    const timer = setTimeout(() => {
      finish(new Error('SSH operation timed out'))
      sshDisconnect(session.pluginId, session.sessionId)
    }, Math.max(100, Math.min(120_000, timeoutMs)))
    session.controller.signal.addEventListener('abort', aborted, { once: true })
    try { operation(value => isSessionCurrent(session) ? finish(undefined, value) : aborted(), error => finish(error)) }
    catch (error) { finish(error as Error) }
  })
}

function nextSessionId(): string {
  sessionSeq += 1
  return `ssh_${Date.now().toString(36)}_${sessionSeq}`
}

/** 解析认证密钥：secretRef → vault；ephemeralSecret 直接用；二者皆无则看 authType */
function resolveAuthSecret(
  pluginId: string,
  secretRef?: string,
  ephemeralSecret?: string
): string | null {
  if (ephemeralSecret) return ephemeralSecret
  if (secretRef) return resolveSecret(pluginId, secretRef)
  return null
}

async function buildConnectConfig(input: SshConnectInput & { password?: string }, pluginId: string): Promise<ConnectConfig> {
  // 插件 UI 可能传 password 字段作为一次性口令；规范名为 ephemeralSecret
  const ephemeralSecret = input.ephemeralSecret ?? (input as { password?: string }).password
  const port = input.port && input.port > 0 ? input.port : 22
  const timeoutMs = input.timeoutMs && input.timeoutMs > 0 ? input.timeoutMs : 20_000
  const keepAliveMs = input.keepAliveSec && input.keepAliveSec > 0 ? input.keepAliveSec * 1000 : 15_000
  const cfg: ConnectConfig = {
    host: input.host,
    port,
    username: input.username,
    readyTimeout: timeoutMs,
    keepaliveInterval: keepAliveMs,
    keepaliveCountMax: 3
  }
  if ('privateKeyPath' in input || 'agentPath' in input) throw new Error('raw credential paths are not supported; select a private key handle')
  const authType = input.authType ?? (input.privateKeyHandleId ? 'key' : 'password')
  if (authType === 'keyboard-interactive') {
    cfg.tryKeyboard = true
    cfg.authHandler = ['keyboard-interactive']
    cfg.readyTimeout = Math.max(120_000, timeoutMs)
    return cfg
  }
  if (authType === 'agent') {
    await authorizePluginPermission(pluginId, 'ssh.agent', `使用本机 SSH Agent 连接 ${input.username}@${input.host}`)
    cfg.agent = process.env.SSH_AUTH_SOCK || (process.platform === 'win32' ? 'pageant' : undefined)
    if (!cfg.agent) throw new Error('SSH_AUTH_SOCK not set; ssh-agent unavailable')
    return cfg
  }
  if (authType === 'key') {
    if (!input.privateKeyHandleId) throw new Error('privateKeyHandleId is required for key auth')
    const keyPath = await resolveLocalFileHandle(pluginId, input.privateKeyHandleId, 'read')
    const info = statSync(keyPath)
    if (!info.isFile() || info.size > 1024 * 1024) throw new Error('invalid private key file')
    cfg.privateKey = readFileSync(keyPath)
    const passphrase = resolveAuthSecret(pluginId, input.secretRef, ephemeralSecret)
    if (passphrase) cfg.passphrase = passphrase
    return cfg
  }
  // password
  const password = resolveAuthSecret(pluginId, input.secretRef, ephemeralSecret)
  if (!password) throw new Error('password secret required (secretRef or ephemeralSecret/password)')
  cfg.password = password
  return cfg
}

function fingerprintOf(key: Buffer): string {
  try {
    return 'SHA256:' + createHash('sha256').update(key).digest('base64').replace(/=+$/, '')
  } catch {
    return ''
  }
}

export async function sshConnect(
  pluginId: string,
  input: SshConnectInput
): Promise<SshSessionInfo> {
  if (!input?.host || !input?.username) throw new Error('host and username required')
  const sessionId = nextSessionId()
  const port = input.port && input.port > 0 ? input.port : 22
  const scope = getRuntimeScope(pluginId)
  if (!scope || !scope.isCurrent() || scope.signal.aborted) throw new Error('plugin runtime is closing')
  const cfg = await buildConnectConfig(input, pluginId)
  if (!scope.isCurrent() || scope.signal.aborted) throw new Error('plugin runtime is closing')
  const client = new Client()
  const session: SshSession = {
    scope, controller: new AbortController(), releaseScopeActivity: scope.acquireActivity('ssh:connection'),
    sessionId, pluginId, profileId: input.profileId, host: input.host, port, username: input.username,
    status: 'connecting', cols: input.cols && input.cols > 0 ? input.cols : 80,
    rows: input.rows && input.rows > 0 ? input.rows : 24, client, metricsIntervalMs: 5000,
    pathCache: new Map(), cleanup: new Set()
  }
  sessions.set(sessionId, session)
  session.onScopeAbort = () => { sshDisconnect(pluginId, sessionId) }
  scope.signal.addEventListener('abort', session.onScopeAbort, { once: true })
  session.detachScope = scope.addDisposer(() => { sshDisconnect(pluginId, sessionId) })
  // Each hop is owned before connecting so every partial chain is closed on cancellation.
  const jumps = input.jumps?.length ? input.jumps : input.jump?.host ? [input.jump] : []
  try {
    if (jumps.length > 8) throw new Error('跳板链最多支持 8 层')
    let forwardedSocket: ConnectConfig['sock']
    if (input.proxy) {
      const firstHop = jumps[0] || input
      forwardedSocket = await openSshProxy(input.proxy, { host: firstHop.host, port: firstHop.port || 22 },
        resolveAuthSecret(pluginId, input.proxy.secretRef, input.proxy.ephemeralSecret), {
          signal: session.controller.signal, timeoutMs: cfg.readyTimeout || 20000,
          ownSocket: socket => { session.cleanup?.add(() => socket.destroy()) }
        })
      assertSessionCurrent(session)
    }
    for (let index = 0; index < jumps.length; index++) {
      const hop = jumps[index]
      if (!hop.host || !hop.username) throw new Error(`跳板 ${index + 1} 缺少主机或用户名`)
      const jumpClient = new Client()
      session.jumpClient ??= jumpClient
      session.jumpClients ??= []
      session.jumpClients.push(jumpClient)
      const jumpCfg = await buildConnectConfig(hop, pluginId)
      assertSessionCurrent(session)
      attachInteractiveAuth(session, jumpClient, hop.host)
      if (forwardedSocket) jumpCfg.sock = forwardedSocket
      let jumpTrustError: Error | undefined
      jumpCfg.hostVerifier = (key: Buffer) => {
        try { verifySshHost(pluginId, hop.host, hop.port || 22, fingerprintOf(key)); return true }
        catch (error) { jumpTrustError = error as Error; return false }
      }
      await ownedStep<void>(session, (resolve, reject) => {
        jumpClient
          .on('ready', () => resolve())
          .on('error', (err: Error) => { reject(jumpTrustError || err); sshDisconnect(pluginId, sessionId) })
          .on('close', () => { if (isSessionCurrent(session)) sshDisconnect(pluginId, sessionId) })
          .connect(jumpCfg)
      }, jumpCfg.readyTimeout)
      assertSessionCurrent(session)
      const nextHop = jumps[index + 1] || input
      forwardedSocket = await ownedStep(session, (resolve, reject) => {
        jumpClient.forwardOut('127.0.0.1', 0, nextHop.host, nextHop.port || 22, (err, stream) => {
          if (err) reject(err)
          else if (!isSessionCurrent(session)) { stream.destroy(); reject(new Error('SSH session is closing')) }
          else resolve(stream as never)
        })
      })
    }
    if (forwardedSocket) cfg.sock = forwardedSocket

    let trustError: Error | undefined
    attachInteractiveAuth(session, client, input.host)
    await ownedStep<void>(session, (resolve, reject) => {
      client
        .on('ready', () => {
          if (!isSessionCurrent(session)) { client.destroy(); return reject(new Error('SSH session is closing')) }
          session.status = 'connected'
          session.connectedAt = Date.now()
          client.on('banner', () => {})
          resolve()
        })
        .on('error', (err: Error) => {
          session.status = 'exited'
          emitToPlugin(pluginId, { type: 'ssh.error', sessionId, message: (trustError || err).message })
          reject(trustError || err)
          sshDisconnect(pluginId, sessionId)
        })
        .on('close', () => {
          sshDisconnect(pluginId, sessionId)
        })
      // host key 指纹：ssh2 通过 hostVerifier 暴露
      const cfgWithVerifier = cfg as ConnectConfig & { hostVerifier?: unknown }
      cfgWithVerifier.hostVerifier = (hashedKey: Buffer) => {
        session.fingerprint = fingerprintOf(hashedKey)
        try {
          verifySshHost(pluginId, input.host, port, session.fingerprint, (input as SshConnectInput & { fingerprintPolicy?: string }).fingerprintPolicy)
          return true
        } catch (error) { trustError = error as Error; return false }
      }
      client.on('banner', (message: string) => {
        session.serverIdent = message?.slice(0, 200)
      })
      try {
        client.connect(cfg)
      } catch (err) {
        reject(err as Error)
      }
    }, cfg.readyTimeout)

    // 打开 shell 通道（xterm 数据通道）
    await ownedStep<void>(session, (resolve, reject) => {
      client.shell(
        { term: input.term || 'xterm-256color', cols: session.cols, rows: session.rows },
        (err, channel) => {
          if (err) return reject(err)
          if (!isSessionCurrent(session)) { channel.destroy(); return reject(new Error('SSH session is closing')) }
          session.shell = channel
          session.releaseActivity = acquirePluginActivity(pluginId, sessionId, 'SSH 连接')
          const decoder = new StringDecoder('utf8')
          channel.on('data', (data: Buffer) => {
            emitToPlugin(pluginId, {
              type: 'ssh.data',
              sessionId,
              data: decoder.write(data)
            })
          })
          channel.on('close', (code?: number | null, signal?: string) => {
            session.status = 'exited'
            stopMetrics(sessionId)
            session.releaseActivity?.()
            emitToPlugin(pluginId, {
              type: 'ssh.exit',
              sessionId,
              code: code ?? null,
              signal
            })
            sshDisconnect(pluginId, sessionId)
          })
          resolve()
        }
      )
    })

    // The owner may have closed while the final channel callback was queued.
    assertSessionCurrent(session)
    logInfo('ssh', `session opened ${sessionId} ${input.username}@${input.host}:${port}`)
    return toInfo(session)
  } catch (error) { sshDisconnect(pluginId, sessionId); throw error }
}

function toInfo(s: SshSession): SshSessionInfo {
  return {
    sessionId: s.sessionId,
    profileId: s.profileId,
    host: s.host,
    port: s.port,
    username: s.username,
    status: s.status,
    fingerprint: s.fingerprint,
    serverIdent: s.serverIdent,
    connectedAt: s.connectedAt,
    cols: s.cols,
    rows: s.rows
  }
}

function requireSession(sessionId: string | undefined | null): SshSession {
  const id = String(sessionId ?? '')
  const s = sessions.get(id)
  if (!s) throw new Error(`ssh session not found: ${id}`)
  assertSessionCurrent(s)
  return s
}

export function sshWrite(pluginId: string, sessionId: string, data: string): boolean {
  const s = requireSession(sessionId)
  if (s.pluginId !== pluginId) throw new Error('session does not belong to this plugin')
  if (!s.shell) throw new Error('shell channel not ready')
  s.shell.write(String(data ?? ''))
  return true
}

export function sshResize(
  pluginId: string,
  sessionId: string,
  cols: number,
  rows: number
): boolean {
  const s = requireSession(sessionId)
  if (s.pluginId !== pluginId) throw new Error('session does not belong to this plugin')
  const c = Math.max(1, Math.min(500, Math.round(Number(cols) || s.cols)))
  const r = Math.max(1, Math.min(300, Math.round(Number(rows) || s.rows)))
  s.cols = c
  s.rows = r
  s.shell?.setWindow(r, c, 0, 0)
  return true
}

export function sshDisconnect(pluginId: string, sessionId: string): boolean {
  const s = sessions.get(sessionId)
  if (!s) return true
  if (s.pluginId !== pluginId) throw new Error('session does not belong to this plugin')
  if (s.disposed) return true
  s.disposed = true
  stopMetrics(sessionId)
  s.controller.abort(new Error('SSH session closed'))
  if (s.onScopeAbort) s.scope.signal.removeEventListener('abort', s.onScopeAbort)
  s.detachScope?.()
  s.releaseScopeActivity()
  s.releaseActivity?.()
  // Each resource must close even when an independent cleanup fails.
  for (const close of s.cleanup ?? []) { try { close() } catch (error) { logWarn('ssh', `cleanup failed ${sessionId}: ${String(error)}`) } }
  s.cleanup?.clear()
  try {
    s.shell?.destroy()
  } catch {
    /* ignore */
  }
  try {
    s.sftp?.end()
  } catch {
    /* ignore */
  }
  try {
    s.client.destroy()
  } catch {
    /* ignore */
  }
  for (const jump of [...(s.jumpClients || (s.jumpClient ? [s.jumpClient] : []))].reverse()) {
    try {
      jump.destroy()
    } catch {
      /* ignore */
    }
  }
  s.status = 'disconnected'
  s.pathCache.clear()
  releaseSystemState(sessionId)
  sessions.delete(sessionId)
  return true
}

export function sshListSessions(pluginId: string): SshSessionInfo[] {
  return [...sessions.values()]
    .filter((s) => s.pluginId === pluginId)
    .map(toInfo)
}

export async function sshExec(pluginId: string, input: SshExecInput): Promise<SshExecResult> {
  const s = requireSession(input.sessionId)
  if (s.pluginId !== pluginId) throw new Error('session does not belong to this plugin')
  const command = String(input.command ?? '')
  if (!command) throw new Error('command required')
  const timeoutMs = Math.max(100, Math.min(600_000, input.timeoutMs && input.timeoutMs > 0 ? input.timeoutMs : 30_000))
  const started = Date.now()
  return new Promise<SshExecResult>((resolve, reject) => {
    let stream: ClientChannel | undefined, settled = false, bytes = 0
    let stdout = '', stderr = ''
    const outDecoder = new StringDecoder('utf8'), errDecoder = new StringDecoder('utf8')
    const finish = (error?: Error, code?: number | null): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      s.controller.signal.removeEventListener('abort', aborted)
      if (error) {
        try { stream?.signal('TERM') } catch { /* remote signal unsupported */ }
        try { stream?.close() } catch { /* disconnected */ }
        try { stream?.destroy() } catch { /* disconnected */ }
        reject(error)
      } else resolve({ stdout: stdout + outDecoder.end(), stderr: stderr + errDecoder.end(), exitCode: code ?? null, durationMs: Date.now() - started })
    }
    const aborted = () => finish(new Error('SSH session is closing'))
    const timer = setTimeout(() => finish(new Error(`ssh exec timeout after ${timeoutMs}ms`)), timeoutMs)
    s.controller.signal.addEventListener('abort', aborted, { once: true })
    try { s.client.exec(command, (err, channel) => {
      if (err) return finish(err)
      if (settled || !isSessionCurrent(s)) { channel.destroy(); return aborted() }
      stream = channel
      const retain = (data: Buffer, output: 'stdout' | 'stderr'): void => {
        if (settled) return
        bytes += data.length
        if (bytes > 8 * 1024 * 1024) return finish(new Error('SSH exec output exceeds 8 MiB; use a file transfer for large output'))
        if (output === 'stdout') stdout += outDecoder.write(data)
        else stderr += errDecoder.write(data)
      }
      channel.on('data', (d: Buffer) => {
        retain(d, 'stdout')
      })
      channel.stderr.on('data', (d: Buffer) => {
        retain(d, 'stderr')
      })
      channel.once('error', (error: Error) => finish(error))
      channel.stderr.once('error', (error: Error) => finish(error))
      channel.once('close', (code: number | null) => finish(undefined, code))
    }) } catch (error) { finish(error as Error) }
  })
}

// Metrics are detected and sampled on the remote platform; counters are session-local.
async function sampleOnce(session: SshSession): Promise<SshMetricsSample> {
  try {
    const sample = await systemSnapshot(session.pluginId, session.sessionId)
    session.lastSample = sample
    return sample
  } catch (error) {
    const sample = { ts: Date.now(), error: (error as Error).message }
    session.lastSample = sample
    return sample
  }
}

export function sshMetricsStart(
  pluginId: string,
  sessionId: string,
  intervalMs?: number
): { ok: boolean; intervalMs: number } {
  const s = requireSession(sessionId)
  if (s.pluginId !== pluginId) throw new Error('session does not belong to this plugin')
  stopMetrics(sessionId)
  const ms = Math.max(2000, Math.min(60_000, Math.round(Number(intervalMs) || 5000)))
  s.metricsIntervalMs = ms
  let sampling = false
  const tick = async () => {
    if (s.status !== 'connected' || sampling) return
    sampling = true
    try {
      const sample = await sampleOnce(s)
      if (s.status === 'connected') emitToPlugin(pluginId, { type: 'ssh.metrics', sessionId, sample })
    } finally { sampling = false }
  }
  void tick()
  s.metricsTimer = setInterval(() => void tick(), ms)
  return { ok: true, intervalMs: ms }
}

export function sshMetricsStop(pluginId: string, sessionId: string): boolean {
  requireOwnedSshSession(pluginId, sessionId)
  stopMetrics(sessionId)
  return true
}

function stopMetrics(sessionId: string): void {
  const s = sessions.get(sessionId)
  if (!s?.metricsTimer) return
  clearInterval(s.metricsTimer)
  s.metricsTimer = undefined
}

export function sshMetricsLatest(pluginId: string, sessionId: string): SshMetricsSample | null {
  const s = requireSession(sessionId)
  if (s.pluginId !== pluginId) throw new Error('session does not belong to this plugin')
  return s.lastSample ?? null
}

// —— Completion（Spec SSH-E）——

function currentWord(line: string, cursor?: number): { word: string; isPathLike: boolean; start: number } {
  const pos = cursor !== undefined && cursor >= 0 ? Math.min(cursor, line.length) : line.length
  const before = line.slice(0, pos)
  let start = 0, quote = '', escaped = false
  for (let i = 0; i < before.length; i++) {
    const char = before[i]
    if (escaped) { escaped = false; continue }
    if (char === '\\' && quote !== "'") { escaped = true; continue }
    if (quote) { if (char === quote) quote = ''; continue }
    if (char === "'" || char === '"') quote = char
    else if (/[\s|;&]/.test(char)) start = i + 1
  }
  const word = before.slice(start)
  return { word, isPathLike: word.includes('/'), start }
}

async function remotePathComplete(
  session: SshSession,
  prefix: string,
  cwd?: string
): Promise<string[]> {
  const cacheKey = `${cwd || ''}|${prefix}`
  const cached = session.pathCache.get(cacheKey)
  const now = Date.now()
  if (cached && now - cached.ts < 3000) return cached.items
  // Never interpolate user input into a remote shell command.
  try {
    const sftp = await getSftp(session)
    const home = await ownedStep<string>(session, (resolve, reject) => sftp.realpath('.', (e, p) => e ? reject(e) : resolve(p)))
    const unquoted = prefix.replace(/^['"]/, '').replace(/['"]$/, '').replace(/\\([\\ '"$`])/g, '$1')
    const normalized = unquoted.startsWith('~/') ? home + unquoted.slice(1) : unquoted
    const split = normalized.lastIndexOf('/')
    const relativeDirectory = split >= 0 ? normalized.slice(0, split + 1) : '.'
    const directory = posix.isAbsolute(relativeDirectory) ? relativeDirectory : cwd && posix.isAbsolute(cwd) ? posix.join(cwd, relativeDirectory) : relativeDirectory
    const word = normalized.slice(split + 1)
    const entries = await ownedStep<Array<{ filename: string; attrs: { isDirectory(): boolean } }>>(session, (resolve, reject) => sftp.readdir(directory, (e, list) => e ? reject(e) : resolve(list)))
    const items = entries.filter(x => x.filename.startsWith(word)).slice(0, 50).map(x => {
      const path = (split >= 0 ? normalized.slice(0, split + 1) : '') + x.filename + (x.attrs.isDirectory() ? '/' : '')
      return /[^a-zA-Z0-9_./~:@%+,-]/.test(path) ? `'${path.replace(/'/g, `'\\''`)}'` : path
    })
    assertSessionCurrent(session)
    if (session.pathCache.size >= 128) session.pathCache.delete(session.pathCache.keys().next().value!)
    session.pathCache.set(cacheKey, { ts: now, items })
    return items
  } catch { return [] }

}

export async function sshCompletionSuggest(
  pluginId: string,
  input: {
    sessionId: string
    line: string
    cursor?: number
    cwd?: string
    history?: string[]
    snippets?: Array<{ title: string; command: string }>
  }
): Promise<SshCompletionResult> {
  const items: SshCompletionItem[] = []
  const line = String(input.line ?? '')
  const { word, isPathLike } = currentWord(line, input.cursor)
  const lower = word.toLowerCase()

  const push = (item: SshCompletionItem) => {
    items.push(item)
  }

  // 危险命令检测（对整行）
  const danger = detectDangerous(line)

  // 片段（优先级 2）
  for (const sn of input.snippets ?? []) {
    const hit =
      sn.title?.toLowerCase().includes(lower) ||
      sn.command?.toLowerCase().startsWith(lower)
    if (!hit && word) continue
    if (!word && !sn.command) continue
    push({
      label: sn.title || sn.command,
      kind: 'snippet',
      detail: sn.command,
      insertText: sn.command,
      sortText: `1_${sn.title ?? sn.command}`,
      dangerous: detectDangerous(sn.command) !== null
    })
  }

  // 历史（优先级 3）
  for (const h of input.history ?? []) {
    if (word && !h.toLowerCase().startsWith(lower)) continue
    push({
      label: h,
      kind: 'history',
      detail: '历史命令',
      insertText: h,
      sortText: `2_${h}`,
      dangerous: detectDangerous(h) !== null
    })
  }

  // 远程路径（优先级 1，已连接且像路径）
  const s = sessions.get(input.sessionId)
  if (s && s.pluginId === pluginId && s.status === 'connected' && (isPathLike || input.cwd && /\s/.test(line) && !word.startsWith('-'))) {
    const paths = await remotePathComplete(s, word, input.cwd)
    for (const p of paths) {
      push({
        label: p,
        kind: 'path',
        detail: '远程路径',
        insertText: p,
        sortText: `0_${p}`
      })
    }
  }

  // 上下文：sudo / | 后的管道命令 / systemctl 动词
  const tokens = line.trim().split(/\s+/).filter(Boolean)
  const lastCmd = [...tokens].reverse().find((t) => !t.startsWith('-')) ?? ''
  const afterPipe = /\|\s*(\S*)$/.exec(line)?.[1]
  const contextCmd = afterPipe !== undefined ? afterPipe : word

  // 子命令上下文
  const subKey = tokens.length >= 2 && !tokens[tokens.length - 1]?.startsWith('-')
    ? tokens[tokens.length - 2]
    : tokens[0]
  if (subKey && SSH_SUBCOMMANDS[subKey] && tokens.length >= 2 && !isPathLike) {
    for (const sub of SSH_SUBCOMMANDS[subKey]) {
      if (!word || sub.toLowerCase().startsWith(lower)) {
        push({
          label: sub,
          kind: 'cmd',
          detail: `${subKey} 子命令`,
          insertText: sub,
          sortText: `3_${sub}`
        })
      }
    }
  }

  // 静态词典（优先级 4）
  if (!isPathLike) {
    const lookupPrefix = contextCmd || word
    if (lookupPrefix.length > 0 || !line.trim()) {
      const cmds = lookupDictCmd(lookupPrefix.length > 0 ? lookupPrefix : word)
      for (const c of cmds) {
        push({
          label: c.cmd,
          kind: 'cmd',
          detail: c.desc,
          insertText: c.cmd,
          sortText: `4_${c.cmd}`
        })
      }
    }
    // flags：当前命令的 flags
    const activeCmd = tokens.length > 0 && !tokens[0]!.startsWith('-') ? tokens[0]! : lastCmd
    const dict = SSH_COMMAND_DICT.find((c) => c.cmd === activeCmd)
    if (dict && word.startsWith('-')) {
      for (const f of dict.flags) {
        if (!word || f.name.toLowerCase().startsWith(lower)) {
          push({
            label: f.name,
            kind: 'flag',
            detail: f.desc,
            insertText: f.name,
            sortText: `5_${f.name}`,
            dangerous: f.desc.includes('危险')
          })
        }
      }
    }
  }

  // 去重 + 限流
  const seen = new Set<string>()
  const unique = items.filter((it) => {
    const k = `${it.kind}:${it.insertText}`
    if (seen.has(k)) return false
    seen.add(k)
    return true
  })
  // 标记危险（整行）
  if (danger) {
    for (const it of unique) {
      if (it.kind === 'history' || it.kind === 'snippet') {
        it.dangerous = detectDangerous(it.insertText) !== null || it.dangerous
      }
    }
  }
  return { items: unique.slice(0, 50) }
}

// —— SFTP（Spec SSH-G P0）——

export async function getSftp(session: SshSession): Promise<SFTPWrapper> {
  assertSessionCurrent(session)
  if (session.sftp) return session.sftp
  if (session.sftpOpening) return session.sftpOpening
  const pending = ownedStep<SFTPWrapper>(session, (resolve, reject) => {
    session.client.sftp((err, sftp) => {
      if (err) return reject(err)
      if (!isSessionCurrent(session)) { sftp.end(); return reject(new Error('SSH session is closing')) }
      session.sftp = sftp
      resolve(sftp)
    })
  })
  session.sftpOpening = pending
  try { return await pending }
  finally { if (session.sftpOpening === pending) session.sftpOpening = undefined }
}

/**
 * 传输进度推送（Spec SSH-G）：data 事件累计字节，按时间（200ms）/字节（64KB）
 * 双阈值节流经 plugin:event 推 `ssh.transfer`；finish/error 推终态（不受节流约束）。
 */
const TRANSFER_THROTTLE_MS = 200
const TRANSFER_THROTTLE_BYTES = 64 * 1024

function createTransferProgress(
  pluginId: string,
  sessionId: string,
  direction: 'upload' | 'download',
  path: string,
  total: number
) {
  let transferred = 0
  let lastTs = 0
  let lastBytes = 0
  let finished = false
  const push = (done: boolean, error?: string): void => {
    if (finished && !done) return
    emitToPlugin(pluginId, {
      type: 'ssh.transfer',
      sessionId,
      direction,
      path,
      transferred,
      total,
      ...(done ? { done: true } : {}),
      ...(error !== undefined ? { error } : {})
    })
  }
  return {
    /** data 事件累计字节；超阈值（时间或字节任一）时推送中间进度 */
    add(bytes: number): void {
      if (bytes <= 0 || finished) return
      transferred += bytes
      const now = Date.now()
      if (
        now - lastTs >= TRANSFER_THROTTLE_MS ||
        transferred - lastBytes >= TRANSFER_THROTTLE_BYTES
      ) {
        lastTs = now
        lastBytes = transferred
        push(false)
      }
    },
    /** 终态：成功（done=true，transferred 为最终值） */
    finish(): void {
      if (finished) return
      finished = true
      push(true)
    },
    /** 终态：失败（done=true + error） */
    error(message: string): void {
      if (finished) return
      finished = true
      push(true, message)
    },
    /** 已累计字节数（终态后不再变化） */
    get transferred(): number {
      return transferred
    }
  }
}

export async function sshSftpList(
  pluginId: string,
  input: SftpListInput
): Promise<SftpEntry[]> {
  const s = requireSession(input.sessionId)
  if (s.pluginId !== pluginId) throw new Error('session does not belong to this plugin')
  const sftp = await getSftp(s)
  const path = input.path || '.'
  return new Promise((resolve, reject) => {
    sftp.readdir(path, (err, list) => {
      if (err) return reject(err)
      const entries: SftpEntry[] = (list ?? []).map((item) => {
        const filename = item.filename
        const longname = item.longname ?? ''
        const isDir = longname.startsWith('d') || (item.attrs?.mode !== undefined && (item.attrs.mode & 0o40000) !== 0)
        const isFile = longname.startsWith('-') || (!isDir && longname.length > 0)
        return {
          name: filename,
          path: path.endsWith('/') ? `${path}${filename}` : `${path}/${filename}`,
          size: item.attrs?.size ?? 0,
          mtime: (item.attrs?.mtime ?? 0) * 1000,
          type: isDir ? 'dir' : isFile ? 'file' : 'other',
          mode: item.attrs?.mode
        }
      })
      entries.sort((a, b) => {
        if (a.type === 'dir' && b.type !== 'dir') return -1
        if (a.type !== 'dir' && b.type === 'dir') return 1
        return a.name.localeCompare(b.name)
      })
      resolve(entries)
    })
  })
}

export async function sshSftpDownload(
  pluginId: string,
  input: SftpDownloadInput
): Promise<SftpTransferResult> {
  const s = requireSession(input.sessionId)
  if (s.pluginId !== pluginId) throw new Error('session does not belong to this plugin')
  const sftp = await getSftp(s)
  const remotePath = String(input.remotePath ?? '')
  if (!remotePath) throw new Error('remotePath required')
  if ('localPath' in input) throw new Error('raw local paths are not supported')
  const localPath = await resolveLocalDirectoryTarget(pluginId, input.localDirectoryHandleId, basename(remotePath))
  // 预取远端文件大小（进度 total；失败则 total=0 表示未知）
  const total = await ownedStep<number>(s, (resolve) => {
    sftp.stat(remotePath, (err, stats) => resolve(err ? 0 : stats.size))
  })
  assertSessionCurrent(s)
  const progress = createTransferProgress(pluginId, s.sessionId, 'download', remotePath, total)
  try {
    const readStream = sftp.createReadStream(remotePath)
    const writeStream = createWriteStream(localPath!)
    readStream.on('data', (chunk: string | Buffer) => {
      progress.add(
        typeof chunk === 'string' ? Buffer.byteLength(chunk) : chunk.length
      )
    })
    await pipeline(readStream, writeStream, { signal: s.controller.signal })
    progress.finish()
    return { ok: true, remotePath, localPath, bytes: progress.transferred }
  } catch (error) {
    progress.error((error as Error).message)
    return { ok: false, remotePath, localPath, error: (error as Error).message }
  }
}

export async function sshSftpUpload(
  pluginId: string,
  input: SftpUploadInput
): Promise<SftpTransferResult> {
  const s = requireSession(input.sessionId)
  if (s.pluginId !== pluginId) throw new Error('session does not belong to this plugin')
  const sftp = await getSftp(s)
  if ('localPath' in input) throw new Error('raw local paths are not supported')
  const localPath = await resolveLocalFileHandle(pluginId, input.localHandleId, 'read')
  const remotePath = String(input.remotePath ?? '')
  if (!localPath || !remotePath) throw new Error('localPath and remotePath required')
  if (!existsSync(localPath)) throw new Error(`local file not found: ${localPath}`)
  const total = statSync(localPath).size
  assertSessionCurrent(s)
  const progress = createTransferProgress(pluginId, s.sessionId, 'upload', remotePath, total)
  try {
    const readStream = createReadStream(localPath)
    const writeStream = sftp.createWriteStream(remotePath)
    readStream.on('data', (chunk: string | Buffer) => {
      progress.add(
        typeof chunk === 'string' ? Buffer.byteLength(chunk) : chunk.length
      )
    })
    await pipeline(readStream, writeStream, { signal: s.controller.signal })
    progress.finish()
    return { ok: true, localPath, remotePath, bytes: progress.transferred }
  } catch (error) {
    progress.error((error as Error).message)
    return { ok: false, localPath, remotePath, error: (error as Error).message }
  }
}

/** 会话归属校验 + 取 sftp 通道（mkdir/rename/delete/chmod 共用入口） */
async function requireSftpSession(
  pluginId: string,
  sessionId: string | undefined | null
): Promise<{ session: SshSession; sftp: SFTPWrapper }> {
  const s = requireSession(sessionId)
  if (s.pluginId !== pluginId) throw new Error('session does not belong to this plugin')
  const sftp = await getSftp(s)
  return { session: s, sftp }
}

/** sftp.stat 包装 */
function sftpStat(sftp: SFTPWrapper, path: string): Promise<{ isDir: boolean; size: number }> {
  return new Promise((resolve, reject) => {
    sftp.lstat(path, (err, stats) => {
      if (err) return reject(err)
      resolve({ isDir: stats.isDirectory(), size: stats.size })
    })
  })
}

/** sftp.readdir 包装：仅返回子项路径（供递归删除遍历） */
function sftpReaddirPaths(sftp: SFTPWrapper, dir: string): Promise<string[]> {
  return new Promise((resolve, reject) => {
    sftp.readdir(dir, (err, list) => {
      if (err) return reject(err)
      const prefix = dir.endsWith('/') ? dir : `${dir}/`
      resolve((list ?? []).map((item) => `${prefix}${item.filename}`))
    })
  })
}

export async function sshSftpMkdir(
  pluginId: string,
  sessionId: string,
  path: string
): Promise<boolean> {
  const dir = String(path ?? '')
  if (!dir) throw new Error('path required')
  const { sftp } = await requireSftpSession(pluginId, sessionId)
  return new Promise((resolve, reject) => {
    sftp.mkdir(dir, (err) => {
      if (err) return reject(new Error(`sftp mkdir failed: ${err.message}`))
      logInfo('ssh', `sftp mkdir ${dir}`)
      resolve(true)
    })
  })
}

export async function sshSftpRename(
  pluginId: string,
  sessionId: string,
  path: string,
  newPath: string
): Promise<boolean> {
  const from = String(path ?? '')
  const to = String(newPath ?? '')
  if (!from || !to) throw new Error('path and newPath required')
  const { sftp } = await requireSftpSession(pluginId, sessionId)
  return new Promise((resolve, reject) => {
    sftp.rename(from, to, (err) => {
      if (err) {
        // 目录 rename 在部分 SFTP 服务器上失败（不支持或目标存在）——stat 确认后给出明确错误
        sftp.stat(from, (statErr, stats) => {
          if (!statErr && stats.isDirectory()) {
            return reject(
              new Error(`sftp rename directory failed: ${err.message}`)
            )
          }
          return reject(new Error(`sftp rename failed: ${err.message}`))
        })
        return
      }
      logInfo('ssh', `sftp rename ${from} -> ${to}`)
      resolve(true)
    })
  })
}

export async function sshSftpDelete(
  pluginId: string,
  sessionId: string,
  path: string,
  recursive?: boolean
): Promise<boolean> {
  const target = String(path ?? '')
  if (!target) throw new Error('path required')
  const { sftp } = await requireSftpSession(pluginId, sessionId)
  const stats = await sftpStat(sftp, target)

  const unlinkOne = (p: string) =>
    new Promise<void>((resolve, reject) => {
      sftp.unlink(p, (err) => (err ? reject(err) : resolve()))
    })
  const rmdirOne = (p: string) =>
    new Promise<void>((resolve, reject) => {
      sftp.rmdir(p, (err) => (err ? reject(err) : resolve()))
    })

  if (!stats.isDir) {
    await unlinkOne(target)
    logInfo('ssh', `sftp delete file ${target}`)
    return true
  }
  if (!recursive) {
    // 非递归目录删除：先确认目录为空，再给出比裸 rmdir 报错更明确的提示
    const children = await sftpReaddirPaths(sftp, target)
    if (children.length > 0) {
      throw new Error(`directory not empty (use recursive): ${target}`)
    }
    await rmdirOne(target)
    logInfo('ssh', `sftp delete dir ${target}`)
    return true
  }
  // 递归删除：先深度收集（子文件在前、父目录在后），再逐项删除
  const files: string[] = []
  const dirs: string[] = [target]
  const walk = async (dir: string): Promise<void> => {
    const children = await sftpReaddirPaths(sftp, dir)
    for (const child of children) {
      const st = await sftpStat(sftp, child)
      if (st.isDir) {
        dirs.push(child)
        await walk(child)
      } else {
        files.push(child)
      }
    }
  }
  await walk(target)
  for (const f of files) await unlinkOne(f)
  // 目录从深到浅删除
  for (const d of dirs.sort((a, b) => b.length - a.length)) await rmdirOne(d)
  logInfo('ssh', `sftp delete recursive ${target} (${files.length + dirs.length} entries)`)
  return true
}

export async function sshSftpChmod(
  pluginId: string,
  sessionId: string,
  path: string,
  mode: number | string
): Promise<boolean> {
  const target = String(path ?? '')
  if (!target) throw new Error('path required')
  const { sftp } = await requireSftpSession(pluginId, sessionId)
  const numMode = parseSftpMode(mode)
  return new Promise((resolve, reject) => {
    sftp.chmod(target, numMode, (err) => {
      if (err) return reject(new Error(`sftp chmod failed: ${err.message}`))
      logInfo('ssh', `sftp chmod ${target} ${mode}`)
      resolve(true)
    })
  })
}

/** mode 归一：number 直取；'0644'/'644' 等字符串按八进制/十进制解析 */
function parseSftpMode(mode: number | string): number {
  if (typeof mode === 'number') {
    if (!Number.isInteger(mode) || mode < 0 || mode > 0o7777) throw new Error('invalid mode')
    return mode
  }
  const str = String(mode ?? '').trim()
  if (!str) throw new Error('mode required')
  if (!/^[0-7]{3,4}$/.test(str)) throw new Error('权限必须为三或四位八进制数字')
  const value = parseInt(str, 8)
  if (!Number.isFinite(value) || value < 0 || value > 0o7777) {
    throw new Error(`invalid mode: ${mode}`)
  }
  return value
}

/** SSH convenience picker returns a runtime-scoped capability, never a raw path. */
export async function sshPickLocalFile(pluginId: string, options?: LocalFilePickOptions): Promise<LocalFileHandle | null> {
  return (await pickLocalFiles(pluginId, options))[0] ?? null
}

/** 插件关闭时清理其全部 SSH 会话（PluginHost 交接用） */
export function releaseSshSessions(pluginId: string, generation?: number): void {
  for (const s of [...sessions.values()]) if (s.pluginId === pluginId && (generation === undefined || s.scope.owner.generation === generation)) sshDisconnect(pluginId, s.sessionId)
}

/** Owned context for internal SSH adapters only; never exposed through the bridge. */
export function requireOwnedSshSession(pluginId: string, sessionId: string): SshSession {
  const session = requireSession(sessionId)
  if (session.pluginId !== pluginId) throw new Error('session does not belong to this plugin')
  return session
}
