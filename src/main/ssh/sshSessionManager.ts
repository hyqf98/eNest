/**
 * sshSessionManager — SSH 会话 / exec / metrics / sftp / completion 宿主服务
 * 职责：以 ssh2 建立 shell/exec 通道；入参 secretRef 经 vault 解密；
 *      经 sendPluginEvent 推送 ssh.data / ssh.exit / ssh.error / ssh.metrics；
 *      提供 SFTP 最小集与静态词典 + 远程路径补全。
 * 被 pluginHandlers 分发调用（method 以 ssh.* 开头）。
 * 关键依赖：ssh2、@main/vault/secretVault、@main/ssh/commandDict、PluginHost 事件通道。
 */
import { createWriteStream, createReadStream, existsSync, readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'
import { Client, type ClientChannel, type ConnectConfig, type SFTPWrapper } from 'ssh2'
import { dialog } from 'electron'
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
import { getMainWindow } from '@main/window/createShellWindow'
import { IpcChannels } from '@shared/types/ipc'
import { pluginHost } from '@main/plugin/PluginHost'
import { logInfo, logWarn } from '@main/logs/logService'

interface SshSession {
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

/** 向插件 webContents 推送事件；找不到视图时静默丢弃 */
function emitToPlugin(pluginId: string, payload: PluginEventPayload): void {
  if (!pluginHost.isOpened(pluginId)) return
  const internal = pluginHost as unknown as {
    entries?: Map<string, { view?: { webContents?: Electron.WebContents } }>
  }
  const wc = internal.entries?.get(pluginId)?.view?.webContents
  if (!wc || wc.isDestroyed()) return
  try {
    wc.send(IpcChannels.PluginEvent, payload)
  } catch {
    // webContents 可能正在销毁
  }
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

function buildConnectConfig(input: SshConnectInput & { password?: string }, pluginId: string): ConnectConfig {
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
  const authType = input.authType ?? (input.privateKeyPath ? 'key' : 'password')
  if (authType === 'agent') {
    cfg.agent = process.env.SSH_AUTH_SOCK
    if (!cfg.agent) throw new Error('SSH_AUTH_SOCK not set; ssh-agent unavailable')
    return cfg
  }
  if (authType === 'key') {
    if (!input.privateKeyPath) throw new Error('privateKeyPath required for key auth')
    if (!existsSync(input.privateKeyPath)) {
      throw new Error(`private key not found: ${input.privateKeyPath}`)
    }
    cfg.privateKey = readFileSync(input.privateKeyPath)
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
    return createHash('sha256').update(key).digest('base64')
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
  const cfg = buildConnectConfig(input, pluginId)
  // jump（P0 单级）：先连跳板，再 direct-tcpip 到目标
  let jumpClient: Client | null = null
  if (input.jump?.host) {
    jumpClient = new Client()
    const jumpCfg = buildConnectConfig(
      {
        host: input.jump.host,
        port: input.jump.port ?? 22,
        username: input.jump.username,
        authType: input.jump.authType ?? 'password',
        privateKeyPath: input.jump.privateKeyPath,
        secretRef: input.jump.secretRef,
        ephemeralSecret: input.jump.ephemeralSecret
      },
      pluginId
    )
    await new Promise<void>((resolve, reject) => {
      jumpClient!
        .on('ready', () => resolve())
        .on('error', (err: Error) => reject(err))
        .connect(jumpCfg)
    })
    cfg.sock = await new Promise((resolve, reject) => {
      jumpClient!.forwardOut('127.0.0.1', 0, input.host, port, (err, stream) => {
        if (err) reject(err)
        else resolve(stream as never)
      })
    })
  }

  const client = new Client()
  const session: SshSession = {
    sessionId,
    pluginId,
    profileId: input.profileId,
    host: input.host,
    port,
    username: input.username,
    status: 'connecting',
    cols: input.cols && input.cols > 0 ? input.cols : 80,
    rows: input.rows && input.rows > 0 ? input.rows : 24,
    client,
    metricsIntervalMs: 5000,
    pathCache: new Map()
  }
  sessions.set(sessionId, session)

  await new Promise<void>((resolve, reject) => {
    client
      .on('ready', () => {
        session.status = 'connected'
        session.connectedAt = Date.now()
        client.on('banner', () => {})
        resolve()
      })
      .on('error', (err: Error) => {
        session.status = 'exited'
        emitToPlugin(pluginId, { type: 'ssh.error', sessionId, message: err.message })
        reject(err)
      })
      .on('close', () => {
        if (session.status !== 'exited') session.status = 'disconnected'
      })
    // host key 指纹：ssh2 通过 hostVerifier 暴露
    const cfgWithVerifier = cfg as ConnectConfig & { hostVerifier?: unknown }
    cfgWithVerifier.hostVerifier = (hashedKey: Buffer) => {
      session.fingerprint = fingerprintOf(hashedKey)
      // P0 tofu：默认接受；strict 策略后续可对接 known_hosts
      return true
    }
    client.on('banner', (message: string) => {
      session.serverIdent = message?.slice(0, 200)
    })
    try {
      client.connect(cfg)
    } catch (err) {
      reject(err as Error)
    }
  })

  // 打开 shell 通道（xterm 数据通道）
  await new Promise<void>((resolve, reject) => {
    client.shell(
      { term: input.term || 'xterm-256color', cols: session.cols, rows: session.rows },
      (err, channel) => {
        if (err) return reject(err)
        session.shell = channel
        channel.on('data', (data: Buffer) => {
          emitToPlugin(pluginId, {
            type: 'ssh.data',
            sessionId,
            data: data.toString('utf-8')
          })
        })
        channel.on('close', (code?: number | null, signal?: string) => {
          session.status = 'exited'
          stopMetrics(sessionId)
          emitToPlugin(pluginId, {
            type: 'ssh.exit',
            sessionId,
            code: code ?? null,
            signal
          })
        })
        resolve()
      }
    )
  }).catch((err) => {
    client.end()
    if (jumpClient) jumpClient.end()
    sessions.delete(sessionId)
    throw err
  })

  // 保存 jump 客户端以便 disconnect 时关闭
  ;(session as SshSession & { jumpClient?: Client }).jumpClient = jumpClient ?? undefined
  logInfo('ssh', `session opened ${sessionId} ${input.username}@${input.host}:${port}`)
  return toInfo(session)
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
  stopMetrics(sessionId)
  try {
    s.shell?.end()
  } catch {
    /* ignore */
  }
  try {
    s.sftp?.end()
  } catch {
    /* ignore */
  }
  try {
    s.client.end()
  } catch {
    /* ignore */
  }
  const jump = (s as SshSession & { jumpClient?: Client }).jumpClient
  if (jump) {
    try {
      jump.end()
    } catch {
      /* ignore */
    }
  }
  s.status = 'disconnected'
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
  const timeoutMs = input.timeoutMs && input.timeoutMs > 0 ? input.timeoutMs : 30_000
  const started = Date.now()
  return new Promise<SshExecResult>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`ssh exec timeout after ${timeoutMs}ms`))
    }, timeoutMs)
    s.client.exec(command, (err, channel) => {
      if (err) {
        clearTimeout(timer)
        return reject(err)
      }
      let stdout = ''
      let stderr = ''
      channel.on('data', (d: Buffer) => {
        stdout += d.toString('utf-8')
      })
      channel.stderr.on('data', (d: Buffer) => {
        stderr += d.toString('utf-8')
      })
      channel.on('close', (code: number | null) => {
        clearTimeout(timer)
        resolve({
          stdout,
          stderr,
          exitCode: code ?? null,
          durationMs: Date.now() - started
        })
      })
    })
  })
}

// —— Metrics（Spec SSH-F）——

/** Linux 采集脚本：cpu / mem / load / disk / net / uptime / top */
const METRICS_SCRIPT_LINUX = [
  "echo '---CPU---'",
  "grep 'cpu ' /proc/stat || true",
  "echo '---MEM---'",
  "free -b 2>/dev/null || true",
  "echo '---LOAD---'",
  "cat /proc/loadavg 2>/dev/null || true",
  "echo '---DISK---'",
  "df -P 2>/dev/null | tail -n +2 || true",
  "echo '---NET---'",
  "cat /proc/net/dev 2>/dev/null | tail -n +3 || true",
  "echo '---UPTIME---'",
  "cat /proc/uptime 2>/dev/null || true",
  "echo '---TOP---'",
  "ps -eo pid,pcpu,pmem,comm --sort=-pcpu 2>/dev/null | head -n 11 || true"
].join('\n')

/** macOS 降级采集 */
const METRICS_SCRIPT_MAC = [
  "echo '---CPU---'",
  "top -l 1 -n 0 2>/dev/null | grep 'CPU usage' || true",
  "echo '---MEM---'",
  "vm_stat 2>/dev/null | head -n 8 || true",
  "sysctl -n hw.memsize 2>/dev/null || true",
  "echo '---LOAD---'",
  "sysctl -n vm.loadavg 2>/dev/null || true",
  "echo '---DISK---'",
  "df -P 2>/dev/null | tail -n +2 || true",
  "echo '---UPTIME---'",
  "uptime 2>/dev/null || true",
  "echo '---TOP---'",
  "ps -Ao pid,pcpu,pmem,comm -r 2>/dev/null | head -n 11 || true"
].join('\n')

function parseMetricsLinux(raw: string): SshMetricsSample {
  const sample: SshMetricsSample = { ts: Date.now() }
  const sections = raw.split(/^---(\w+)---$/m)
  const get = (name: string): string => {
    for (let i = 1; i < sections.length; i += 2) {
      if (sections[i] === name) return sections[i + 1] ?? ''
    }
    return ''
  }
  // CPU：两次采样差分在宿主端做 best-effort——单次仅记 idle/total 供下次比对
  const cpuLine = get('CPU').trim().split('\n')[0] ?? ''
  const cpuParts = cpuLine.trim().split(/\s+/)
  if (cpuParts[0] === 'cpu') {
    const nums = cpuParts.slice(1).map((x) => Number(x) || 0)
    const idle = (nums[3] ?? 0) + (nums[4] ?? 0)
    const total = nums.reduce((a, b) => a + b, 0)
    const key = sample.ts
    const prev = cpuPrev
    cpuPrev = { idle, total, key }
    if (prev && total > prev.total) {
      const dTotal = total - prev.total
      const dIdle = idle - prev.idle
      sample.cpuPercent = dTotal > 0 ? Math.round(((dTotal - dIdle) / dTotal) * 1000) / 10 : undefined
    }
  }
  const mem = get('MEM').trim()
  const memTotal = /Mem:\s+(\d+)/.exec(mem)?.[1]
  const memAvail = /Mem:\s+\d+\s+\d+\s+(\d+)/.exec(mem)?.[1]
  if (memTotal && memAvail) {
    sample.memTotal = Number(memTotal)
    sample.memUsed = sample.memTotal - Number(memAvail)
    sample.memPercent =
      sample.memTotal > 0
        ? Math.round((sample.memUsed / sample.memTotal) * 1000) / 10
        : undefined
  }
  const load = get('LOAD').trim()
  const load1 = /^([0-9.]+)/.exec(load)?.[1]
  if (load1) sample.load1 = Number(load1)
  const disk = get('DISK').trim()
  if (disk) {
    sample.disks = disk
      .split('\n')
      .map((line) => {
        const cols = line.trim().split(/\s+/)
        if (cols.length < 6) return null
        const usedPercent = Number(String(cols[4] ?? '').replace('%', ''))
        return {
          mount: cols[5] ?? '',
          usedPercent: Number.isFinite(usedPercent) ? usedPercent : 0,
          used: Number(cols[2]) || undefined,
          total: Number(cols[1]) || undefined
        }
      })
      .filter((x): x is NonNullable<typeof x> => x !== null)
  }
  const net = get('NET').trim()
  if (net) {
    sample.net = net
      .split('\n')
      .map((line) => {
        const m = /^\s*(\S+):\s*(\d+)\s+\d+\s+\d+\s+\d+\s+\d+\s+\d+\s+\d+\s+\d+\s+(\d+)/.exec(line)
        if (!m) return null
        return { iface: m[1]!, rxKbps: Math.round(Number(m[2]) / 1024), txKbps: Math.round(Number(m[3]) / 1024) }
      })
      .filter((x): x is NonNullable<typeof x> => x !== null)
  }
  const uptime = get('UPTIME').trim().split(/\s+/)[0]
  if (uptime) sample.uptimeSec = Math.floor(Number(uptime))
  const top = get('TOP').trim()
  if (top) {
    sample.topProcesses = top
      .split('\n')
      .slice(1)
      .map((line) => {
        const cols = line.trim().split(/\s+/)
        return {
          pid: Number(cols[0]) || 0,
          cpuPercent: Number(cols[1]) || undefined,
          memPercent: Number(cols[2]) || undefined,
          command: cols.slice(3).join(' ')
        }
      })
      .filter((p) => p.pid > 0)
      .slice(0, 10)
  }
  return sample
}

let cpuPrev: { idle: number; total: number; key: number } | null = null

function parseMetricsMac(raw: string): SshMetricsSample {
  const sample: SshMetricsSample = { ts: Date.now() }
  const sections = raw.split(/^---(\w+)---$/m)
  const get = (name: string): string => {
    for (let i = 1; i < sections.length; i += 2) {
      if (sections[i] === name) return sections[i + 1] ?? ''
    }
    return ''
  }
  const cpu = get('CPU')
  const userM = /([\d.]+)%\s*user/.exec(cpu)
  const sysM = /([\d.]+)%\s*(sys|system)/.exec(cpu)
  if (userM && sysM) sample.cpuPercent = Math.round((Number(userM[1]) + Number(sysM[1])) * 10) / 10
  const memBlock = get('MEM')
  const pageSize = 4096
  const freePages = /Pages free:\s+(\d+)/.exec(memBlock)?.[1]
  const inactive = /Pages inactive:\s+(\d+)/.exec(memBlock)?.[1]
  const totalMem = /(\d+)\s*$/.exec(memBlock.trim())?.[1]
  if (totalMem && Number(totalMem) > 1_000_000) {
    sample.memTotal = Number(totalMem)
    const free = (Number(freePages ?? 0) + Number(inactive ?? 0)) * pageSize
    sample.memUsed = Math.max(0, sample.memTotal - free)
    sample.memPercent =
      sample.memTotal > 0 ? Math.round((sample.memUsed / sample.memTotal) * 1000) / 10 : undefined
  }
  const load = get('LOAD')
  const load1 = /\{?\s*([\d.]+)/.exec(load)?.[1]
  if (load1) sample.load1 = Number(load1)
  const disk = get('DISK').trim()
  if (disk) {
    sample.disks = disk
      .split('\n')
      .map((line) => {
        const cols = line.trim().split(/\s+/)
        if (cols.length < 6) return null
        const usedPercent = Number(String(cols[4] ?? '').replace('%', ''))
        return { mount: cols[5] ?? '', usedPercent: Number.isFinite(usedPercent) ? usedPercent : 0 }
      })
      .filter((x): x is NonNullable<typeof x> => x !== null)
  }
  const up = get('UPTIME')
  const upM = /up\s+(?:(\d+)\s+days?,\s+)?(?:(\d+):(\d+)|(\d+)\s+min)/.exec(up)
  if (upM) {
    const days = Number(upM[1] ?? 0)
    const hours = upM[2] ? Number(upM[2]) : 0
    const mins = upM[3] ? Number(upM[3]) : Number(upM[4] ?? 0)
    sample.uptimeSec = days * 86400 + hours * 3600 + mins * 60
  }
  const top = get('TOP').trim()
  if (top) {
    sample.topProcesses = top
      .split('\n')
      .slice(1)
      .map((line) => {
        const cols = line.trim().split(/\s+/)
        return {
          pid: Number(cols[0]) || 0,
          cpuPercent: Number(cols[1]) || undefined,
          memPercent: Number(cols[2]) || undefined,
          command: cols.slice(3).join(' ')
        }
      })
      .filter((p) => p.pid > 0)
      .slice(0, 10)
  }
  return sample
}

async function sampleOnce(session: SshSession): Promise<SshMetricsSample> {
  const script = process.platform === 'darwin' ? METRICS_SCRIPT_MAC : METRICS_SCRIPT_LINUX
  try {
    const result = await sshExec(session.pluginId, {
      sessionId: session.sessionId,
      command: script,
      timeoutMs: 8000
    })
    const raw = result.stdout || result.stderr
    const sample =
      process.platform === 'darwin' ? parseMetricsMac(raw) : parseMetricsLinux(raw)
    session.lastSample = sample
    return sample
  } catch (err) {
    const sample: SshMetricsSample = { ts: Date.now(), error: (err as Error).message }
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
  const tick = async () => {
    if (s.status !== 'connected') return
    const sample = await sampleOnce(s)
    emitToPlugin(pluginId, { type: 'ssh.metrics', sessionId, sample })
  }
  void tick()
  s.metricsTimer = setInterval(() => void tick(), ms)
  return { ok: true, intervalMs: ms }
}

export function sshMetricsStop(_pluginId: string, sessionId: string): boolean {
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
  const m = /(\S*)$/.exec(before)
  const word = m?.[1] ?? ''
  return { word, isPathLike: word.startsWith('/') || word.startsWith('./') || word.startsWith('~/') || word.includes('/'), start: pos - word.length }
}

async function remotePathComplete(
  session: SshSession,
  prefix: string
): Promise<string[]> {
  const cached = session.pathCache.get(prefix)
  const now = Date.now()
  if (cached && now - cached.ts < 3000) return cached.items
  // compgen -f 对相对/绝对路径前缀 best-effort
  const escaped = prefix.replace(/'/g, `'\\''`)
  const cmd = `compgen -f -- '${escaped}' 2>/dev/null | head -n 50 || ls -1d ${prefix}* 2>/dev/null | head -n 50`
  try {
    const result = await sshExec(session.pluginId, {
      sessionId: session.sessionId,
      command: cmd,
      timeoutMs: 3000
    })
    const items = result.stdout
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean)
    session.pathCache.set(prefix, { ts: now, items })
    return items
  } catch {
    return []
  }
}

export async function sshCompletionSuggest(
  pluginId: string,
  input: {
    sessionId: string
    line: string
    cursor?: number
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
  if (s && s.pluginId === pluginId && s.status === 'connected' && isPathLike && word) {
    const paths = await remotePathComplete(s, word)
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

async function getSftp(session: SshSession): Promise<SFTPWrapper> {
  if (session.sftp) return session.sftp
  return new Promise((resolve, reject) => {
    session.client.sftp((err, sftp) => {
      if (err) return reject(err)
      session.sftp = sftp
      resolve(sftp)
    })
  })
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
  let localPath = input.localPath
  if (!localPath) {
    localPath = join(homedir(), 'Downloads', basename(remotePath))
  }
  return new Promise((resolve) => {
    const readStream = sftp.createReadStream(remotePath)
    const writeStream = createWriteStream(localPath!)
    let bytes = 0
    readStream.on('data', (chunk: string | Buffer) => {
      bytes += typeof chunk === 'string' ? Buffer.byteLength(chunk) : chunk.length
    })
    readStream.on('error', (err: Error) => {
      resolve({ ok: false, remotePath, error: err.message })
    })
    writeStream.on('error', (err: Error) => {
      resolve({ ok: false, remotePath, localPath, error: err.message })
    })
    writeStream.on('close', () => {
      resolve({ ok: true, remotePath, localPath, bytes })
    })
    readStream.pipe(writeStream)
  })
}

export async function sshSftpUpload(
  pluginId: string,
  input: SftpUploadInput
): Promise<SftpTransferResult> {
  const s = requireSession(input.sessionId)
  if (s.pluginId !== pluginId) throw new Error('session does not belong to this plugin')
  const sftp = await getSftp(s)
  const localPath = String(input.localPath ?? '')
  const remotePath = String(input.remotePath ?? '')
  if (!localPath || !remotePath) throw new Error('localPath and remotePath required')
  if (!existsSync(localPath)) throw new Error(`local file not found: ${localPath}`)
  return new Promise((resolve) => {
    const readStream = createReadStream(localPath)
    const writeStream = sftp.createWriteStream(remotePath)
    let bytes = 0
    readStream.on('data', (chunk: string | Buffer) => {
      bytes += typeof chunk === 'string' ? Buffer.byteLength(chunk) : chunk.length
    })
    readStream.on('error', (err: Error) => {
      resolve({ ok: false, localPath, error: err.message })
    })
    writeStream.on('error', (err: Error) => {
      resolve({ ok: false, localPath, remotePath, error: err.message })
    })
    writeStream.on('close', () => {
      resolve({ ok: true, localPath, remotePath, bytes })
    })
    readStream.pipe(writeStream)
  })
}

/**
 * 宿主文件选择对话框（SSH 上传/导出选路径）。
 * 入参兼容插件侧 `{ mode: 'file' | 'dir' }` 与宿主侧 `properties` 双形态
 *（com.enest.ssh 资产/SFTP 用 mode）。
 */
export async function sshPickLocalFile(
  _pluginId: string,
  opts?: {
    properties?: Array<'openFile' | 'openDirectory' | 'multiSelections'>
    /** 插件兼容别名：file→openFile；dir|directory|folder→openDirectory */
    mode?: 'file' | 'dir' | 'directory' | 'folder'
  }
): Promise<string | null> {
  const win = getMainWindow()
  let properties = (opts?.properties?.length ? opts.properties : undefined) as
    | Array<'openFile' | 'openDirectory' | 'multiSelections'>
    | undefined
  if (!properties?.length) {
    const mode = opts?.mode
    if (mode === 'dir' || mode === 'directory' || mode === 'folder') {
      properties = ['openDirectory']
    } else {
      properties = ['openFile']
    }
  }
  const dialogOpts = { properties, title: '选择文件' }
  const result = win
    ? await dialog.showOpenDialog(win as never, dialogOpts)
    : await dialog.showOpenDialog(dialogOpts)
  if (result.canceled || result.filePaths.length === 0) return null
  return result.filePaths[0] ?? null
}

/** 插件关闭时清理其全部 SSH 会话（PluginHost 交接用） */
export function releaseSshSessions(pluginId: string): void {
  for (const s of [...sessions.values()]) {
    if (s.pluginId === pluginId) {
      try {
        stopMetrics(s.sessionId)
        s.shell?.end()
        s.client.end()
      } catch (err) {
        logWarn('ssh', `release session failed ${s.sessionId}: ${(err as Error).message}`)
      }
      sessions.delete(s.sessionId)
    }
  }
}
