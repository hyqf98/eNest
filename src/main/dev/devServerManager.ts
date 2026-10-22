/**
 * Dev server 自动拉起与进程回收。
 * 自建进程从 spawn 返回起即登记；用户手动启动的服务只复用、不接管。
 */
import { createServer } from 'node:net'
import type { ChildProcess } from 'node:child_process'
import { net } from 'electron'
import { sendShellEvent } from '@main/window/createShellWindow'
import { logInfo } from '@main/logs/logService'
import { getRuntimeScope, type PluginRuntimeScope } from '@main/plugin/PluginRuntimeScope'
import { registerPluginProcess } from '@main/plugin/pluginOwnedProcesses'
import type { DevCommandSpec, PluginManifest } from '@shared/types/plugin'
import { buildSpawnCandidates, formatPortArgs, killTree, pipeOutput, spawnCommand } from './devSpawn'

const READY_TIMEOUT_MS = 20_000
const POLL_INTERVAL_MS = 500
/** 拉起失败后的冷却期：避免 watcher 触发的每次重载都重新等待一次就绪超时 */
const RETRY_COOLDOWN_MS = 60_000
/** 声明端口被占时向上尝试的端口数 */
const PORT_SCAN_RANGE = 32

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
  detach: () => void
}
const managed = new Map<string, Set<ManagedServer>>()
const pending = new Map<string, Launch>()
const lastFailedAt = new Map<string, number>()
/** Only launches attempted by the host are resumable; external servers remain external. */
const recipes = new Map<string, { sourcePath: string; url: string; start: DevCommandSpec }>()
const resumes = new Map<string, { cancelled: boolean; promise: Promise<string | null> }>()

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

function cancelled(launch: Launch): boolean {
  return launch.controller.signal.aborted || !!launch.scope && (!launch.scope.isCurrent() || launch.scope.signal.aborted)
}

function stopLaunch(launch: Launch): void {
  launch.controller.abort()
  for (const server of launch.children) killTree(server.child)
}

async function waitForClose(server: ManagedServer): Promise<void> {
  if (server.closed) return
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    await Promise.race([server.close, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('development process tree exit not confirmed')), 1500) })])
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
  child.once('spawn', () => { spawned = true; if (cancelled(launch)) killTree(child) })
  child.once('exit', () => { server.exited = true })
  child.once('error', () => {
    // A spawn failure owns no OS process. A post-spawn error still needs real exit/close.
    if (!spawned && child.pid === undefined) finished()
    else stopLaunch(launch)
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
  const recipeStart = start
  let targetUrl = declaredUrl
  let extraArgs: string[] = []
  const declared = new URL(declaredUrl)
  const declaredPort = Number(declared.port || (declared.protocol === 'https:' ? 443 : 80))
  let targetPort = declaredPort
  if (!await canListen(declaredPort)) {
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
  emitLog(pluginId, 'info', `开发服务未运行，正在启动 ${start.label} …`)
  recipes.set(pluginId, { sourcePath, url: declaredUrl, start: recipeStart })
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
    await pause(launch.controller.signal)
    if (cancelled(launch)) return null
    if (server.exited || server.closed || child.exitCode !== null || child.signalCode !== null) {
      emitLog(pluginId, 'warn', '开发服务主进程已退出（端口被占用或依赖未安装？）；后代仍需等待管道关闭确认')
      stopLaunch(launch)
      lastFailedAt.set(pluginId, Date.now())
      return null
    }
    const ready = await matchesDevelopmentServer(targetUrl, pluginId, launch.controller.signal)
    if (cancelled(launch)) return null
    if (ready && !server.exited && !server.closed) {
      server.ready = true
      lastFailedAt.delete(pluginId)
      logInfo('dev', `${pluginId}: dev server started pid=${child.pid} url=${targetUrl}`)
      emitLog(pluginId, 'info', `开发服务已就绪 ${targetUrl}，框架 HMR 生效`)
      return targetUrl
    }
  }
  if (!cancelled(launch)) {
    emitLog(pluginId, 'warn', `开发服务 ${READY_TIMEOUT_MS / 1000}s 内未就绪，已停止并回退；${RETRY_COOLDOWN_MS / 1000}s 内不再自动重试`)
    lastFailedAt.set(pluginId, Date.now())
  }
  stopLaunch(launch)
  return null
}

/** 端口当前无监听者即可绑定（插件 dev 脚本固定 --host 127.0.0.1）。 */
function canListen(port: number): Promise<boolean> {
  return new Promise(resolve => {
    const probe = createServer()
    probe.unref()
    probe.once('error', () => resolve(false))
    probe.listen(port, '127.0.0.1', () => probe.close(() => resolve(true)))
  })
}

async function pickFreePort(base: number, signal: AbortSignal): Promise<number | null> {
  for (let port = base + 1; port <= base + PORT_SCAN_RANGE && !signal.aborted; port++) {
    if (await canListen(port)) return port
  }
  return null
}

/** 确保开发服务在线；pending 在任何异步探测前发布，停止可取消整个启动过程。 */
export function ensureDevServer(pluginId: string, sourcePath: string, url: string, start: DevCommandSpec): Promise<string | null> {
  const running = pending.get(pluginId)
  if (running) return running.promise
  const scope = getRuntimeScope(pluginId)
  const launch: Launch = { controller: new AbortController(), scope, promise: Promise.resolve(null), children: new Set(), finished: false, detach: () => {} }
  const abort = () => stopLaunch(launch)
  const detach = scope?.addDisposer(async () => {
    stopLaunch(launch)
    await Promise.all([...launch.children].map(waitForClose))
  })
  launch.detach = () => { scope?.signal.removeEventListener('abort', abort); detach?.() }
  scope?.signal.addEventListener('abort', abort, { once: true })
  launch.promise = Promise.resolve().then(async () => {
    if (cancelled(launch)) return null
    const servers = managed.get(pluginId)
    const ready = [...servers ?? []].find(server => server.ready && !server.exited && !server.closed && !cancelled(server.launch))
    if (ready && await matchesDevelopmentServer(ready.url, pluginId, launch.controller.signal)) return cancelled(launch) ? null : ready.url
    if (await matchesDevelopmentServer(url, pluginId, launch.controller.signal)) return cancelled(launch) ? null : url
    if (cancelled(launch)) return null
    // Do not lose or replace an unconfirmed, still-retiring tree.
    if (managed.get(pluginId)?.size) return null
    const failedAt = lastFailedAt.get(pluginId)
    if (failedAt !== undefined && Date.now() - failedAt < RETRY_COOLDOWN_MS) return null
    return launchAndWait(pluginId, sourcePath, url, start, launch)
  }).catch(error => {
    stopLaunch(launch)
    emitLog(pluginId, 'warn', `开发服务启动失败：${String(error)}`)
    return null
  }).finally(() => {
    launch.finished = true
    if (pending.get(pluginId) === launch) pending.delete(pluginId)
    if (!launch.children.size) launch.detach()
  })
  pending.set(pluginId, launch)
  return launch.promise
}

/** Reopen only previously host-managed development services, never take over external ones. */
export function resumeDevServer(pluginId: string): Promise<string | null> {
  const existing = resumes.get(pluginId)
  if (existing) return existing.promise
  if (!recipes.has(pluginId)) return Promise.resolve(null)
  const resume = { cancelled: false, promise: Promise.resolve<string | null>(null) }
  resume.promise = Promise.resolve().then(async () => {
    const launch = pending.get(pluginId)
    if (launch && cancelled(launch)) await launch.promise
    if (resume.cancelled) throw new Error('development service resume cancelled')
    const retiring = [...managed.get(pluginId) ?? []].filter(server => cancelled(server.launch) || server.exited)
    await Promise.all(retiring.map(waitForClose))
    if (resume.cancelled) throw new Error('development service resume cancelled')
    const recipe = recipes.get(pluginId)
    if (!recipe) return null
    lastFailedAt.delete(pluginId)
    const url = await ensureDevServer(pluginId, recipe.sourcePath, recipe.url, recipe.start)
    if (resume.cancelled || !url) throw new Error('managed development server could not be resumed')
    return url
  }).finally(() => { if (resumes.get(pluginId) === resume) resumes.delete(pluginId) })
  resumes.set(pluginId, resume)
  return resume.promise
}

export function forgetDevServer(pluginId: string): void {
  stopDevServer(pluginId)
  recipes.delete(pluginId)
}

export function stopDevServer(pluginId: string): void {
  const resume = resumes.get(pluginId)
  if (resume) resume.cancelled = true
  const launch = pending.get(pluginId)
  if (launch) stopLaunch(launch)
  for (const server of managed.get(pluginId) ?? []) { stopLaunch(server.launch); killTree(server.child) }
  lastFailedAt.delete(pluginId)
  if (managed.has(pluginId)) logInfo('dev', `${pluginId}: dev server stopping`)
}

/** A scope-less initial launch also needs an explicit, bounded real-close barrier. */
export async function stopDevServerAndWait(pluginId: string): Promise<void> {
  stopDevServer(pluginId)
  const launch = pending.get(pluginId)
  const resume = resumes.get(pluginId)
  const servers = [...managed.get(pluginId) ?? []]
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    await Promise.race([
      Promise.allSettled([launch?.promise, resume?.promise]).then(async () => {
        const all = new Set([...servers, ...managed.get(pluginId) ?? []])
        await Promise.all([...all].map(server => server.close))
      }),
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('development process tree exit not confirmed')), 1500) })
    ])
  } finally { if (timer) clearTimeout(timer) }
}

export function stopAllDevServers(): void {
  for (const pluginId of new Set([...pending.keys(), ...managed.keys(), ...resumes.keys()])) stopDevServer(pluginId)
}
