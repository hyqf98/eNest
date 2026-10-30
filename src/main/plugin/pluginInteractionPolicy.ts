import { AsyncLocalStorage } from 'node:async_hooks'
import { getRuntimeScope, type PluginRuntimeScope } from '@main/plugin/PluginRuntimeScope'

export type PluginInteractionErrorCode = 'needs-consent' | 'permission-denied' | 'interaction-required'

interface Policy {
  background: boolean
  activation?: 'command' | 'index-sync' | 'resident'
  resident: boolean
  interactiveUntil: number
  leases: Set<symbol>
  activations: Map<symbol, AbortSignal | undefined>
  epoch: number
  hostRpcs: number
  idle: Set<() => void>
}

const policies = new WeakMap<PluginRuntimeScope, Policy>()
const rpcContext = new AsyncLocalStorage<ReadonlyMap<PluginRuntimeScope, { epoch: number; interactiveUntil: number; signal?: AbortSignal }>>()
let nativeInteractions = 0

function policy(scope: PluginRuntimeScope): Policy {
  let value = policies.get(scope)
  if (!value) {
    value = { background: false, resident: false, interactiveUntil: 0, leases: new Set(), activations: new Map(), epoch: 0, hostRpcs: 0, idle: new Set() }
    policies.set(scope, value)
  }
  return value
}

function resolveScope(owner: PluginRuntimeScope | string): PluginRuntimeScope {
  const scope = typeof owner === 'string' ? getRuntimeScope(owner) : owner
  if (!scope?.isCurrent() || scope.isClosing || scope.signal.aborted) throw new Error('plugin runtime is closing or stale')
  return scope
}

export function interactionError(code: PluginInteractionErrorCode, message: string): Error & { code: PluginInteractionErrorCode } {
  return Object.assign(new Error(message), { code })
}

export function interactionErrorCode(error: unknown): PluginInteractionErrorCode | undefined {
  const code = error && typeof error === 'object' ? (error as { code?: unknown }).code : undefined
  return code === 'needs-consent' || code === 'permission-denied' || code === 'interaction-required' ? code : undefined
}

/** Runtime-wide, including manual requests and nested native-backend capabilities. */
export function acquireNonInteractive(scope: PluginRuntimeScope, _reason: string): () => void {
  resolveScope(scope)
  const value = policy(scope), token = Symbol('noninteractive')
  if (value.activations.size) throw Object.assign(new Error('Plugin activation is busy'), { code: 'busy' })
  // An idle index-only runtime may be reused for MCP, but never its running handler.
  if (value.activation === 'index-sync') value.activation = 'command'
  value.leases.add(token)
  value.epoch++
  return () => { if (value.leases.delete(token)) value.epoch++ }
}

/** Kept through cancellation until the plugin's actual handler ACK or runtime retirement. */
export function acquireActivation(scope: PluginRuntimeScope, signal?: AbortSignal): () => void {
  resolveScope(scope)
  const value = policy(scope), token = Symbol('activation')
  if (value.leases.size || value.activations.size) throw new Error('Plugin activation is busy')
  value.activations.set(token, signal)
  return () => { value.activations.delete(token) }
}

export function setBackgroundNonInteractive(scope: PluginRuntimeScope, enabled: boolean): void {
  const value = policy(scope)
  if (enabled) value.interactiveUntil = 0
  if (value.background !== enabled) { value.background = enabled; value.epoch++ }
}

/** Internal activation policy; neither plugins nor theme pages can grant this context. */
export function setActivationContext(scope: PluginRuntimeScope, context: 'command' | 'index-sync' | 'resident' | 'view'): void {
  const value = policy(scope)
  const next = context === 'view' ? undefined : context
  if (value.activation !== next) { value.activation = next; value.epoch++ }
}

export function isIndexSyncActivation(scope: PluginRuntimeScope): boolean { return policy(scope).activation === 'index-sync' }
export function hasNonInteractiveLease(scope: PluginRuntimeScope): boolean { return policy(scope).leases.size > 0 }

export function setResidentActivation(scope: PluginRuntimeScope, enabled: boolean): void {
  const value = policy(scope)
  if (value.resident !== enabled) { value.resident = enabled; value.epoch++ }
}

/** Restoration may create only a passive, non-capturing surface; MCP leases still win. */
export function isResidentActivation(scope: PluginRuntimeScope): boolean {
  const value = policy(scope)
  return scope.isCurrent() && !scope.isClosing && value.resident && !value.leases.size
}

/** Only a trusted native input receiver or a validated user command may call this. */
export function grantAuxiliaryInteraction(scope: PluginRuntimeScope, durationMs = 2000): () => void {
  resolveScope(scope)
  const value = policy(scope)
  if (value.leases.size || value.activation === 'index-sync') throw interactionError('interaction-required', 'Background execution cannot claim a user gesture')
  const until = Date.now() + Math.max(100, Math.min(60_000, durationMs))
  value.interactiveUntil = until
  return () => { if (value.interactiveUntil === until) value.interactiveUntil = 0 }
}

export function isNonInteractive(owner: PluginRuntimeScope | string): boolean {
  const scope = typeof owner === 'string' ? getRuntimeScope(owner) : owner
  if (!scope) return false
  const value = policy(scope)
  const captured = rpcContext.getStore()?.get(scope)
  const held = captured?.epoch === value.epoch && Date.now() < captured.interactiveUntil
  return value.leases.size > 0 || value.background && Date.now() >= value.interactiveUntil && !held
}

export function getInteractionEpoch(scope: PluginRuntimeScope): number { return policy(scope).epoch }

export function retireInteractionEpoch(scope: PluginRuntimeScope): void { policy(scope).epoch++ }

export function assertInteractionEpoch(scope: PluginRuntimeScope, epoch: number): void {
  resolveScope(scope)
  if (isNonInteractive(scope) || policy(scope).epoch !== epoch) {
    throw interactionError('interaction-required', 'This operation requires a fresh interactive user action')
  }
}

export function assertInteractive(owner: PluginRuntimeScope | string): void {
  const scope = resolveScope(owner)
  assertInteractionEpoch(scope, rpcContext.getStore()?.get(scope)?.epoch ?? getInteractionEpoch(scope))
}

export function trackHostRpc(scope: PluginRuntimeScope): () => void {
  const value = policy(scope)
  value.hostRpcs++
  let released = false
  return () => {
    if (released) return
    released = true
    if (--value.hostRpcs === 0) {
      for (const resolve of value.idle) resolve()
      value.idle.clear()
    }
  }
}

/** Preserve the entry epoch across awaits so an old request cannot display a late dialog. */
export async function runHostRpc<T>(scope: PluginRuntimeScope, action: () => T | Promise<T>): Promise<T> {
  const release = trackHostRpc(scope)
  const context = new Map(rpcContext.getStore())
  if (!context.has(scope)) context.set(scope, { epoch: getInteractionEpoch(scope), interactiveUntil: isNonInteractive(scope) ? 0 : Date.now() + 120_000,
    signal: policy(scope).activations.values().next().value })
  try { return await rpcContext.run(context, action) }
  finally { release() }
}

export function getHostRpcCount(scope: PluginRuntimeScope): number { return policy(scope).hostRpcs }

/** Native consent inherits the exact originating activation, not a later job on the same scope. */
export function getHostInteractionSignal(scope: PluginRuntimeScope): AbortSignal | undefined { return rpcContext.getStore()?.get(scope)?.signal }

export function whenHostRpcIdle(scope: PluginRuntimeScope): Promise<void> {
  const value = policy(scope)
  return value.hostRpcs === 0 ? Promise.resolve() : new Promise(resolve => { value.idle.add(resolve) })
}

export function hasNativeInteraction(): boolean { return nativeInteractions > 0 }

/** Track the real native promise, not an abort race that leaves the dialog on screen. */
export async function trackNativeInteraction<T>(pending: Promise<T>): Promise<T> {
  nativeInteractions++
  try { return await pending }
  finally { nativeInteractions-- }
}
