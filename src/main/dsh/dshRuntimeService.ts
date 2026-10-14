import { allowPluginEndpoint } from '@main/plugin/pluginSessionPolicy'
/**
 * dshRuntimeService — DSH 子进程管理：web 完全体进程 + sdk JSON-RPC 进程。
 * - spawn 经 ELECTRON_RUN_AS_NODE 复用 eNest Electron 引擎跑捆绑 runtime 的 lib/bin.js
 *   （系统 dsh 兜底时直接执行）；DSH_HOME 隔离到 {dataRoot}/dsh-home。
 * - web 进程：stdout 捕获带 token 的就绪 URL；EADDRINUSE / 未就绪退出 → 自动换端口
 *   重启（≤3 次）并经 dsh:event 通知插件刷新 iframe；就绪后崩溃 → 同样换口自动拉起。
 * - sdk 进程：stdio 换行 JSON-RPC 桥；自动 initialize；通知（session.event/status、
 *   subagent.*）转发插件。调用在 initialize 完成前串行排队。
 * - 生命周期绑 PluginRuntimeScope：release() 由 PluginHost disposer 调用，
 *   SIGTERM → 250ms SIGKILL 兜底（mw attemptKill 模式），端口随进程释放。
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { createServer, type AddressInfo } from 'node:net'
import { pluginHost } from '@main/plugin/PluginHost'
import { getRuntimeScope } from '@main/plugin/PluginRuntimeScope'
import { logWarn } from '@main/logs/logService'
import {
  dshDataDirs,
  resolveRuntime,
  resolvedRuntimeInfo,
  type ResolvedRuntime
} from '@main/dsh/dshRuntimeStore'
import type {
  DshRuntimeInfo,
  DshRuntimeStatus,
  DshSdkProcessStatus,
  DshSdkStartInput,
  DshWebProcessStatus,
  DshWorkbenchEvent
} from '@shared/types/dsh-workbench'

/** 端口冲突/崩溃自动换口重启上限 */
const MAX_PORT_RETRIES = 3
/** 崩溃重启退避 */
const RESTART_BACKOFF_MS = 800
/** SIGTERM 后 SIGKILL 兜底时限 */
const KILL_DEADLINE_MS = 250
/** 日志环形缓冲行数（logs.tail 上限） */
const LOG_RING_LINES = 256

interface RingBuffer {
  push(line: string): void
  tail(lines: number): string[]
}

function makeRing(capacity: number): RingBuffer {
  const lines: string[] = []
  return {
    push(line) {
      lines.push(line)
      if (lines.length > capacity) lines.splice(0, lines.length - capacity)
    },
    tail(n) {
      return lines.slice(Math.max(0, lines.length - n))
    }
  }
}

interface WebState {
  revokeEndpoint?: () => void
  child: ChildProcess
  pid?: number
  profile: string
  port: number
  readyUrl?: string
  readyAt?: number
  startedAt: number
  portRetries: number
  lastError?: string
  stopping: boolean
  sawAddrInUse: boolean
  stdout: RingBuffer
  stderr: RingBuffer
}

interface SdkPending {
  resolve: (value: unknown) => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout>
}

interface SdkState {
  child: ChildProcess
  pid?: number
  initialized: boolean
  serverInfo?: { name: string; version: string }
  initError?: string
  lastError?: string
  stopping: boolean
  nextId: number
  buffer: string
  pending: Map<number, SdkPending>
  initPromise: Promise<void>
  stdout: RingBuffer
  stderr: RingBuffer
}

const webStates = new Map<string, WebState>()
const sdkStates = new Map<string, SdkState>()

/** 换口重启计时器（阻止 release 后的重启） */
const restartTimers = new Map<string, ReturnType<typeof setTimeout>>()

function emit(pluginId: string, event: DshWorkbenchEvent): void {
  pluginHost.sendEvent(pluginId, { type: 'dsh.event', event })
}

function requireScope(pluginId: string): void {
  const scope = getRuntimeScope(pluginId)
  if (!scope || !scope.isCurrent() || scope.signal.aborted) throw new Error('plugin runtime is closing')
}

/** 子进程环境：DSH_HOME 隔离 + RunAsNode + 代理透传（proxyService 维护进程级 env） */
function childEnv(dshHome: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    ELECTRON_RUN_AS_NODE: '1',
    DSH_HOME: dshHome,
    NODE_USE_ENV_PROXY: '1'
  }
}

/** 组装 dsh 命令（RunAsNode 或系统可执行） */
function dshCommand(resolved: ResolvedRuntime): { command: string; args: string[] } | null {
  if (!resolved.bin) return null
  if (resolved.engine === 'node') return { command: resolved.bin, args: [] }
  return { command: process.execPath, args: [resolved.bin] }
}

/** 预探测一个随机空闲端口（listen(0) 后立即释放；竞态由 EADDRINUSE 重试兜底） */
function allocatePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.unref()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo
      server.close(() => resolve(port))
    })
  })
}

function killChild(child: ChildProcess, pid: number | undefined, label: string): void {
  let timer: ReturnType<typeof setTimeout> | undefined
  const onExit = () => {
    if (timer) clearTimeout(timer)
    child.removeListener('exit', onExit)
  }
  child.once('exit', onExit)
  try {
    child.kill('SIGTERM')
  } catch (error) {
    logWarn('dsh', `${label} kill failed: ${String(error)}`)
  }
  timer = setTimeout(() => {
    if (child.exitCode !== null || child.signalCode !== null) return
    if (!pid || !Number.isInteger(pid) || pid <= 0) return
    try {
      process.kill(pid, 'SIGKILL')
    } catch {
      /* 已退出 */
    }
  }, KILL_DEADLINE_MS)
}

// —— detect ——

let detectCache: { key: string; at: number; version: string | null } | null = null

function runVersion(resolved: ResolvedRuntime): Promise<string | null> {
  const cmd = dshCommand(resolved)
  if (!cmd) return Promise.resolve(null)
  return new Promise(resolve => {
    const child = spawn(cmd.command, [...cmd.args, '--version'], {
      env: childEnv(dshDataDirs().dshHome),
      stdio: ['ignore', 'pipe', 'pipe']
    })
    let out = ''
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      resolve(null)
    }, 15000)
    child.stdout?.on('data', chunk => { out += String(chunk) })
    child.once('error', () => { clearTimeout(timer); resolve(null) })
    child.once('close', code => {
      clearTimeout(timer)
      resolve(code === 0 ? out.trim().split('\n').pop() ?? null : null)
    })
  })
}

export async function detectRuntime(): Promise<DshRuntimeInfo> {
  const resolved = resolveRuntime()
  if (!resolved.bin) return resolvedRuntimeInfo('dsh runtime 未找到（插件捆绑/热更新/系统 PATH 均无）')
  const key = `${resolved.source}:${resolved.bin}`
  const cached = detectCache && detectCache.key === key && Date.now() - detectCache.at < 60_000 ? detectCache : null
  const version = resolved.version
    ?? (cached ? cached.version : await runVersion(resolved))
  detectCache = { key, at: Date.now(), version }
  return { ...resolvedRuntimeInfo(), version: version ?? undefined }
}

// —— web 进程 ——

const READY_URL_RE = /(https?:\/\/(?:127\.0\.0\.1|localhost):\d+\/?\?token=\S+)/

function webStatus(pluginId: string): DshWebProcessStatus {
  const state = webStates.get(pluginId)
  if (!state) {
    return { running: false, profile: 'web', portRetries: 0 }
  }
  return {
    running: true,
    pid: state.pid,
    port: state.port,
    readyUrl: state.readyUrl,
    profile: state.profile,
    startedAt: state.startedAt,
    portRetries: state.portRetries,
    lastError: state.lastError
  }
}

function stopWebInternal(pluginId: string, reason: string): void {
  const state = webStates.get(pluginId)
  const timer = restartTimers.get(pluginId)
  if (timer) {
    clearTimeout(timer)
    restartTimers.delete(pluginId)
  }
  if (!state) return
  state.stopping = true
  state.revokeEndpoint?.()
  state.lastError = state.lastError ?? reason
  webStates.delete(pluginId)
  if (state.child.exitCode === null && state.child.signalCode === null) {
    killChild(state.child, state.pid, `dsh web(${pluginId})`)
  }
}

export async function startWeb(
  pluginId: string,
  input: { profile?: string; port?: number }
): Promise<{ pid?: number; port: number }> {
  requireScope(pluginId)
  const profile = /^[a-z0-9][a-z0-9._-]*$/i.test(String(input.profile ?? '')) ? String(input.profile) : 'web'
  if (profile === 'desktop') throw new Error('profile "desktop" 为 Electron 保留名，不可启动')
  const existing = webStates.get(pluginId)
  if (existing && existing.profile === profile) {
    return { pid: existing.pid, port: existing.port }
  }
  if (existing) stopWebInternal(pluginId, '切换 profile 重启')
  const port = Number.isInteger(input.port) && Number(input.port) > 0 ? Number(input.port) : await allocatePort()
  await spawnWeb(pluginId, profile, port, 0)
  const state = webStates.get(pluginId)
  return { pid: state?.pid, port }
}

function spawnWeb(pluginId: string, profile: string, port: number, retries: number): Promise<void> {
  const resolved = resolveRuntime()
  const cmd = dshCommand(resolved)
  if (!cmd) return Promise.reject(new Error('dsh runtime 不可用：请先在设置台安装或激活运行时'))
  const { dshHome } = dshDataDirs()
  const args = [...cmd.args]
  if (profile !== 'web') args.push('--profile', profile)
  args.push('web', '--no-open', '--port', String(port))
  const child = spawn(cmd.command, args, {
    env: childEnv(dshHome),
    cwd: dshHome,
    stdio: ['ignore', 'pipe', 'pipe']
  })
  const state: WebState = {
    child,
    pid: child.pid,
    profile,
    port,
    startedAt: Date.now(),
    portRetries: retries,
    stopping: false,
    sawAddrInUse: false,
    stdout: makeRing(LOG_RING_LINES),
    stderr: makeRing(LOG_RING_LINES)
  }
  webStates.set(pluginId, state)
  child.once('error', error => {
    state.lastError = String(error)
    if (webStates.get(pluginId) === state) webStates.delete(pluginId)
  })
  child.stdout?.on('data', chunk => {
    for (const line of String(chunk).split('\n')) {
      if (!line.trim()) continue
      state.stdout.push(line)
      const match = READY_URL_RE.exec(line)
      if (match && !state.readyUrl) {
        const scope = getRuntimeScope(pluginId)
        if (!scope?.isCurrent() || scope.signal.aborted) return
        let endpoint: URL
        try { endpoint = new URL(match[1]) } catch { return }
        if (!['127.0.0.1', 'localhost', '[::1]'].includes(endpoint.hostname) || Number(endpoint.port) !== state.port) { state.lastError = 'unexpected DSH endpoint'; return }
        state.revokeEndpoint = allowPluginEndpoint(pluginId, endpoint.href, 'subFrame')
        scope.addDisposer(state.revokeEndpoint)
        state.readyUrl = match[1]
        state.readyAt = Date.now()
        state.portRetries = 0
        emit(pluginId, { type: 'web-ready', port: state.port, readyUrl: state.readyUrl })
      }
    }
  })
  child.stderr?.on('data', chunk => {
    const text = String(chunk)
    if (/EADDRINUSE/i.test(text)) state.sawAddrInUse = true
    for (const line of text.split('\n')) {
      if (line.trim()) state.stderr.push(line)
    }
    emit(pluginId, { type: 'web-stderr', tail: text.slice(-2000) })
  })
  child.once('close', (code) => {
    state.revokeEndpoint?.()
    if (webStates.get(pluginId) !== state) return
    webStates.delete(pluginId)
    if (state.stopping) {
      emit(pluginId, { type: 'web-exit', code, lastError: state.lastError })
      return
    }
    // 未就绪退出或 EADDRINUSE：端口冲突嫌疑 → 换口自动重启
    const addressConflict = state.sawAddrInUse || !state.readyUrl
    if (retries < MAX_PORT_RETRIES) {
      state.lastError = addressConflict
        ? `端口 ${state.port} 被占用或启动失败，自动换口重试（第 ${retries + 1}/${MAX_PORT_RETRIES} 次）`
        : `进程意外退出（code=${code}），自动拉起`
      emit(pluginId, { type: 'web-exit', code, lastError: state.lastError })
      const timer = setTimeout(() => {
        restartTimers.delete(pluginId)
        const scope = getRuntimeScope(pluginId)
        if (!scope || !scope.isCurrent() || scope.signal.aborted) return
        allocatePort().then(newPort => spawnWeb(pluginId, profile, newPort, retries + 1)).catch(error => {
          logWarn('dsh', `web 换口重启失败: ${String(error)}`)
        })
      }, RESTART_BACKOFF_MS)
      restartTimers.set(pluginId, timer)
    } else {
      state.lastError = state.lastError ?? `多次启动失败（code=${code}）`
      emit(pluginId, { type: 'web-exit', code, lastError: state.lastError })
    }
  })
  return Promise.resolve()
}

export function stopWeb(pluginId: string): boolean {
  const existed = webStates.has(pluginId)
  stopWebInternal(pluginId, '手动停止')
  return existed
}

// —— sdk 进程（stdio JSON-RPC 桥）——

function sdkStatus(pluginId: string): DshSdkProcessStatus {
  const state = sdkStates.get(pluginId)
  if (!state) return { running: false, initialized: false }
  return {
    running: true,
    pid: state.pid,
    initialized: state.initialized,
    serverInfo: state.serverInfo,
    lastError: state.initError ?? state.lastError
  }
}

function sendJsonRpc(state: SdkState, id: number, method: string, params: unknown): void {
  state.child.stdin?.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
}

export async function startSdk(pluginId: string, input: DshSdkStartInput): Promise<{ pid?: number }> {
  requireScope(pluginId)
  const existing = sdkStates.get(pluginId)
  if (existing) return { pid: existing.pid }
  const resolved = resolveRuntime()
  const cmd = dshCommand(resolved)
  if (!cmd) throw new Error('dsh runtime 不可用：请先在设置台安装或激活运行时')
  const { dshHome } = dshDataDirs()
  const cwd = typeof input.cwd === 'string' && input.cwd.trim() ? input.cwd : dshHome
  const child = spawn(cmd.command, [...cmd.args, '--profile', 'sdk'], {
    env: childEnv(dshHome),
    cwd,
    stdio: ['pipe', 'pipe', 'pipe']
  })
  const state: SdkState = {
    child,
    pid: child.pid,
    initialized: false,
    stopping: false,
    nextId: 1,
    buffer: '',
    pending: new Map(),
    stdout: makeRing(LOG_RING_LINES),
    stderr: makeRing(LOG_RING_LINES),
    initPromise: Promise.resolve()
  }
  sdkStates.set(pluginId, state)
  state.initPromise = new Promise<void>(resolve => {
    const id = state.nextId++
    const timer = setTimeout(() => {
      state.initError = 'initialize 握手超时（60s）'
      resolve()
    }, 60_000)
    state.pending.set(id, {
      timer,
      resolve: value => {
        state.initialized = true
        state.serverInfo = (value as { serverInfo?: { name: string; version: string } })?.serverInfo
        resolve()
      },
      reject: error => {
        state.initError = error.message
        resolve()
      }
    })
    child.once('spawn', () => {
      sendJsonRpc(state, id, 'initialize', {
        cwd,
        provider: String(input.provider ?? 'deepseek-official'),
        model: String(input.model ?? 'deepseek-chat'),
        ...(input.reasoningEffort ? { reasoningEffort: String(input.reasoningEffort) } : {}),
        ...(Number.isInteger(input.maxTokens) && Number(input.maxTokens) > 0 ? { maxTokens: Number(input.maxTokens) } : {})
      })
    })
  })
  child.once('error', error => {
    state.lastError = String(error)
    for (const pending of state.pending.values()) {
      clearTimeout(pending.timer)
      pending.reject(new Error(String(error)))
    }
    state.pending.clear()
    if (sdkStates.get(pluginId) === state) sdkStates.delete(pluginId)
  })
  child.stdout?.on('data', chunk => {
    state.buffer += String(chunk)
    let index: number
    while ((index = state.buffer.indexOf('\n')) >= 0) {
      const line = state.buffer.slice(0, index).trim()
      state.buffer = state.buffer.slice(index + 1)
      if (!line) continue
      state.stdout.push(line)
      let frame: { id?: number; method?: string; params?: unknown; result?: unknown; error?: { message?: string } }
      try {
        frame = JSON.parse(line)
      } catch {
        continue
      }
      if (typeof frame.method === 'string' && frame.id === undefined) {
        // server→client 通知：session.event / session.status / subagent.*
        emit(pluginId, { type: 'sdk-notify', method: frame.method, params: (frame.params ?? {}) as Record<string, unknown> })
        continue
      }
      const pending = state.pending.get(Number(frame.id))
      if (!pending) continue
      state.pending.delete(Number(frame.id))
      clearTimeout(pending.timer)
      if (frame.error) pending.reject(new Error(frame.error.message ?? 'dsh sdk rpc error'))
      else pending.resolve(frame.result)
    }
  })
  child.stderr?.on('data', chunk => {
    for (const line of String(chunk).split('\n')) {
      if (line.trim()) state.stderr.push(line)
    }
  })
  child.once('close', code => {
    if (sdkStates.get(pluginId) !== state) return
    sdkStates.delete(pluginId)
    const reason = `dsh sdk 进程退出（code=${code}）`
    for (const pending of state.pending.values()) {
      clearTimeout(pending.timer)
      pending.reject(new Error(reason))
    }
    state.pending.clear()
    emit(pluginId, { type: 'sdk-exit', code, lastError: state.lastError })
  })
  return { pid: child.pid }
}

export function stopSdk(pluginId: string): boolean {
  const state = sdkStates.get(pluginId)
  if (!state) return false
  state.stopping = true
  sdkStates.delete(pluginId)
  const reason = 'sdk 进程已停止'
  for (const pending of state.pending.values()) {
    clearTimeout(pending.timer)
    pending.reject(new Error(reason))
  }
  state.pending.clear()
  if (state.child.exitCode === null && state.child.signalCode === null) {
    killChild(state.child, state.pid, `dsh sdk(${pluginId})`)
  }
  return true
}

/** JSON-RPC 调用（等待 initialize 完成后串行发送） */
export async function sdkRpc(pluginId: string, method: string, params: Record<string, unknown>): Promise<unknown> {
  const state = sdkStates.get(pluginId)
  if (!state) throw new Error('dsh sdk 未启动')
  await state.initPromise
  if (method !== 'shutdown' && !state.initialized) {
    throw new Error(state.initError ?? 'dsh sdk 未完成 initialize 握手')
  }
  return new Promise((resolve, reject) => {
    const id = state.nextId++
    const timer = setTimeout(() => {
      state.pending.delete(id)
      reject(new Error(`dsh sdk rpc 超时: ${method}`))
    }, 120_000)
    state.pending.set(id, { timer, resolve, reject })
    sendJsonRpc(state, id, method, params)
  })
}

// —— 状态 / 日志 / 回收 ——

export function runtimeStatus(): DshRuntimeStatus {
  const sdk = [...sdkStates.keys()]
  const webPluginIds = [...webStates.keys()]
  // 单插件域：状态按任一持有插件的视角聚合（com.enest.dsh 是唯一声明者）
  const pluginId = webPluginIds[0] ?? sdk[0] ?? ''
  return {
    runtime: resolvedRuntimeInfo(),
    web: webStatus(pluginId),
    sdk: sdkStatus(pluginId)
  }
}

export function logsTail(kind: 'web' | 'sdk', lines: number): string[] {
  const limit = Math.max(1, Math.min(200, Math.floor(lines) || 50))
  const collect = (states: Map<string, { stdout: RingBuffer; stderr: RingBuffer }>): string[] => {
    for (const state of states.values()) {
      return [...state.stdout.tail(limit), ...state.stderr.tail(limit)]
    }
    return []
  }
  return kind === 'web' ? collect(webStates) : collect(sdkStates)
}

/** PluginHost scope disposer 入口：停止该插件名下全部 dsh 子进程（端口随之释放） */
export function releaseDshRuntime(pluginId: string): void {
  stopWebInternal(pluginId, '插件关闭回收')
  const state = sdkStates.get(pluginId)
  if (state) {
    const id = state.nextId++
    // 优雅关闭：先 shutdown 请求，200ms 后强杀兜底
    try {
      sendJsonRpc(state, id, 'shutdown', undefined)
    } catch {
      /* stdin 已关 */
    }
    setTimeout(() => stopSdk(pluginId), 200)
  }
}
