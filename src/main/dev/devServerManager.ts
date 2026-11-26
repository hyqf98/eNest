/**
 * Dev server 自动拉起与进程回收。
 * 自建进程从 spawn 返回起即登记；用户手动启动的服务只复用、不接管。
 * 新检出仓库没有 node_modules 时先自动执行一次包管理器 install，再拉起开发服务。
 */
import { createConnection } from 'node:net'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type { ChildProcess } from 'node:child_process'
import { net } from 'electron'
import { sendShellEvent } from '@main/window/createShellWindow'
import { logInfo } from '@main/logs/logService'
import { getRuntimeScope, type PluginRuntimeScope } from '@main/plugin/PluginRuntimeScope'
import { registerPluginProcess } from '@main/plugin/pluginOwnedProcesses'
import type { DevCommandSpec, PluginManifest } from '@shared/types/plugin'
import { buildSpawnCandidates, formatPortArgs, killTree, pipeOutput, spawnCommand } from './devSpawn'
import { detectPackageManager } from './devCommandResolver'

const READY_TIMEOUT_MS = 20_000
const POLL_INTERVAL_MS = 500
/** 拉起失败后的冷却期：避免 watcher 触发的每次重载都重新等待一次就绪超时 */
const RETRY_COOLDOWN_MS = 60_000
/** 声明端口被占时向上尝试的端口数 */
const PORT_SCAN_RANGE = 32
/** 端口占用探测的 connect 超时：本机回环正常在毫秒级完成，超时视为无人监听 */
const PROBE_TIMEOUT_MS = 400
/** Only new process startup is bounded; already-running services never wait for a slot. */
const MAX_CONCURRENT_STARTS = 2
/** 自动依赖安装的最长等待：新机器冷装大依赖可能要几分钟，超时只放弃当次拉起 */
const INSTALL_TIMEOUT_MS = 10 * 60_000
/** 同一源码目录的自动安装只做一次（成功与否），失败留待用户手动处理后重试 */
const installedRoots = new Map<string, Promise<boolean>>()

export interface DevServerEnsureOptions {
  signal?: AbortSignal
  isCurrent?: () => boolean
  /** Internal diagnostic label, never a path, URL or command. */
  reason?: string
  /** Explicit user retry may bypass a previous startup failure's cooldown. */
  retry?: boolean
}

class DevServerRetirementError extends Error {
  constructor() {
    super('Previous development process tree exit was not confirmed; retry after it has stopped')
    this.name = 'DevServerRetirementError'
  }
}

interface ManagedServer {
  url: string
  child: ChildProcess
  launch: Launch
  ready: boolean
  exited: boolean
  closed: boolean
  close: Promise<void>
}
interface Launch {
  controller: AbortController
  scope?: PluginRuntimeScope
  promise: Promise<string | null>
  children: Set<ManagedServer>
  finished: boolean
  cancelRequested: boolean
  detach: () => void
  options: DevServerEnsureOptions
  startedAt: number
  queueMs: number
  reason: string
}
interface StartWaiter {
  launch: Launch
  grant: () => void
  cancel: () => void
}
const managed = new Map<string, Set<ManagedServer>>()
const pending = new Map<string, Launch>()
const lastFailedAt = new Map<string, number>()
const startQueue: StartWaiter[] = []
let activeStarts = 0
let spawnedTotal = 0

/** A listening port alone does not identify a plugin development server. */
export async function matchesDevelopmentServer(url: string, pluginId: string, signal?: AbortSignal): Promise<boolean> {
  try {
    const timeout = AbortSignal.timeout(1200)
    const response = await net.fetch(new URL('plugin.json', url).href, { signal: signal ? AbortSignal.any([signal, timeout]) : timeout, redirect: 'error', credentials: 'omit' })
    if (!response.ok || Number(response.headers.get('content-length') ?? 0) > 65536) return false
    const reader = response.body?.getReader()
    if (!reader) return false
    const chunks: Uint8Array[] = []
    let length = 0
    try {
      while (true) {
        const part = await reader.read()
        if (part.done) break
        length += part.value.length
        if (length > 65536) return false
        chunks.push(part.value)
      }
    } finally { await reader.cancel().catch(() => undefined) }
    const manifest = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Partial<PluginManifest>
    return manifest.id === pluginId && manifest.main === 'index.html'
  } catch { return false }
}

function emitLog(pluginId: string, level: 'info' | 'warn', message: string): void {
  sendShellEvent({ type: 'plugin-log', pluginId, level, message: message.slice(0, 2000) })
}

function requestCurrent(options: DevServerEnsureOptions): boolean {
  if (options.signal?.aborted) return false
  try { return options.isCurrent?.() !== false }
  catch { return false }
}

function requestCancelled(launch: Launch): boolean {
  return launch.cancelRequested || !!launch.scope && (!launch.scope.isCurrent() || launch.scope.signal.aborted)
    || !launch.finished && !requestCurrent(launch.options)
}

function cancelled(launch: Launch): boolean {
  return launch.controller.signal.aborted || requestCancelled(launch)
}

function cancellationError(): Error {
  const error = new Error('Development service startup cancelled')
  error.name = 'AbortError'
  return error
}

function assertCurrent(launch: Launch): void {
  if (!requestCancelled(launch)) return
  stopLaunch(launch)
  throw cancellationError()
}

function stopLaunch(launch: Launch, cancelledByCaller = true): void {
  if (cancelledByCaller) launch.cancelRequested = true
  launch.controller.abort()
  for (const server of launch.children) killTree(server.child)
}

function drainStarts(): void {
  while (activeStarts < MAX_CONCURRENT_STARTS && startQueue.length) {
    const waiter = startQueue.shift()!
    if (cancelled(waiter.launch)) waiter.cancel()
    else waiter.grant()
  }
}

function acquireStartSlot(pluginId: string, launch: Launch): Promise<() => void> {
  assertCurrent(launch)
  const queuedAt = performance.now()
  return new Promise((resolve, reject) => {
    let settled = false
    let timer: ReturnType<typeof setInterval> | undefined
    const cleanup = () => {
      if (timer) clearInterval(timer)
      launch.controller.signal.removeEventListener('abort', waiter.cancel)
      const index = startQueue.indexOf(waiter)
      if (index !== -1) startQueue.splice(index, 1)
      launch.queueMs += Math.round(performance.now() - queuedAt)
    }
    const waiter: StartWaiter = {
      launch,
      cancel: () => {
        if (settled) return
        settled = true
        cleanup()
        reject(cancellationError())
        drainStarts()
      },
      grant: () => {
        if (settled) return
        if (cancelled(launch)) { waiter.cancel(); return }
        settled = true
        cleanup()
        activeStarts++
        let released = false
        resolve(() => {
          if (released) return
          released = true
          activeStarts--
          drainStarts()
        })
      }
    }
    launch.controller.signal.addEventListener('abort', waiter.cancel, { once: true })
    startQueue.push(waiter)
    if (activeStarts >= MAX_CONCURRENT_STARTS) {
      logInfo('dev', `${pluginId}: dev server queued reason=${launch.reason} active=${activeStarts}/${MAX_CONCURRENT_STARTS} queued=${startQueue.length}`)
      // A generation guard may retire without an AbortSignal event.
      timer = setInterval(() => { if (cancelled(launch)) stopLaunch(launch) }, POLL_INTERVAL_MS)
      timer.unref()
    }
    drainStarts()
  })
}

/** A later caller can stop waiting without cancelling another caller's shared startup. */
function waitForPending(launch: Launch, options: DevServerEnsureOptions): Promise<string | null> {
  if (!requestCurrent(options)) return Promise.reject(cancellationError())
  if (!options.signal && !options.isCurrent) return launch.promise
  return new Promise((resolve, reject) => {
    const abort = () => reject(cancellationError())
    options.signal?.addEventListener('abort', abort, { once: true })
    void launch.promise.then(value => {
      if (requestCurrent(options)) resolve(value)
      else reject(cancellationError())
    }, reject).finally(() => options.signal?.removeEventListener('abort', abort))
  })
}

async function waitForClose(server: ManagedServer): Promise<void> {
  if (server.closed) return
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    await Promise.race([server.close, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new DevServerRetirementError()), 1500) })])
  } finally { if (timer) clearTimeout(timer) }
}

function trackChild(pluginId: string, url: string, child: ChildProcess, launch: Launch): ManagedServer {
  let resolveClose!: () => void
  const close = new Promise<void>(resolve => { resolveClose = resolve })
  const server: ManagedServer = { url, child, launch, close, ready: false, exited: false, closed: false }
  launch.children.add(server)
  const servers = managed.get(pluginId) ?? new Set<ManagedServer>()
  managed.set(pluginId, servers)
  servers.add(server)
  const unregister = registerPluginProcess({
    pluginId, generation: launch.scope?.owner.generation, kind: 'development',
    getPid: () => server.exited || server.closed ? undefined : child.pid,
    stop: async () => { stopLaunch(launch); await waitForClose(server) }
  })
  const finished = () => {
    if (server.closed) return
    server.closed = true
    unregister()
    servers.delete(server)
    launch.children.delete(server)
    if (managed.get(pluginId) === servers && !servers.size) managed.delete(pluginId)
    if (launch.finished && !launch.children.size) launch.detach()
    resolveClose()
  }
  let spawned = false
  child.once('spawn', () => { spawned = true; spawnedTotal++; if (cancelled(launch)) killTree(child) })
  child.once('exit', () => { server.exited = true })
  child.once('error', () => {
    // A spawn failure owns no OS process. A post-spawn error still needs real exit/close.
    if (!spawned && child.pid === undefined) finished()
    else stopLaunch(launch, false)
  })
  // Keep the tree record until stdio also closes: a reaped wrapper can leave descendants.
  // Never signal its former PID/PGID after exit; a missing close is reported, not guessed.
  child.once('close', finished)
  pipeOutput(child, (level, text) => emitLog(pluginId, level, text))
  if (cancelled(launch)) killTree(child)
  return server
}

function pause(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve()
  return new Promise(resolve => {
    const done = () => { clearTimeout(timer); signal.removeEventListener('abort', done); resolve() }
    const timer = setTimeout(done, POLL_INTERVAL_MS)
    signal.addEventListener('abort', done, { once: true })
  })
}

async function launchAndWait(pluginId: string, sourcePath: string, declaredUrl: string, start: DevCommandSpec, launch: Launch): Promise<string | null> {
  let targetUrl = declaredUrl
  let extraArgs: string[] = []
  const declared = new URL(declaredUrl)
  const declaredPort = Number(declared.port || (declared.protocol === 'https:' ? 443 : 80))
  let targetPort = declaredPort
  if (!await canListen(declaredPort)) {
    if (cancelled(launch)) return null
    // An external service may have appeared while this launch waited for a slot.
    if (await matchesDevelopmentServer(declaredUrl, pluginId, launch.controller.signal)) {
      if (cancelled(launch)) return null
      return declaredUrl
    }
    if (cancelled(launch)) return null
    const port = await pickFreePort(declaredPort, launch.controller.signal)
    if (cancelled(launch)) return null
    if (port === null) {
      emitLog(pluginId, 'warn', `端口 ${declaredPort} 被占用且附近无空闲端口，已回退`)
      lastFailedAt.set(pluginId, Date.now())
      return null
    }
    declared.port = String(port)
    targetUrl = declared.toString()
    targetPort = port
    extraArgs = start.kind === 'script' ? formatPortArgs(start.portArgs, port) : []
    if (start.kind === 'raw') start = { ...start, command: start.command.replaceAll('{port}', String(port)) }
    emitLog(pluginId, 'info', `声明端口 ${declaredPort} 被其它进程占用，改用 ${port}`)
  }
  if (cancelled(launch)) return null
  // 新检出的源码没有 node_modules：先自动安装依赖，再拉服务（10 分钟上限）。
  if (!await ensureDependenciesInstalled(pluginId, sourcePath, start, launch)) {
    if (!cancelled(launch)) lastFailedAt.set(pluginId, Date.now())
    return null
  }
  if (cancelled(launch)) return null
  emitLog(pluginId, 'info', `开发服务未运行，正在启动 ${start.label} …`)
  logInfo('dev', `${pluginId}: dev server starting reason=${launch.reason} active=${activeStarts}/${MAX_CONCURRENT_STARTS} queued=${startQueue.length} queueMs=${launch.queueMs}`)
  const env = { ...process.env, ...start.env, ENEST_DEV_PORT: String(targetPort) }
  let server: ManagedServer | undefined
  const child = await spawnCommand(sourcePath, buildSpawnCandidates(start, extraArgs), env, warn => emitLog(pluginId, 'warn', warn), {
    signal: launch.controller.signal,
    onChild: child => { server = trackChild(pluginId, targetUrl, child, launch) }
  })
  if (cancelled(launch)) { if (child) killTree(child); return null }
  if (!child || !server) { lastFailedAt.set(pluginId, Date.now()); return null }
  const deadline = Date.now() + READY_TIMEOUT_MS
  while (!cancelled(launch) && Date.now() < deadline) {
    if (server.exited || server.closed || child.exitCode !== null || child.signalCode !== null) {
      emitLog(pluginId, 'warn', '开发服务主进程已退出（端口被占用或依赖未安装？）；后代仍需等待管道关闭确认')
      stopLaunch(launch, false)
      lastFailedAt.set(pluginId, Date.now())
      return null
    }
    const ready = await matchesDevelopmentServer(targetUrl, pluginId, launch.controller.signal)
    if (cancelled(launch)) return null
    if (ready && !server.exited && !server.closed) {
      server.ready = true
      lastFailedAt.delete(pluginId)
      logInfo('dev', `${pluginId}: dev server started pid=${child.pid} url=${targetUrl} spawnedTotal=${spawnedTotal}`)
      emitLog(pluginId, 'info', `开发服务已就绪 ${targetUrl}，框架 HMR 生效`)
      return targetUrl
    }
    await pause(launch.controller.signal)
  }
  if (!cancelled(launch)) {
    emitLog(pluginId, 'warn', `开发服务 ${READY_TIMEOUT_MS / 1000}s 内未就绪，已停止并回退；${RETRY_COOLDOWN_MS / 1000}s 内不再自动重试`)
    lastFailedAt.set(pluginId, Date.now())
  }
  stopLaunch(launch, false)
  return null
}

/**
 * 端口无人监听才可用（插件 dev 脚本固定 --host 127.0.0.1）。
 * 必须用 connect 探测而不是 bind 探测：macOS 允许 127.0.0.1:port 与别的进程已绑定的 *:port 共存，
 * bind 会“成功”而把被占端口误判为空闲，随后 --strictPort 启动才 EADDRINUSE，只能等就绪超时回退。
 */
function canListen(port: number): Promise<boolean> {
  return new Promise(resolve => {
    const probe = createConnection({ port, host: '127.0.0.1' })
    probe.unref()
    const free = () => { probe.destroy(); resolve(true) }
    const taken = () => { probe.destroy(); resolve(false) }
    probe.setTimeout(PROBE_TIMEOUT_MS, free)
    probe.once('connect', taken)
    probe.once('error', free)
  })
}

/**
 * 依赖就位检测：插件目录声明了 package.json 依赖却没有可解析的 node_modules。
 * workspace 成员的依赖装在持锁的仓库根（向上 4 级与锁文件检测层级一致）。
 */
function dependenciesInstalled(sourcePath: string, start: DevCommandSpec): boolean {
  if (!existsSync(join(sourcePath, 'package.json'))) return true
  let current: string | null = sourcePath
  for (let level = 0; level <= 4 && current; level++) {
    if (existsSync(join(current, 'node_modules'))) return true
    const parent = dirnameOf(current)
    if (parent === current) break
    current = parent
  }
  // raw 命令自带完整命令行；script 型（npm run dev）必须有 node_modules 才能执行。
  return start.kind === 'raw'
}

/** 只取父目录的纯计算，兼容 Windows 分隔符。 */
function dirnameOf(path: string): string {
  const index = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'))
  return index <= 0 ? '.' : path.slice(0, index)
}

/** 与 devCommandResolver 的锁文件名保持一致；这里只用于定位安装根目录。 */
const LOCKFILE_NAMES = ['pnpm-lock.yaml', 'yarn.lock', 'bun.lockb', 'bun.lock', 'package-lock.json', 'npm-shrinkwrap.json'] as const

/** 持锁的 workspace 根（向上 4 级）；找不到锁文件时退回插件目录本身。 */
function installRootOf(sourcePath: string): string {
  let current = sourcePath
  for (let level = 0; level <= 4; level++) {
    if (LOCKFILE_NAMES.some(name => existsSync(join(current, name)))) return current
    const parent = dirnameOf(current)
    if (parent === current) break
    current = parent
  }
  return sourcePath
}

/**
 * 新检出源码的依赖自动安装：在持锁目录执行 `<manager> install`。同一目录并发请求
 * 共享一次安装；成功后记住（后续直接跳过），失败不缓存——用户手动修复后重试会再试。
 */
function ensureDependenciesInstalled(pluginId: string, sourcePath: string, start: DevCommandSpec, launch: Launch): Promise<boolean> {
  if (dependenciesInstalled(sourcePath, start)) return Promise.resolve(true)
  const existing = installedRoots.get(sourcePath)
  if (existing) return existing
  const manager = start.manager ?? detectPackageManager(sourcePath)
  const installRoot = installRootOf(sourcePath)
  const attempt = (async (): Promise<boolean> => {
    emitLog(pluginId, 'info', `首次使用该源码目录，正在 ${installRoot} 执行 ${manager} install 安装依赖…`)
    logInfo('dev', `${pluginId}: auto install dependencies root=${installRoot} manager=${manager}`)
    const child = await spawnCommand(installRoot, buildSpawnCandidates(
      // raw 型直接执行 `npm install`（script 型会拼成 `npm run install`，仅当包声明了 install 脚本才有效）。
      { kind: 'raw', command: `${manager} install`, label: `${manager} install` }, []
    ), { ...process.env }, warn => emitLog(pluginId, 'warn', warn), {
      signal: launch.controller.signal,
      onChild: child => {
        const unregister = registerPluginProcess({
          pluginId, generation: launch.scope?.owner.generation, kind: 'development',
          getPid: () => child.pid,
          stop: () => { killTree(child) }
        })
        child.once('close', () => unregister())
      }
    })
    if (!child) return false
    pipeOutput(child, (level, text) => emitLog(pluginId, level, text))
    const exited = new Promise<number | null>(resolve => { child.once('close', () => resolve(child.exitCode)) })
    const timer = setTimeout(() => killTree(child), INSTALL_TIMEOUT_MS)
    timer.unref()
    const abort = () => killTree(child)
    launch.controller.signal.addEventListener('abort', abort, { once: true })
    try {
      const code = await exited
      if (launch.controller.signal.aborted) return false
      if (code === 0) {
        emitLog(pluginId, 'info', '依赖安装完成，正在启动开发服务…')
        return true
      }
      emitLog(pluginId, 'warn', `依赖安装未成功（退出码 ${code ?? 'unknown'}）；请在该目录手动运行 ${manager} install 后重试`)
      return false
    } finally {
      clearTimeout(timer)
      launch.controller.signal.removeEventListener('abort', abort)
    }
  })()
  void attempt.then(ok => {
    if (ok) installedRoots.set(sourcePath, attempt)
    else installedRoots.delete(sourcePath)
  }, () => installedRoots.delete(sourcePath))
  installedRoots.set(sourcePath, attempt)
  return attempt
}

async function pickFreePort(base: number, signal: AbortSignal): Promise<number | null> {
  for (let port = base + 1; port <= base + PORT_SCAN_RANGE && !signal.aborted; port++) {
    if (await canListen(port)) return port
  }
  return null
}

/** 确保开发服务在线；pending 在任何异步探测前发布，停止可取消整个启动过程。 */
export function ensureDevServer(pluginId: string, sourcePath: string, url: string, start: DevCommandSpec, options: DevServerEnsureOptions = {}): Promise<string | null> {
  const running = pending.get(pluginId)
  if (running) return waitForPending(running, options)
  const scope = getRuntimeScope(pluginId)
  const launch: Launch = {
    controller: new AbortController(), scope, promise: Promise.resolve(null), children: new Set(), finished: false, cancelRequested: false, detach: () => {},
    options, startedAt: performance.now(), queueMs: 0,
    reason: /^[a-z0-9_.-]{1,64}$/i.test(options.reason ?? '') ? options.reason! : 'prepare'
  }
  const abort = () => stopLaunch(launch)
  const detach = scope?.addDisposer(async () => {
    stopLaunch(launch)
    await Promise.all([...launch.children].map(waitForClose))
  })
  launch.detach = () => { scope?.signal.removeEventListener('abort', abort); detach?.() }
  scope?.signal.addEventListener('abort', abort, { once: true })
  options.signal?.addEventListener('abort', abort, { once: true })
  let outcome = 'failed'
  launch.promise = Promise.resolve().then(async () => {
    assertCurrent(launch)
    if (options.retry) lastFailedAt.delete(pluginId)
    // A cancelled prior preparation may settle before its owned process tree closes.
    // Do not mistake that retiring server for an external service or spawn a replacement.
    const retiring = [...managed.get(pluginId) ?? []].filter(server => cancelled(server.launch) || server.exited)
    await Promise.all(retiring.map(waitForClose))
    assertCurrent(launch)
    const servers = managed.get(pluginId)
    const ready = [...servers ?? []].find(server => server.ready && !server.exited && !server.closed && !cancelled(server.launch))
    if (ready && await matchesDevelopmentServer(ready.url, pluginId, launch.controller.signal)) {
      assertCurrent(launch)
      outcome = 'reused'
      return ready.url
    }
    assertCurrent(launch)
    if (await matchesDevelopmentServer(url, pluginId, launch.controller.signal)) {
      assertCurrent(launch)
      outcome = 'reused'
      return url
    }
    assertCurrent(launch)
    // Do not lose or replace an unconfirmed, still-retiring tree.
    if (managed.get(pluginId)?.size) return null
    const failedAt = lastFailedAt.get(pluginId)
    if (failedAt !== undefined && Date.now() - failedAt < RETRY_COOLDOWN_MS) { outcome = 'cooldown'; return null }
    const release = await acquireStartSlot(pluginId, launch)
    try {
      assertCurrent(launch)
      if (managed.get(pluginId)?.size) return null
      const latestFailure = lastFailedAt.get(pluginId)
      if (latestFailure !== undefined && Date.now() - latestFailure < RETRY_COOLDOWN_MS) { outcome = 'cooldown'; return null }
      const result = await launchAndWait(pluginId, sourcePath, url, start, launch)
      assertCurrent(launch)
      if (result) outcome = launch.children.size ? 'ready' : 'reused'
      return result
    } finally { release() }
  }).catch(error => {
    const wasCancelled = requestCancelled(launch) || error instanceof Error && error.name === 'AbortError'
    stopLaunch(launch, wasCancelled)
    if (wasCancelled) { outcome = 'cancelled'; throw cancellationError() }
    emitLog(pluginId, 'warn', `开发服务启动失败：${String(error)}`)
    if (error instanceof DevServerRetirementError) throw error
    return null
  }).finally(() => {
    // Request guards describe this preparation only; live services retain their scope owner.
    options.signal?.removeEventListener('abort', abort)
    launch.finished = true
    launch.options = {}
    if (pending.get(pluginId) === launch) pending.delete(pluginId)
    if (!launch.children.size) launch.detach()
    logInfo('dev', `${pluginId}: dev server prepare reason=${launch.reason} outcome=${outcome} elapsedMs=${Math.round(performance.now() - launch.startedAt)} queueMs=${launch.queueMs} active=${activeStarts}/${MAX_CONCURRENT_STARTS} queued=${startQueue.length} spawnedTotal=${spawnedTotal}`)
  })
  pending.set(pluginId, launch)
  return launch.promise
}

export function forgetDevServer(pluginId: string): void {
  stopDevServer(pluginId)
  lastFailedAt.delete(pluginId)
}

export function stopDevServer(pluginId: string): void {
  const launch = pending.get(pluginId)
  if (launch) stopLaunch(launch)
  for (const server of managed.get(pluginId) ?? []) { stopLaunch(server.launch); killTree(server.child) }
  if (managed.has(pluginId)) logInfo('dev', `${pluginId}: dev server stopping`)
}

/** A scope-less initial launch also needs an explicit, bounded real-close barrier. */
export async function stopDevServerAndWait(pluginId: string): Promise<void> {
  stopDevServer(pluginId)
  const launch = pending.get(pluginId)
  const servers = [...managed.get(pluginId) ?? []]
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    await Promise.race([
      Promise.allSettled([launch?.promise]).then(async () => {
        const all = new Set([...servers, ...managed.get(pluginId) ?? []])
        await Promise.all([...all].map(server => server.close))
      }),
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('development process tree exit not confirmed')), 1500) })
    ])
  } finally { if (timer) clearTimeout(timer) }
}

export function stopAllDevServers(): void {
  for (const pluginId of new Set([...pending.keys(), ...managed.keys()])) stopDevServer(pluginId)
}
