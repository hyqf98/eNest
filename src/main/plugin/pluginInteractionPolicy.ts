import { AsyncLocalStorage } from 'node:async_hooks'
import { getRuntimeScope, type PluginRuntimeScope } from '@main/plugin/PluginRuntimeScope'

export type PluginInteractionErrorCode = 'needs-consent' | 'permission-denied' | 'interaction-required'

interface Policy {
  background: boolean
  leases: Set<symbol>
  epoch: number
  hostRpcs: number
  idle: Set<() => void>
}

const policies = new WeakMap<PluginRuntimeScope, Policy>()
const rpcContext = new AsyncLocalStorage<ReadonlyMap<PluginRuntimeScope, number>>()
let nativeInteractions = 0

function policy(scope: PluginRuntimeScope): Policy {
  let value = policies.get(scope)
  if (!value) {
    value = { background: false, leases: new Set(), epoch: 0, hostRpcs: 0, idle: new Set() }
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
  value.leases.add(token)
  value.epoch++
  return () => { if (value.leases.delete(token)) value.epoch++ }
}

export function setBackgroundNonInteractive(scope: PluginRuntimeScope, enabled: boolean): void {
  const value = policy(scope)
  if (value.background !== enabled) { value.background = enabled; value.epoch++ }
}

export function isNonInteractive(owner: PluginRuntimeScope | string): boolean {
  const scope = typeof owner === 'string' ? getRuntimeScope(owner) : owner
  if (!scope) return false
  const value = policy(scope)
  return value.background || value.leases.size > 0
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
  assertInteractionEpoch(scope, rpcContext.getStore()?.get(scope) ?? getInteractionEpoch(scope))
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
  if (!context.has(scope)) context.set(scope, getInteractionEpoch(scope))
  try { return await rpcContext.run(context, action) }
  finally { release() }
}

export function getHostRpcCount(scope: PluginRuntimeScope): number { return policy(scope).hostRpcs }

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
