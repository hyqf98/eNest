/** DSH children and pending launches belong to a runtime generation, never just a plugin id. */
import { spawn, type ChildProcess } from 'node:child_process'
import { AsyncLocalStorage } from 'node:async_hooks'
import { createServer, type AddressInfo } from 'node:net'
import { StringDecoder } from 'node:string_decoder'
import { allowPluginEndpoint } from '@main/plugin/pluginSessionPolicy'
import { pluginHost } from '@main/plugin/PluginHost'
import { getRuntimeScope, type PluginRuntimeScope } from '@main/plugin/PluginRuntimeScope'
import { registerPluginProcess } from '@main/plugin/pluginOwnedProcesses'
import { logWarn } from '@main/logs/logService'
import {
  DSH_PLUGIN_ID, dshDataDirs, ensureDshDirs, resolveRuntime, resolvedRuntimeInfo, type ResolvedRuntime
} from '@main/dsh/dshRuntimeStore'
import type {
  DshRuntimeInfo, DshRuntimeStatus, DshSdkProcessStatus, DshSdkStartInput,
  DshWebProcessStatus, DshWorkbenchEvent
} from '@shared/types/dsh-workbench'

const MAX_PORT_RETRIES = 3
const RESTART_BACKOFF_MS = 800
const KILL_DEADLINE_MS = 250
const EXIT_DEADLINE_MS = 1200
const READY_TIMEOUT_MS = 60_000
const LOG_RING_LINES = 256
export type DshWebLaunchInput = { profile?: string; port?: number }
export type DshSdkLaunchInput = DshSdkStartInput & { profile?: string }
export interface DshProcessSnapshot { web?: DshWebLaunchInput; sdk?: DshSdkLaunchInput }
interface RingBuffer { push(line: string): void; tail(lines: number): string[] }
function makeRing(capacity: number): RingBuffer {
  const lines: string[] = []
  return {
    push(line) { lines.push(line); if (lines.length > capacity) lines.splice(0, lines.length - capacity) },
    tail(n) { return lines.slice(Math.max(0, lines.length - n)) }
  }
}
interface RuntimeChild {
  pluginId: string
  scope?: PluginRuntimeScope
  child: ChildProcess
  exited: boolean
  exit: Promise<void>
  stop: () => void
}
interface PendingLaunch {
  pluginId: string
  scope: PluginRuntimeScope
  cancelled: boolean
  cancel: () => void
  done: Promise<unknown>
}
interface WebLaunch extends PendingLaunch {
  profile: string
  input: DshWebLaunchInput
  controller: AbortController
  start: Promise<{ pid?: number; port: number }>
  state?: WebState
  restartTimer?: ReturnType<typeof setTimeout>
  detach: () => void
}
interface WebState {
  secrets: string[]
  owned: RuntimeChild
  launch: WebLaunch
  revokeEndpoint?: () => void
  child: ChildProcess
  pid?: number
  profile: string
  port: number
  readyUrl?: string
  readyAt?: number
  readyTimer?: ReturnType<typeof setTimeout>
  startedAt: number
  portRetries: number
  lastError?: string
  stopping: boolean
  finished: boolean
  sawAddrInUse: boolean
  stdout: RingBuffer
  stderr: RingBuffer
}
interface SdkLaunch extends PendingLaunch {
  input: DshSdkLaunchInput
  start: Promise<{ pid?: number }>
  detach: () => void
}
interface SdkPending {
  resolve: (value: unknown) => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout>
}
interface SdkState {
  secrets: string[]
  owned: RuntimeChild
  launch: SdkLaunch
  input: DshSdkLaunchInput
  child: ChildProcess
  pid?: number
  initialized: boolean
  serverInfo?: { name: string; version: string }
  initError?: string
  lastError?: string
  stopping: boolean
  finished: boolean
  shutdownTimer?: ReturnType<typeof setTimeout>
  nextId: number
  buffer: string
  pending: Map<number, SdkPending>
  initPromise: Promise<void>
  stdout: RingBuffer
  stderr: RingBuffer
}
const webStates = new Map<string, WebState>()
const sdkStates = new Map<string, SdkState>()
const webLaunches = new Map<string, WebLaunch>()
const sdkLaunches = new Map<string, SdkLaunch>()
const pendingLaunches = new Set<PendingLaunch>()
const runtimeChildren = new Set<RuntimeChild>()
const webInputs = new Map<string, { scope: PluginRuntimeScope; input: DshWebLaunchInput }>()
const sdkInputs = new Map<string, { scope: PluginRuntimeScope; input: DshSdkLaunchInput }>()

interface MaintenanceToken { pluginId: string; scope?: PluginRuntimeScope; active: boolean }
interface MaintenanceQueue { pending: number; tail: Promise<void>; active?: MaintenanceToken }
const maintenance = new Map<string, MaintenanceQueue>()
const maintenanceContext = new AsyncLocalStorage<MaintenanceToken>()
function maintenanceAllowed(pluginId: string): boolean {
  const queue = maintenance.get(pluginId)
  if (!queue?.pending) return true
  const token = maintenanceContext.getStore()
  return !!token?.active && token.pluginId === pluginId && queue.active === token
}
function assertExclusiveDshOwner(pluginId: string): void {
  if ([...maintenance].some(([owner, queue]) => owner !== pluginId && queue.pending > 0)
    || [...runtimeChildren].some(child => child.pluginId !== pluginId && !child.exited)
    || [...pendingLaunches].some(launch => launch.pluginId !== pluginId && !launch.cancelled)
    || [...webLaunches].some(([owner, launch]) => owner !== pluginId && !launch.cancelled)
    || [...sdkLaunches].some(([owner, launch]) => owner !== pluginId && !launch.cancelled)) {
    throw new Error('DSH 共享数据目录正由其他插件实例使用，请先停止该实例')
  }
}
function assertMayStart(pluginId: string): void {
  assertExclusiveDshOwner(pluginId)
  if (!maintenanceAllowed(pluginId)) throw new Error('DSH 正在维护，请等待操作完成后重试')
}
/** Reserve immediately (including queued work). Only this callback may launch its own probes/restarts.
 * Nested operations for the same owner share the token, so upgrade -> restore cannot deadlock.
 */
export async function withDshMaintenance<T>(pluginId: string, operation: () => Promise<T>): Promise<T> {
  const inherited = maintenanceContext.getStore()
  const existing = maintenance.get(pluginId)
  if (inherited?.active && inherited.pluginId === pluginId && existing?.active === inherited) return operation()
  assertExclusiveDshOwner(pluginId)
  const scope = getRuntimeScope(pluginId)
  if (scope && (!scope.isCurrent() || scope.signal.aborted)) throw new Error('plugin runtime is closing')
  const queue: MaintenanceQueue = existing ?? { pending: 0, tail: Promise.resolve() }
  maintenance.set(pluginId, queue)
  queue.pending++
  const previous = queue.tail
  let release!: () => void
  queue.tail = new Promise<void>(resolve => { release = resolve })
  await previous
  const token: MaintenanceToken = { pluginId, scope, active: true }
  queue.active = token
  try {
    if (scope && (!scope.isCurrent() || scope.signal.aborted)) throw new Error('plugin runtime is closing')
    return await maintenanceContext.run(token, operation)
  } finally {
    token.active = false
    queue.active = undefined
    queue.pending--
    if (!queue.pending && maintenance.get(pluginId) === queue) maintenance.delete(pluginId)
    release()
  }
}
function emit(pluginId: string, event: DshWorkbenchEvent): void {
  pluginHost.sendEvent(pluginId, { type: 'dsh.event', event })
}
function requireScope(pluginId: string): PluginRuntimeScope {
  const scope = getRuntimeScope(pluginId)
  if (!scope || !scope.isCurrent() || scope.signal.aborted) throw new Error('plugin runtime is closing')
  return scope
}
function currentScope(scope: PluginRuntimeScope): boolean { return scope.isCurrent() && !scope.signal.aborted }
function safeProfile(value: unknown, fallback: string): string {
  const profile = value === undefined ? fallback : String(value)
  if (!/^[a-z0-9][a-z0-9._-]{0,63}$/i.test(profile)) throw new Error('非法 DSH profile 名')
  if (profile.toLowerCase() === 'desktop') throw new Error('profile "desktop" 为 Electron 保留名，不可启动')
  return profile
}
const PROFILE_ENV_KEYS = new Set([
  'DEEPSEEK_API_KEY', 'DEEPSEEK_BASE_URL', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY',
  'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'all_proxy', 'no_proxy',
  'DSH_TELEMETRY_DISABLED'
])
function secretValues(env: Record<string, string>): string[] {
  return [...new Set(Object.entries({ ...process.env, ...env }).filter(([key, value]) =>
    /(?:API_KEY|TOKEN|SECRET|PASSWORD)$/i.test(key) && typeof value === 'string' && value.length > 0
  ).map(([, value]) => value!))].sort((a, b) => b.length - a.length)
}
function redactLog(value: string, secrets: string[] = []): string {
  let text = value
  for (const secret of secrets) text = text.split(secret).join('[redacted]')
  return text.replace(/([?&]token=)[^\s&#]+/gi, '$1[redacted]')
    .replace(/((?:authorization["']?\s*[:=]\s*["']?|bearer\s+))[^\s,"'}]+(?:\s+[^\s,"'}]+)?/gi, '$1[redacted]')
    .replace(/((?:[a-z_]*(?:api[_-]?key|secret|password|token))["']?\s*[:=]\s*["']?)[^\s,"'}]+/gi, '$1[redacted]')
    .replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/gi, '$1[redacted]@')
}
function childEnv(dshHome: string, overlay: Record<string, string> = {}): NodeJS.ProcessEnv {
  const safe: Record<string, string> = {}
  for (const [key, value] of Object.entries(overlay)) if (PROFILE_ENV_KEYS.has(key) && typeof value === 'string') safe[key] = value
  return { ...process.env, ...safe, ELECTRON_RUN_AS_NODE: '1', DSH_HOME: dshHome, NODE_USE_ENV_PROXY: '1' }
}
async function profileEnvironment(profile: string, kind: 'web' | 'sdk'): Promise<Record<string, string>> {
  // The profile service uses maintenance for mutations; defer the import to avoid initialization cycles.
  const service = await import('@main/dsh/dshProfileService')
  await service.assertProfileCompatibility(profile, kind)
  return service.readProfileEnvironment(profile)
}
function dshCommand(resolved: ResolvedRuntime): { command: string; args: string[] } | null {
  if (!resolved.bin) return null
  return resolved.engine === 'node' ? { command: resolved.bin, args: [] } : { command: process.execPath, args: [resolved.bin] }
}
function allocatePort(signal: AbortSignal): Promise<number> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(new Error('DSH port allocation cancelled')); return }
    const server = createServer()
    server.unref()
    let settled = false
    const finish = (error?: Error, port?: number) => {
      if (settled) return
      settled = true
      signal.removeEventListener('abort', abort)
      if (error) reject(error)
      else resolve(port!)
    }
    const abort = () => { server.close(); finish(new Error('DSH port allocation cancelled')) }
    signal.addEventListener('abort', abort, { once: true })
    server.once('error', error => finish(error))
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo
      server.close(error => finish(error ?? undefined, port))
    })
  })
}

const childStops = new WeakMap<ChildProcess, { exited: boolean; timer?: ReturnType<typeof setTimeout> }>()
/** Signals only the original ChildProcess; no raw/discovered PID termination. */
function killChild(child: ChildProcess, label: string): void {
  if (child.exitCode !== null || child.signalCode !== null) return
  if (childStops.has(child)) return
  const state: { exited: boolean; timer?: ReturnType<typeof setTimeout> } = { exited: false }
  childStops.set(child, state)
  const finished = () => { state.exited = true; if (state.timer) clearTimeout(state.timer) }
  child.once('exit', finished)
  child.once('close', finished)
  const attempt = () => {
    if (state.exited || child.exitCode !== null || child.signalCode !== null) return
    try { child.kill('SIGTERM') } catch (error) { logWarn('dsh', `${label} kill failed: ${String(error)}`) }
    const pid = child.pid
    if (!pid || state.timer) return
    state.timer = setTimeout(() => {
      if (state.exited || child.pid !== pid || child.exitCode !== null || child.signalCode !== null) return
      try { child.kill('SIGKILL') } catch { /* actual exit owns cleanup */ }
    }, KILL_DEADLINE_MS)
    state.timer.unref()
  }
  child.once('spawn', attempt)
  attempt()
}
async function boundedWait<T>(work: Promise<T>, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([work, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(message)), EXIT_DEADLINE_MS)
    })])
  } finally { if (timer) clearTimeout(timer) }
}
async function waitForExit(owned: RuntimeChild): Promise<void> {
  if (!owned.exited) await boundedWait(owned.exit, 'DSH child exit not confirmed; maintenance aborted')
}
/** Install state synchronously before pending spawn/abort callbacks can run. */
function ownChild(pluginId: string, scope: PluginRuntimeScope | undefined, child: ChildProcess, stop: () => void): RuntimeChild {
  let resolveExit!: () => void
  const exit = new Promise<void>(resolve => { resolveExit = resolve })
  let stopping = false
  const owned: RuntimeChild = { pluginId, scope, child, exited: false, exit, stop: () => {
    if (!owned.exited) { stopping = true; stop() }
  } }
  runtimeChildren.add(owned)
  const shutdown = async () => { owned.stop(); await waitForExit(owned) }
  const unregister = registerPluginProcess({ pluginId, generation: scope?.owner.generation, kind: 'runtime',
    getPid: () => owned.exited ? undefined : child.pid, stop: shutdown })
  const abort = () => owned.stop()
  let detach = () => {}
  const finished = () => {
    if (owned.exited) return
    owned.exited = true
    unregister()
    runtimeChildren.delete(owned)
    scope?.signal.removeEventListener('abort', abort)
    detach()
    resolveExit()
  }
  let spawned = false
  child.once('spawn', () => { spawned = true; if (stopping || scope && !currentScope(scope)) owned.stop() })
  child.once('exit', finished)
  child.once('close', finished)
  child.once('error', () => {
    if (!spawned && child.pid === undefined) finished()
    else owned.stop() // An error alone is not evidence that a live child exited.
  })
  scope?.signal.addEventListener('abort', abort, { once: true })
  detach = scope?.addDisposer(shutdown) ?? detach
  if (scope && !currentScope(scope)) queueMicrotask(abort)
  return owned
}
/** Shared ownership for one-shot DSH commands (tar, health probes and profile commands). */
export function ownDshChild(pluginId: string, child: ChildProcess): { readonly exited: boolean; stop(): void; waitForExit(): Promise<void> } {
  const scope = getRuntimeScope(pluginId)
  const owned = ownChild(pluginId, scope, child, () => killChild(child, 'dsh command'))
  if (!scope || !currentScope(scope) || !maintenanceAllowed(pluginId)) owned.stop()
  return { get exited() { return owned.exited }, stop: owned.stop, waitForExit: () => waitForExit(owned) }
}
function waitForSpawn(owned: RuntimeChild): Promise<void> {
  return new Promise((resolve, reject) => {
    if (owned.exited) { reject(new Error('DSH process exited before spawn')); return }
    const cleanup = () => { owned.child.removeListener('spawn', started); owned.child.removeListener('error', failed); owned.child.removeListener('exit', failedExit) }
    const started = () => { cleanup(); resolve() }
    const failed = (error: Error) => { cleanup(); reject(error) }
    const failedExit = () => failed(new Error('DSH process exited before spawn'))
    owned.child.once('spawn', started)
    owned.child.once('error', failed)
    owned.child.once('exit', failedExit)
  })
}

// Probes obey the same generation ownership and exit barrier as long-lived children.
let detectCache: { key: string; at: number; version: string | null } | null = null
export async function probeDshRuntime(pluginId: string, resolved: ResolvedRuntime, home = dshDataDirs().dshHome): Promise<string> {
  assertMayStart(pluginId)
  const scope = requireScope(pluginId)
  const cmd = dshCommand(resolved)
  if (!cmd) throw new Error('dsh runtime 不可用')
  ensureDshDirs()
  const child = spawn(cmd.command, [...cmd.args, '--version'], { env: childEnv(home), stdio: ['ignore', 'pipe', 'pipe'] })
  const owned = ownDshChild(pluginId, child)
  let output = ''
  child.stdout?.on('data', chunk => { output = (output + String(chunk)).slice(-8192) })
  child.stderr?.resume()
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const completed = new Promise<number | null>((resolve, reject) => {
      child.once('error', reject)
      child.once('close', code => resolve(code))
    })
    const code = await Promise.race([completed, new Promise<never>((_, reject) => {
      timer = setTimeout(() => { owned.stop(); reject(new Error('DSH --version 健康检查超时')) }, 20_000)
      timer.unref()
    })])
    await owned.waitForExit()
    if (!currentScope(scope)) throw new Error('plugin runtime is closing')
    if (code !== 0 || !output.trim()) throw new Error('DSH --version 健康检查失败')
    return output.trim().split(/\r?\n/).pop()!
  } catch (error) {
    owned.stop()
    await owned.waitForExit()
    throw error
  } finally { if (timer) clearTimeout(timer) }
}
export async function detectRuntime(pluginId = DSH_PLUGIN_ID): Promise<DshRuntimeInfo> {
  const resolved = resolveRuntime()
  if (!resolved.bin) return resolvedRuntimeInfo('dsh runtime 未找到（插件捆绑/热更新/系统 PATH 均无）')
  const key = `${resolved.source}:${resolved.version}:${resolved.bin}`
  const cached = detectCache?.key === key && Date.now() - detectCache.at < 60_000 ? detectCache : null
  let version = resolved.version ?? cached?.version ?? null
  if (!version && !maintenanceAllowed(pluginId)) return resolvedRuntimeInfo('DSH 正在维护，暂不执行版本探测')
  if (!version) {
    try { version = await probeDshRuntime(pluginId, resolved) }
    catch (error) { return resolvedRuntimeInfo(String((error as Error).message ?? error)) }
  }
  detectCache = { key, at: Date.now(), version }
  return { ...resolvedRuntimeInfo(), version: version ?? undefined }
}

// —— Web process ——
const READY_URL_RE = /(https?:\/\/(?:127\.0\.0\.1|localhost|\[::1\]):\d+\/[^\s]*[?&]token=[^\s]+)/
function currentLaunch(launch: WebLaunch): boolean {
  return !launch.cancelled && webLaunches.get(launch.pluginId) === launch && currentScope(launch.scope)
}
function cancelLaunch(launch: WebLaunch): void {
  launch.cancelled = true
  launch.controller.abort()
  if (launch.restartTimer) clearTimeout(launch.restartTimer)
  launch.restartTimer = undefined
  if (webLaunches.get(launch.pluginId) === launch) webLaunches.delete(launch.pluginId)
  launch.detach()
}
function stopWebState(state: WebState, _reason: string): void {
  cancelLaunch(state.launch)
  state.stopping = true
  if (state.readyTimer) clearTimeout(state.readyTimer)
  state.readyTimer = undefined
  state.revokeEndpoint?.()
  // Intentional stop/close is not a startup failure; genuine failures are assigned at their source.
  if (!state.owned.exited) killChild(state.child, `dsh web(${state.owned.pluginId})`)
}
function stopWebInternal(pluginId: string, reason: string, generation?: number): void {
  const launch = webLaunches.get(pluginId)
  if (launch && (generation === undefined || launch.scope.owner.generation === generation)) {
    cancelLaunch(launch)
    if (launch.state) stopWebState(launch.state, reason)
  }
  const state = webStates.get(pluginId)
  if (state && (generation === undefined || state.owned.scope?.owner.generation === generation)) stopWebState(state, reason)
}
function webStatus(pluginId: string): DshWebProcessStatus {
  const state = webStates.get(pluginId)
  if (!state) return { running: false, profile: webInputs.get(pluginId)?.input.profile ?? 'web', portRetries: 0 }
  return {
    running: !state.owned.exited, pid: state.owned.exited ? undefined : state.pid, port: state.port,
    readyUrl: state.stopping || state.owned.exited ? undefined : state.readyUrl, profile: state.profile,
    startedAt: state.startedAt, portRetries: state.portRetries, lastError: state.lastError
  }
}
export async function startWeb(pluginId: string, input: DshWebLaunchInput = {}): Promise<{ pid?: number; port: number }> {
  assertMayStart(pluginId)
  const scope = requireScope(pluginId)
  const profile = safeProfile(input.profile, 'web')
  if (input.port !== undefined && (!Number.isInteger(input.port) || input.port < 0 || input.port > 65535)) throw new Error('DSH 端口须为 0..65535 的整数')
  const normalized = { profile, port: input.port || undefined }
  const active = webLaunches.get(pluginId)
  if (active && active.scope === scope && active.profile === profile && active.input.port === normalized.port && currentLaunch(active)) {
    if (active.state && !active.state.stopping && !active.state.owned.exited) return { pid: active.state.pid, port: active.state.port }
    if (active.restartTimer) throw new Error('dsh web 正在换口重启，请稍后重试')
    return active.start
  }
  const previous = webStates.get(pluginId)
  stopWebInternal(pluginId, '切换配置重启')
  const launch: WebLaunch = {
    pluginId, scope, profile, input: normalized, controller: new AbortController(), cancelled: false,
    start: Promise.resolve({ port: 0 }), done: Promise.resolve(), detach: () => {}, cancel: () => {}
  }
  launch.cancel = () => { cancelLaunch(launch); if (launch.state) stopWebState(launch.state, '启动已取消') }
  const abort = launch.cancel
  launch.detach = () => scope.signal.removeEventListener('abort', abort)
  scope.signal.addEventListener('abort', abort, { once: true })
  webLaunches.set(pluginId, launch)
  pendingLaunches.add(launch)
  webInputs.set(pluginId, { scope, input: normalized })
  launch.start = (async () => {
    if (previous && !previous.owned.exited) await waitForExit(previous.owned)
    const env = await profileEnvironment(profile, 'web')
    if (!currentLaunch(launch)) throw new Error('dsh web 启动已取消')
    const port = normalized.port ?? await allocatePort(launch.controller.signal)
    if (!currentLaunch(launch)) throw new Error('dsh web 启动已取消')
    const state = spawnWeb(launch, port, 0, env)
    await waitForSpawn(state.owned)
    if (!currentLaunch(launch)) throw new Error('dsh web 启动已取消')
    return { pid: state.pid, port }
  })().catch(error => {
    launch.cancel()
    if (currentScope(scope) && webInputs.get(pluginId)?.scope === scope && !webLaunches.has(pluginId)) {
      emit(pluginId, { type: 'web-exit', code: null, lastError: String((error as Error).message ?? error) })
    }
    throw error
  }).finally(() => { pendingLaunches.delete(launch) })
  launch.done = launch.start
  return launch.start
}
function spawnWeb(launch: WebLaunch, port: number, retries: number, env: Record<string, string>): WebState {
  if (!currentLaunch(launch)) throw new Error('dsh web 启动已取消')
  assertMayStart(launch.pluginId)
  const { pluginId, profile, scope } = launch
  const cmd = dshCommand(resolveRuntime())
  if (!cmd) throw new Error('dsh runtime 不可用：请先在设置台安装或激活运行时')
  const { dshHome } = ensureDshDirs()
  // --profile forwards all remaining arguments to the selected app; do not add a positional "web".
  const child = spawn(cmd.command, [...cmd.args, '--profile', profile, '--no-open', '--port', String(port), '--host', '127.0.0.1'], {
    env: childEnv(dshHome, env), cwd: dshHome, stdio: ['ignore', 'pipe', 'pipe']
  })
  const owned = ownChild(pluginId, scope, child, () => stopWebState(state, '插件关闭回收'))
  const state: WebState = { secrets: secretValues(env), owned, launch, child, pid: child.pid, profile, port, startedAt: Date.now(), portRetries: retries,
    stopping: false, finished: false, sawAddrInUse: false, stdout: makeRing(LOG_RING_LINES), stderr: makeRing(LOG_RING_LINES) }
  launch.state = state
  webStates.set(pluginId, state)
  child.once('spawn', () => { state.pid = child.pid })
  const finished = (code: number | null) => {
    if (state.finished) return
    state.finished = true
    if (state.readyTimer) clearTimeout(state.readyTimer)
    state.revokeEndpoint?.()
    if (webStates.get(pluginId) !== state) return
    if (!currentScope(scope)) return
    if (!currentLaunch(launch) || state.stopping) {
      emit(pluginId, { type: 'web-exit', code, lastError: state.lastError })
      return
    }
    if (retries >= MAX_PORT_RETRIES) {
      state.lastError ??= `多次启动失败（code=${code}）`
      cancelLaunch(launch)
      emit(pluginId, { type: 'web-exit', code, lastError: state.lastError })
      return
    }
    state.lastError = state.sawAddrInUse || !state.readyUrl
      ? `端口 ${state.port} 被占用或启动失败，自动换口重试（第 ${retries + 1}/${MAX_PORT_RETRIES} 次）`
      : `进程意外退出（code=${code}），自动拉起`
    emit(pluginId, { type: 'web-exit', code, lastError: state.lastError })
    const timer = setTimeout(() => {
      if (launch.restartTimer !== timer || !currentLaunch(launch)) return
      launch.restartTimer = undefined
      void allocatePort(launch.controller.signal).then(newPort => {
        if (!currentLaunch(launch) || !state.owned.exited || webStates.get(pluginId) !== state) return
        emit(pluginId, { type: 'web-port', port: newPort, retries: retries + 1 })
        spawnWeb(launch, newPort, retries + 1, env)
      }).catch(error => {
        if (currentLaunch(launch)) {
          state.lastError = `web 换口重启失败: ${String(error)}`
          logWarn('dsh', state.lastError)
          cancelLaunch(launch)
          emit(pluginId, { type: 'web-exit', code: null, lastError: state.lastError })
        }
      })
    }, RESTART_BACKOFF_MS)
    timer.unref()
    launch.restartTimer = timer
  }
  child.once('exit', finished)
  child.once('close', finished)
  child.once('error', error => { state.lastError = String(error); if (owned.exited) finished(null) })
  state.readyTimer = setTimeout(() => {
    if (!currentLaunch(launch) || owned.exited || state.readyUrl) return
    state.lastError = 'dsh web 就绪超时（60s），已停止；可手动重试'
    stopWebState(state, state.lastError)
    emit(pluginId, { type: 'web-exit', code: null, lastError: state.lastError })
  }, READY_TIMEOUT_MS)
  state.readyTimer.unref()
  const decoder = new StringDecoder('utf8')
  let buffer = ''
  child.stdout?.on('data', chunk => {
    if (!currentLaunch(launch) || state.stopping || owned.exited) return
    buffer = (buffer + decoder.write(chunk)).slice(-32768)
    const lines = buffer.split(/\r?\n/)
    buffer = lines.pop() ?? ''
    for (const line of lines) if (line.trim()) state.stdout.push(line)
    const match = READY_URL_RE.exec(lines.join('\n'))
    if (match && !state.readyUrl) {
      let endpoint: URL
      try { endpoint = new URL(match[1].replace(/\x1b\[[0-9;]*m/g, '')) } catch { return }
      if (!['127.0.0.1', 'localhost', '[::1]'].includes(endpoint.hostname) || Number(endpoint.port) !== port || endpoint.username || endpoint.password) {
        state.lastError = 'unexpected DSH endpoint'; return
      }
      state.revokeEndpoint = allowPluginEndpoint(pluginId, endpoint.href, 'subFrame')
      scope.addDisposer(state.revokeEndpoint)
      state.readyUrl = endpoint.href
      state.readyAt = Date.now()
      state.lastError = undefined
      if (state.readyTimer) clearTimeout(state.readyTimer)
      emit(pluginId, { type: 'web-ready', port, readyUrl: state.readyUrl })
    }
  })
  child.stderr?.on('data', chunk => {
    const text = String(chunk)
    if (/EADDRINUSE/i.test(text)) state.sawAddrInUse = true
    for (const line of text.split('\n')) if (line.trim()) state.stderr.push(line)
    if (currentLaunch(launch) && !state.stopping && !owned.exited) emit(pluginId, { type: 'web-stderr', tail: redactLog(text.slice(-2000), state.secrets) })
  })
  if (!currentLaunch(launch)) stopWebState(state, '插件关闭回收')
  return state
}
export function stopWeb(pluginId: string): boolean {
  const existed = !!webStates.get(pluginId) && !webStates.get(pluginId)!.owned.exited || webLaunches.has(pluginId)
  stopWebInternal(pluginId, '手动停止')
  return existed
}
export async function stopWebAndWait(pluginId: string): Promise<void> {
  return withDshMaintenance(pluginId, async () => {
    stopWeb(pluginId)
    const starts = [...pendingLaunches].filter(launch => launch.pluginId === pluginId && 'controller' in launch)
    await boundedWait(Promise.all(starts.map(launch => launch.done.catch(() => {}))), 'DSH web launch cancellation not confirmed')
    const state = webStates.get(pluginId)
    if (state) await waitForExit(state.owned)
  })
}
export async function restartWeb(pluginId: string, input: DshWebLaunchInput = {}): Promise<{ pid?: number; port: number }> {
  return withDshMaintenance(pluginId, async () => {
    const remembered = webInputs.get(pluginId)
    const previous = remembered?.scope === requireScope(pluginId) ? remembered.input : {}
    await stopWebAndWait(pluginId)
    return startWeb(pluginId, { ...previous, ...input })
  })
}

// —— SDK process / stdio JSON-RPC ——
function sdkStatus(pluginId: string): DshSdkProcessStatus {
  const state = sdkStates.get(pluginId)
  if (!state) return { running: false, initialized: false, profile: sdkInputs.get(pluginId)?.input.profile ?? 'sdk' }
  return { running: !state.owned.exited, pid: state.owned.exited ? undefined : state.pid, profile: state.input.profile ?? 'sdk',
    initialized: !state.stopping && !state.owned.exited && state.initialized, serverInfo: state.serverInfo, lastError: state.initError ?? state.lastError }
}
function sendJsonRpc(state: SdkState, id: number, method: string, params: unknown): void {
  if (!state.child.stdin || state.child.stdin.destroyed || !state.child.stdin.writable) throw new Error('DSH SDK stdin 已关闭')
  state.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
}
function rejectSdkPending(state: SdkState, reason: string): void {
  for (const pending of state.pending.values()) { clearTimeout(pending.timer); pending.reject(new Error(reason)) }
  state.pending.clear()
}
function cancelSdkLaunch(launch: SdkLaunch): void {
  launch.cancelled = true
  if (sdkLaunches.get(launch.pluginId) === launch) sdkLaunches.delete(launch.pluginId)
  launch.detach()
}
function stopSdkState(state: SdkState, graceful: boolean): void {
  cancelSdkLaunch(state.launch)
  if (!state.stopping) {
    state.stopping = true
    rejectSdkPending(state, 'sdk 进程已停止')
    if (graceful && !state.owned.exited) {
      try { sendJsonRpc(state, state.nextId++, 'shutdown', undefined) } catch { /* stdin closed */ }
      // Capture this instance, never a later sdkStates.get(pluginId).
      state.shutdownTimer = setTimeout(() => {
        state.shutdownTimer = undefined
        if (!state.owned.exited) killChild(state.child, `dsh sdk(${state.owned.pluginId})`)
      }, 200)
      state.shutdownTimer.unref()
    }
  }
  if (!graceful) {
    if (state.shutdownTimer) clearTimeout(state.shutdownTimer)
    state.shutdownTimer = undefined
    if (!state.owned.exited) killChild(state.child, `dsh sdk(${state.owned.pluginId})`)
  }
}
function currentSdkLaunch(launch: SdkLaunch): boolean {
  return !launch.cancelled && sdkLaunches.get(launch.pluginId) === launch && currentScope(launch.scope)
}
export async function startSdk(pluginId: string, input: DshSdkLaunchInput): Promise<{ pid?: number }> {
  assertMayStart(pluginId)
  const scope = requireScope(pluginId)
  const normalized: DshSdkLaunchInput = { ...input, profile: safeProfile(input.profile, 'sdk') }
  const pending = sdkLaunches.get(pluginId)
  if (pending && pending.scope === scope && currentSdkLaunch(pending) && JSON.stringify(pending.input) === JSON.stringify(normalized)) {
    const state = sdkStates.get(pluginId)
    if (state && state.launch === pending && !state.stopping && !state.owned.exited && !state.initError) return { pid: state.pid }
    return pending.start
  }
  const previous = sdkStates.get(pluginId)
  if (pending) pending.cancel()
  if (previous && !previous.owned.exited) stopSdkState(previous, false)
  const launch: SdkLaunch = { pluginId, scope, input: normalized, cancelled: false, cancel: () => {},
    detach: () => {}, done: Promise.resolve(), start: Promise.resolve({}) }
  launch.cancel = () => {
    cancelSdkLaunch(launch)
    const state = sdkStates.get(pluginId)
    if (state?.launch === launch) stopSdkState(state, false)
  }
  const abort = launch.cancel
  launch.detach = () => scope.signal.removeEventListener('abort', abort)
  scope.signal.addEventListener('abort', abort, { once: true })
  sdkLaunches.set(pluginId, launch)
  sdkInputs.set(pluginId, { scope, input: normalized })
  pendingLaunches.add(launch)
  launch.start = (async () => {
    if (previous && !previous.owned.exited) await waitForExit(previous.owned)
    const env = await profileEnvironment(normalized.profile!, 'sdk')
    if (!currentSdkLaunch(launch)) throw new Error('dsh sdk 启动已取消')
    const state = spawnSdk(launch, env)
    await waitForSpawn(state.owned)
    if (!currentSdkLaunch(launch)) throw new Error('dsh sdk 启动已取消')
    return { pid: state.pid }
  })().catch(error => { launch.cancel(); throw error }).finally(() => { pendingLaunches.delete(launch) })
  launch.done = launch.start
  return launch.start
}
function spawnSdk(launch: SdkLaunch, env: Record<string, string>): SdkState {
  if (!currentSdkLaunch(launch)) throw new Error('dsh sdk 启动已取消')
  assertMayStart(launch.pluginId)
  const { pluginId, scope, input } = launch
  const cmd = dshCommand(resolveRuntime())
  if (!cmd) throw new Error('dsh runtime 不可用：请先在设置台安装或激活运行时')
  const { dshHome } = ensureDshDirs()
  const cwd = typeof input.cwd === 'string' && input.cwd.trim() ? input.cwd : dshHome
  const child = spawn(cmd.command, [...cmd.args, '--profile', input.profile!], { env: childEnv(dshHome, env), cwd, stdio: ['pipe', 'pipe', 'pipe'] })
  const owned = ownChild(pluginId, scope, child, () => stopSdkState(state, true))
  const state: SdkState = { secrets: secretValues(env), owned, launch, input, child, pid: child.pid, initialized: false, stopping: false, finished: false,
    nextId: 1, buffer: '', pending: new Map(), stdout: makeRing(LOG_RING_LINES), stderr: makeRing(LOG_RING_LINES), initPromise: Promise.resolve() }
  sdkStates.set(pluginId, state)
  state.initPromise = new Promise<void>(resolve => {
    const id = state.nextId++
    const timer = setTimeout(() => {
      state.pending.delete(id)
      state.initError = 'initialize 握手超时（60s），已停止；可重试'
      resolve()
      stopSdkState(state, false)
      if (currentScope(scope)) emit(pluginId, { type: 'sdk-exit', code: null, lastError: state.initError })
    }, READY_TIMEOUT_MS)
    timer.unref()
    state.pending.set(id, {
      timer,
      resolve: value => {
        state.initialized = true
        state.serverInfo = (value as { serverInfo?: { name: string; version: string } })?.serverInfo
        resolve()
      },
      reject: error => {
        if (!state.stopping && currentScope(scope)) state.initError = error.message
        resolve()
        stopSdkState(state, false)
      }
    })
    child.once('spawn', () => {
      state.pid = child.pid
      if (state.stopping || !currentSdkLaunch(launch)) return
      try {
        sendJsonRpc(state, id, 'initialize', {
          cwd, provider: String(input.provider ?? 'deepseek-official'), model: String(input.model ?? 'deepseek-chat'),
          ...(input.reasoningEffort ? { reasoningEffort: String(input.reasoningEffort) } : {}),
          ...(Number.isInteger(input.maxTokens) && Number(input.maxTokens) > 0 ? { maxTokens: Number(input.maxTokens) } : {})
        })
      } catch (error) { state.initError = String(error); stopSdkState(state, false) }
    })
  })
  const finished = (code: number | null) => {
    if (state.finished) return
    state.finished = true
    if (state.shutdownTimer) clearTimeout(state.shutdownTimer)
    if (!state.stopping && !state.initError) state.lastError ??= `dsh sdk 进程退出（code=${code}）`
    rejectSdkPending(state, state.initError ?? `dsh sdk 进程退出（code=${code}）`)
    cancelSdkLaunch(launch)
    if (sdkStates.get(pluginId) === state && currentScope(scope)) emit(pluginId, { type: 'sdk-exit', code, lastError: state.initError ?? state.lastError })
  }
  child.once('error', error => {
    state.lastError = String(error)
    rejectSdkPending(state, String(error))
    if (owned.exited) finished(null)
  })
  child.once('exit', finished)
  child.once('close', finished)
  child.stdin?.on('error', error => { state.lastError = String(error); stopSdkState(state, false) })
  const decoder = new StringDecoder('utf8')
  child.stdout?.on('data', chunk => {
    if (state.stopping || owned.exited || !currentScope(scope)) return
    state.buffer += decoder.write(chunk)
    if (state.buffer.length > 4 * 1024 * 1024) { state.lastError = 'DSH SDK frame exceeds limit'; stopSdkState(state, false); return }
    let index: number
    while ((index = state.buffer.indexOf('\n')) >= 0) {
      const line = state.buffer.slice(0, index).trim()
      state.buffer = state.buffer.slice(index + 1)
      if (!line) continue
      state.stdout.push(line.slice(-8192))
      let frame: { id?: number; method?: string; params?: unknown; result?: unknown; error?: { message?: string } }
      try { frame = JSON.parse(line) } catch { continue }
      if (!frame || typeof frame !== 'object') continue
      if (typeof frame.method === 'string' && frame.id === undefined) {
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
  child.stderr?.on('data', chunk => { for (const line of String(chunk).split('\n')) if (line.trim()) state.stderr.push(line) })
  if (!currentSdkLaunch(launch)) owned.stop()
  return state
}
export function stopSdk(pluginId: string): boolean {
  const launch = sdkLaunches.get(pluginId)
  launch?.cancel()
  const state = sdkStates.get(pluginId)
  if (state) stopSdkState(state, false)
  return !!launch || !!state && !state.owned.exited
}
export async function stopSdkAndWait(pluginId: string): Promise<void> {
  return withDshMaintenance(pluginId, async () => {
    stopSdk(pluginId)
    const starts = [...pendingLaunches].filter(launch => launch.pluginId === pluginId && !('controller' in launch))
    await boundedWait(Promise.all(starts.map(launch => launch.done.catch(() => {}))), 'DSH SDK launch cancellation not confirmed')
    const state = sdkStates.get(pluginId)
    if (state) await waitForExit(state.owned)
  })
}
export async function restartSdk(pluginId: string, input?: DshSdkLaunchInput): Promise<{ pid?: number }> {
  return withDshMaintenance(pluginId, async () => {
    const remembered = sdkInputs.get(pluginId)
    const previous = remembered?.scope === requireScope(pluginId) ? remembered.input : {} as DshSdkLaunchInput
    await stopSdkAndWait(pluginId)
    return startSdk(pluginId, { ...previous, ...input })
  })
}
/** Wait for initialize on the captured instance; closing never retargets a request to its replacement. */
export async function sdkRpc(pluginId: string, method: string, params: Record<string, unknown>): Promise<unknown> {
  assertMayStart(pluginId)
  const state = sdkStates.get(pluginId)
  if (!state || state.stopping || state.owned.exited) throw new Error(state?.initError ?? 'dsh sdk 未启动')
  await state.initPromise
  if (sdkStates.get(pluginId) !== state || state.stopping || state.owned.exited || !state.owned.scope || !currentScope(state.owned.scope)) {
    throw new Error(state.initError ?? 'dsh sdk 已关闭')
  }
  assertMayStart(pluginId)
  if (method !== 'shutdown' && !state.initialized) throw new Error(state.initError ?? 'dsh sdk 未完成 initialize 握手')
  return new Promise((resolve, reject) => {
    const id = state.nextId++
    const timer = setTimeout(() => { state.pending.delete(id); reject(new Error(`dsh sdk rpc 超时: ${method}`)) }, 120_000)
    state.pending.set(id, { timer, resolve, reject })
    try { sendJsonRpc(state, id, method, params) }
    catch (error) { state.pending.delete(id); clearTimeout(timer); reject(error) }
  })
}

// —— Status / logs / lifecycle barriers ——
export function runtimeStatus(pluginId = DSH_PLUGIN_ID): DshRuntimeStatus {
  return { runtime: resolvedRuntimeInfo(), web: webStatus(pluginId), sdk: sdkStatus(pluginId) }
}
export function logsTail(kind: 'web' | 'sdk', lines: number, pluginId = DSH_PLUGIN_ID): string[] {
  const limit = Math.max(1, Math.min(200, Math.floor(lines) || 50))
  const state = kind === 'web' ? webStates.get(pluginId) : sdkStates.get(pluginId)
  return state ? [...state.stdout.tail(limit), ...state.stderr.tail(limit)].slice(-limit).map(line => redactLog(line, state.secrets)) : []
}
export function snapshotDshProcesses(pluginId: string): DshProcessSnapshot {
  const scope = requireScope(pluginId)
  const web = webStates.get(pluginId)
  const sdk = sdkStates.get(pluginId)
  const webInput = webInputs.get(pluginId)
  const sdkInput = sdkInputs.get(pluginId)
  return {
    ...(webInput?.scope === scope && (webLaunches.has(pluginId) || web && !web.owned.exited && !web.stopping) ? { web: { ...webInput.input } } : {}),
    ...(sdkInput?.scope === scope && (sdkLaunches.has(pluginId) || sdk && !sdk.owned.exited && !sdk.stopping) ? { sdk: { ...sdkInput.input } } : {})
  }
}
export async function restartDshProcesses(pluginId: string, snapshot: DshProcessSnapshot): Promise<void> {
  if (snapshot.web) await startWeb(pluginId, snapshot.web)
  if (snapshot.sdk) await startSdk(pluginId, snapshot.sdk)
}
async function stopOwnedAndWait(pluginId: string, generation?: number): Promise<void> {
  stopWebInternal(pluginId, 'DSH 维护/关闭回收', generation)
  const matches = (owner: { pluginId: string; scope?: PluginRuntimeScope }) => owner.pluginId === pluginId
    && (generation === undefined || owner.scope?.owner.generation === generation)
  const starts = [...pendingLaunches].filter(matches)
  for (const launch of starts) launch.cancel()
  const sdkLaunch = sdkLaunches.get(pluginId)
  if (sdkLaunch && matches(sdkLaunch)) sdkLaunch.cancel()
  const children = [...runtimeChildren].filter(matches)
  for (const owned of children) owned.stop()
  // Both waits start together; a timeout must never be mistaken for a safe mutation boundary.
  await Promise.all([
    Promise.all(children.map(waitForExit)),
    boundedWait(Promise.all(starts.map(launch => launch.done.catch(() => {}))), 'DSH pending launch cancellation not confirmed')
  ])
  const remaining = [...runtimeChildren].filter(matches)
  if (remaining.length) {
    for (const child of remaining) child.stop()
    await Promise.all(remaining.map(waitForExit))
  }
}
export async function stopAllDshAndWait(pluginId: string): Promise<void> {
  return withDshMaintenance(pluginId, () => stopOwnedAndWait(pluginId))
}
/** Release never waits for the maintenance mutex: abort/kill must preempt a download or health probe. */
export async function releaseDshRuntime(pluginId: string, generation?: number): Promise<void> {
  try { await stopOwnedAndWait(pluginId, generation) }
  finally {
    for (const [id, entry] of webInputs) if (id === pluginId && (generation === undefined || entry.scope.owner.generation === generation)) webInputs.delete(id)
    for (const [id, entry] of sdkInputs) if (id === pluginId && (generation === undefined || entry.scope.owner.generation === generation)) sdkInputs.delete(id)
    const web = webStates.get(pluginId)
    if (web?.owned.exited && (generation === undefined || web.owned.scope?.owner.generation === generation)) webStates.delete(pluginId)
    const sdk = sdkStates.get(pluginId)
    if (sdk?.owned.exited && (generation === undefined || sdk.owned.scope?.owner.generation === generation)) sdkStates.delete(pluginId)
  }
}
