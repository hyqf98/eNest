import type { PluginRuntimeScope } from './PluginRuntimeScope'
import { allowPluginEndpoint } from './pluginSessionPolicy'
import { sampleProcessMemory, type ProcessMemorySample } from './pluginProcessMemory'
import { registerPluginProcess } from './pluginOwnedProcesses'
import { session } from 'electron'
import { PluginBackendCapabilities } from './pluginBackendCapabilities'

type Identity = { pid: number; startedAt: number; coarse?: true }
const MAX_RESOURCES = 128

function text(value: unknown, limit: number): string {
  if (typeof value !== 'string' || !value || value.length > limit || value.includes('\0')) throw new Error('Invalid backend control argument')
  return value
}

function coarseTimestamp(row: ProcessMemorySample): boolean {
  return process.platform === 'darwin' && row.metric === 'resident' && row.startedAt % 1000 === 0
}

function identityOf(row: ProcessMemorySample): Identity {
  return { pid: row.pid, startedAt: row.startedAt, ...(coarseTimestamp(row) ? { coarse: true as const } : {}) }
}

function exitedOrReused(identity: Identity, rows: ProcessMemorySample[]): boolean {
  const row = rows.find(row => row.pid === identity.pid)
  if (row?.startedAt) {
    // macOS native timestamps have millisecond precision; ps fallback has seconds.
    // A precision change within that second proves neither exit nor PID reuse.
    if ((identity.coarse || coarseTimestamp(row)) && Math.floor(row.startedAt / 1000) === Math.floor(identity.startedAt / 1000)) return false
    return row.startedAt !== identity.startedAt
  }
  // A denied/unavailable identity sample is not evidence that the process exited.
  try { process.kill(identity.pid, 0); return false }
  catch (error) { return (error as NodeJS.ErrnoException).code === 'ESRCH' }
}

/** PID reuse must not turn process discovery into authority over an unrelated process. */
export function descendantsOf(rows: ProcessMemorySample[], roots: Identity[]): Identity[] {
  const byPid = new Map(rows.map(row => [row.pid, row]))
  const owned = new Map(roots.filter(root => {
    const row = byPid.get(root.pid)
    return row && root.startedAt > 0 && !root.coarse && !coarseTimestamp(row) && row.startedAt === root.startedAt
  }).map(root => [root.pid, root]))
  let changed = true
  while (changed) {
    changed = false
    for (const row of rows) {
      const parent = owned.get(row.parentPid)
      if (parent && !coarseTimestamp(row) && row.startedAt >= parent.startedAt && !owned.has(row.pid)) {
        owned.set(row.pid, identityOf(row)); changed = true
      }
    }
  }
  return [...owned.values()]
}

/** Generic capabilities for an explicitly authorized native backend, scoped to one incarnation. */
export class PluginBackendControl {
  private activities = new Map<string, () => void>()
  private endpoints = new Map<string, { release: () => void; pid: number }>()
  private children = new Map<number, Identity>()
  private registrations = new Map<number, () => void>()
  private root?: Identity
  private closing = false
  private captureFlight?: Promise<void>
  private captureRootPid?: number
  private capabilities: PluginBackendCapabilities

  constructor(private scope: PluginRuntimeScope, private getPid: () => number | undefined, private shutdown?: () => Promise<void>) {
    this.capabilities = new PluginBackendCapabilities(scope, () => this.assertCurrent())
  }

  private assertCurrent(): void {
    if (this.closing || !this.scope.isCurrent() || this.scope.isClosing || this.scope.signal.aborted) throw new Error('Plugin backend is closing')
  }

  private async snapshot(): Promise<ProcessMemorySample[]> {
    const pid = this.getPid()
    const rows = await sampleProcessMemory([...new Set([...(pid ? [pid] : []), ...this.children.keys()])])
    if (pid && this.getPid() === pid) {
      const row = rows.find(row => row.pid === pid)
      // The UtilityProcess is still live, so a later precise root sample can
      // replace its initial fallback metadata without adopting a discovered PID.
      if (row?.startedAt && (!this.root || this.root.coarse && !coarseTimestamp(row))) this.root = identityOf(row)
    }
    return rows
  }

  private async track(value: unknown): Promise<number> {
    if (!Number.isSafeInteger(value) || Number(value) <= 0 || value === this.getPid()) throw new Error('Invalid backend child PID')
    if (this.children.size >= MAX_RESOURCES && !this.children.has(Number(value))) throw new Error('Backend child limit reached')
    const rows = await this.snapshot()
    this.assertCurrent()
    const child = descendantsOf(rows, this.root ? [this.root] : []).find(row => row.pid === value)
    if (!child) throw new Error('PID is not a live descendant of this backend')
    if (this.children.size >= MAX_RESOURCES && !this.children.has(child.pid)) throw new Error('Backend child limit reached')
    this.children.set(child.pid, child)
    this.register(child)
    return child.pid
  }

  private register(child: Identity): void {
    if (this.registrations.has(child.pid)) return
    this.registrations.set(child.pid, registerPluginProcess({ pluginId: this.scope.owner.pluginId,
      generation: this.scope.owner.generation, kind: 'runtime', getPid: () => this.children.has(child.pid) ? child.pid : undefined,
      stop: () => this.shutdown?.() }))
  }

  private async endpointOwner(value: unknown): Promise<number> {
    if (value !== this.getPid()) return this.track(value)
    const pid = this.getPid()
    const rows = await this.snapshot()
    this.assertCurrent()
    const row = rows.find(row => row.pid === pid)
    if (!pid || this.getPid() !== pid || !row?.startedAt || coarseTimestamp(row)
      || this.root?.pid !== pid || this.root.startedAt !== row.startedAt) throw new Error('Backend endpoint owner not confirmed')
    return pid
  }

  private forget(pid: number): void {
    this.children.delete(pid); this.registrations.get(pid)?.(); this.registrations.delete(pid)
  }

  async request(method: unknown, input: unknown): Promise<unknown> {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Invalid backend control parameters')
    const params = input as Record<string, unknown>
    // Releases are idempotent and remain available during graceful shutdown.
    if (method === 'activity.release') {
      const token = text(params.token, 128)
      this.activities.get(token)?.(); this.activities.delete(token); return
    }
    if (method === 'endpoint.revoke') {
      const token = text(params.token, 128)
      this.endpoints.get(token)?.release(); this.endpoints.delete(token); return
    }
    if (method === 'process.untrack') {
      const pid = Number(params.pid), identity = this.children.get(pid)
      if (!identity) return
      // A backend cannot abandon a live child by claiming that it exited.
      const rows = await sampleProcessMemory([pid])
      if (this.children.get(pid) !== identity || !exitedOrReused(identity, rows)) return
      this.forget(pid)
      for (const [token, endpoint] of this.endpoints) if (endpoint.pid === pid) { endpoint.release(); this.endpoints.delete(token) }
      return
    }
    if (this.capabilities.supports(method)) return this.capabilities.request(method, params)
    this.assertCurrent()
    if (method === 'process.track') { await this.track(params.pid); return }
    if (method === 'network.resolveProxy') {
      const url = new URL(text(params.url, 8192))
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('Invalid backend network URL')
      const proxy = await session.defaultSession.resolveProxy(url.href)
      this.assertCurrent()
      return { proxy }
    }
    const token = text(params.token, 128)
    if (method === 'activity.acquire') {
      if (this.activities.has(token)) return
      if (this.activities.size >= MAX_RESOURCES) throw new Error('Backend activity limit reached')
      this.activities.set(token, this.scope.acquireActivity(`backend:${text(params.reason, 160)}`)); return
    }
    if (method === 'endpoint.allow') {
      if (this.endpoints.has(token)) throw new Error('Backend endpoint token already exists')
      if (this.endpoints.size >= 32) throw new Error('Backend endpoint limit reached')
      const url = new URL(text(params.url, 2048))
      const kind = params.kind
      if (!(kind === 'subFrame' && url.protocol === 'http:' || kind === 'webSocket' && url.protocol === 'ws:')
        || !url.port || !['127.0.0.1', 'localhost'].includes(url.hostname) || url.username || url.password || url.hash) throw new Error('Backend endpoint must be an explicit HTTP/WebSocket loopback port')
      const pid = await this.endpointOwner(params.pid)
      this.assertCurrent()
      if (this.endpoints.has(token) || this.endpoints.size >= 32) throw new Error('Backend endpoint limit reached')
      this.endpoints.set(token, { pid, release: allowPluginEndpoint(this.scope.owner.pluginId, url.href, kind) }); return
    }
    throw new Error('Unsupported backend host control')
  }

  /** Capture before requesting shutdown, while the original parent chain still exists. */
  beginClose(requireLivePid = false): Promise<void> {
    this.closing = true
    this.capabilities.beginClose()
    for (const endpoint of this.endpoints.values()) endpoint.release()
    this.endpoints.clear()
    const pid = this.getPid()
    if (requireLivePid && !pid) return Promise.reject(new Error('Plugin backend spawn not confirmed'))
    // Keep this requirement across failed attempts, even if the parent exits.
    // An unavailable first scan must not become proof that it had no children.
    this.captureRootPid ??= pid
    return this.captureFlight ??= this.snapshot().then(rows => {
      if (this.captureRootPid) {
        const row = rows.find(row => row.pid === this.captureRootPid)
        if (!this.root || this.root.pid !== this.captureRootPid || this.root.coarse
          || !row?.startedAt || coarseTimestamp(row) || row.startedAt !== this.root.startedAt) {
          throw new Error('Backend descendant capture not confirmed')
        }
      }
      const captured = descendantsOf(rows, [...(this.root ? [this.root] : []), ...this.children.values()])
      const capturedPids = new Set(captured.map(child => child.pid))
      if (rows.some(row => capturedPids.has(row.parentPid) && (!row.startedAt || coarseTimestamp(row)))) {
        throw new Error('Backend descendant capture not confirmed')
      }
      for (const child of captured) {
        if (child.pid !== this.root?.pid) { this.children.set(child.pid, child); this.register(child) }
      }
    }).catch(error => { this.captureFlight = undefined; throw error })
  }

  async stopChildren(signal: NodeJS.Signals): Promise<void> {
    await this.beginClose()
    if (!this.children.size) return
    const rows = await sampleProcessMemory([...this.children.keys()])
    const live = descendantsOf(rows, [...this.children.values()])
    for (const [pid, identity] of this.children) if (exitedOrReused(identity, rows)) this.forget(pid)
    for (const child of live.reverse()) {
      this.children.set(child.pid, child)
      this.register(child)
      try { process.kill(child.pid, signal) } catch { /* Exit races are expected. */ }
    }
  }

  async confirmChildrenExited(): Promise<void> {
    await this.beginClose()
    if (!this.children.size) return
    const rows = await sampleProcessMemory([...this.children.keys()])
    for (const [pid, identity] of this.children) if (exitedOrReused(identity, rows)) this.forget(pid)
    if (this.children.size) throw new Error('Backend descendant exit not confirmed')
  }

  async dispose(): Promise<void> {
    await this.capabilities.dispose()
    for (const release of this.activities.values()) release()
    this.activities.clear()
    for (const endpoint of this.endpoints.values()) endpoint.release()
    this.endpoints.clear()
  }
}
