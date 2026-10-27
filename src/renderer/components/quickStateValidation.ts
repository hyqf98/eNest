import type { QuickStateSnapshot } from '@shared/types/quickTheme'

const MAX_BYTES = 128 * 1_024
const MAX_NODES = 10_000
const UNSAFE_KEYS = new Set(['__proto__', 'constructor', 'prototype'])
const encoder = new TextEncoder()

/** Detach a bounded JSON document before asynchronous IPC or sandbox message delivery. */
export function readQuickStateValue(value: unknown): { value: unknown } | null {
  const seen = new Set<object>()
  const chunks: string[] = []
  let nodes = 0, bytes = 0
  const append = (text: string) => {
    if (text.length > MAX_BYTES) return false
    bytes += encoder.encode(text).byteLength
    if (bytes > MAX_BYTES) return false
    chunks.push(text)
    return true
  }
  const visit = (item: unknown, depth: number): boolean => {
    if (++nodes > MAX_NODES || depth > 20) return false
    if (item === null || typeof item === 'boolean') return append(JSON.stringify(item))
    if (typeof item === 'string') return item.length <= MAX_BYTES && append(JSON.stringify(item))
    if (typeof item === 'number') return Number.isFinite(item) && append(JSON.stringify(item))
    if (!item || typeof item !== 'object' || seen.has(item)) return false
    const array = Array.isArray(item)
    const prototype = Object.getPrototypeOf(item)
    const plainObject = prototype === null || Object.getPrototypeOf(prototype) === null
      && Object.getOwnPropertyDescriptor(prototype, 'constructor')?.value?.name === 'Object'
    if (!array && !plainObject) return false
    const keys = Reflect.ownKeys(item)
    if (array ? item.length >= MAX_NODES || keys.length !== item.length + 1 : keys.length >= MAX_NODES) return false
    seen.add(item)
    try {
      if (!append(array ? '[' : '{')) return false
      const count = array ? item.length : keys.length
      for (let index = 0; index < count; index++) {
        const key = array ? String(index) : keys[index]
        if (typeof key !== 'string' || UNSAFE_KEYS.has(key)) return false
        const descriptor = Object.getOwnPropertyDescriptor(item, key)
        if (!descriptor?.enumerable || !('value' in descriptor)) return false
        if (index && !append(',')) return false
        if (!array && (!append(JSON.stringify(key)) || !append(':'))) return false
        if (!visit(descriptor.value, depth + 1)) return false
      }
      return append(array ? ']' : '}')
    } finally { seen.delete(item) }
  }
  try {
    return visit(value, 0) ? { value: JSON.parse(chunks.join('')) as unknown } : null
  } catch { return null }
}

export function readQuickStateSnapshot(value: unknown): QuickStateSnapshot | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const input = value as Record<string, unknown>
  if (!Number.isSafeInteger(input.revision) || Number(input.revision) < 0) return null
  const parsed = readQuickStateValue(input.value)
  return parsed ? { revision: Number(input.revision), value: parsed.value } : null
}
