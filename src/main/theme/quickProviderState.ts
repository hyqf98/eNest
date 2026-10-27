import { createHmac, randomBytes } from 'node:crypto'
import { types } from 'node:util'
import type { QuickStateSnapshot } from '@shared/types/quickTheme'

const STATE_PREFIX = '__enest.quick.provider-state.v1.'
const SECRET_KEY = '__enest.quick.identity-secret.v1'
const MAX_JSON_BYTES = 128 * 1024
const MAX_JSON_DEPTH = 20
const MAX_JSON_NODES = 10_000
const MAX_OWNER_BYTES = 4096
const MAX_IDENTITY_BATCH = 8192
const UNSAFE_KEYS = new Set(['__proto__', 'constructor', 'prototype'])

export interface QuickProviderStateOwner {
  source: string
  packId: string
}

export interface QuickProviderStateStorage {
  get(key: string): string | null
  /** A single record must be committed atomically or throw. */
  set(key: string, value: string): void
  deletePrefix?(prefix: string): void
}

export class QuickStateConflictError extends Error {
  constructor(readonly currentRevision: number) {
    super('Quick provider state revision conflict')
    this.name = 'QuickStateConflictError'
  }
}

function encodeOwnerPart(value: string): string {
  if (typeof value !== 'string' || !value || Buffer.byteLength(value, 'utf8') > MAX_OWNER_BYTES) {
    throw new TypeError('Invalid Quick provider owner')
  }
  // Preserve every code unit, including lone surrogates, without delimiter collisions.
  return Buffer.from(value, 'utf16le').toString('base64url')
}

function sourcePrefix(source: string): string {
  return `${STATE_PREFIX}${encodeOwnerPart(source)}.`
}

function stateKey(owner: QuickProviderStateOwner): string {
  if (!owner || typeof owner !== 'object') throw new TypeError('Invalid Quick provider owner')
  return `${sourcePrefix(owner.source)}${encodeOwnerPart(owner.packId)}`
}

/** Serialize data properties only: JSON.stringify must never invoke provider-authored code. */
function encodeJson(value: unknown): string {
  const chunks: string[] = []
  const ancestors = new Set<object>()
  let bytes = 0
  let nodes = 0
  const append = (text: string): void => {
    bytes += Buffer.byteLength(text, 'utf8')
    if (bytes > MAX_JSON_BYTES) throw new RangeError('Quick provider state exceeds the JSON byte limit')
    chunks.push(text)
  }
  const string = (text: string): string => {
    if (Buffer.byteLength(text, 'utf8') > MAX_JSON_BYTES) {
      throw new RangeError('Quick provider state exceeds the JSON byte limit')
    }
    return JSON.stringify(text)
  }
  const visit = (input: unknown, depth: number): void => {
    if (depth > MAX_JSON_DEPTH) throw new RangeError('Quick provider state exceeds the JSON depth limit')
    if (++nodes > MAX_JSON_NODES) throw new RangeError('Quick provider state exceeds the JSON node limit')
    if (input === null) { append('null'); return }
    if (typeof input === 'boolean') { append(input ? 'true' : 'false'); return }
    if (typeof input === 'string') { append(string(input)); return }
    if (typeof input === 'number' && Number.isFinite(input)) { append(JSON.stringify(input)); return }
    if (typeof input !== 'object') throw new TypeError('Quick provider state must contain JSON values only')
    if (types.isProxy(input)) throw new TypeError('Quick provider state must contain plain JSON containers only')
    if (ancestors.has(input)) throw new TypeError('Quick provider state must not contain cycles')

    const array = Array.isArray(input)
    const prototype = Object.getPrototypeOf(input)
    if (array ? prototype !== Array.prototype : prototype !== Object.prototype && prototype !== null) {
      throw new TypeError('Quick provider state must contain plain JSON containers only')
    }
    const keys = Reflect.ownKeys(input)
    ancestors.add(input)
    try {
      if (array) {
        if (input.length >= MAX_JSON_NODES || keys.length !== input.length + 1) {
          throw new TypeError('Quick provider state arrays must be dense JSON arrays')
        }
        append('[')
        for (let index = 0; index < input.length; index++) {
          const descriptor = Object.getOwnPropertyDescriptor(input, String(index))
          if (!descriptor?.enumerable || !('value' in descriptor)) {
            throw new TypeError('Quick provider state must contain data properties only')
          }
          if (index) append(',')
          visit(descriptor.value, depth + 1)
        }
        append(']')
      } else {
        if (keys.length >= MAX_JSON_NODES) throw new RangeError('Quick provider state exceeds the JSON node limit')
        append('{')
        for (let index = 0; index < keys.length; index++) {
          const key = keys[index]
          if (typeof key !== 'string' || UNSAFE_KEYS.has(key)) {
            throw new TypeError('Quick provider state contains an invalid object key')
          }
          const descriptor = Object.getOwnPropertyDescriptor(input, key)
          if (!descriptor?.enumerable || !('value' in descriptor)) {
            throw new TypeError('Quick provider state must contain data properties only')
          }
          if (index) append(',')
          append(string(key)); append(':')
          visit(descriptor.value, depth + 1)
        }
        append('}')
      }
    } finally {
      ancestors.delete(input)
    }
  }
  visit(value, 0)
  return chunks.join('')
}

function decodeState(raw: string | null): QuickStateSnapshot {
  if (raw === null) return { revision: 0, value: null }
  try {
    if (typeof raw !== 'string' || Buffer.byteLength(raw, 'utf8') > MAX_JSON_BYTES) throw new Error()
    const record: unknown = JSON.parse(raw)
    if (!record || typeof record !== 'object' || Array.isArray(record)) throw new Error()
    const state = record as Record<string, unknown>
    if (Object.keys(state).length !== 2 || !Object.hasOwn(state, 'revision') || !Object.hasOwn(state, 'value') ||
        !Number.isSafeInteger(state.revision) || (state.revision as number) < 0) throw new Error()
    encodeJson(state.value)
    return { revision: state.revision as number, value: state.value }
  } catch {
    throw new Error('Quick provider state is invalid')
  }
}

/** Owners are selected by the native caller; renderer input must never select this namespace. */
export class QuickProviderStateStore {
  #storage: QuickProviderStateStorage
  #identitySecret: Buffer | null = null

  constructor(storage: QuickProviderStateStorage) {
    this.#storage = storage
  }

  read(owner: QuickProviderStateOwner): QuickStateSnapshot {
    return this.#readKey(stateKey(owner))
  }

  write(owner: QuickProviderStateOwner, expectedRevision: number, value: unknown): QuickStateSnapshot {
    const key = stateKey(owner)
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) {
      throw new TypeError('Invalid Quick provider state revision')
    }
    const json = encodeJson(value)
    const current = this.#readKey(key)
    if (current.revision !== expectedRevision) throw new QuickStateConflictError(current.revision)
    if (current.revision === Number.MAX_SAFE_INTEGER) throw new RangeError('Quick provider state revision exhausted')
    const revision = current.revision + 1
    const record = `{"revision":${revision},"value":${json}}`
    if (Buffer.byteLength(record, 'utf8') > MAX_JSON_BYTES) {
      throw new RangeError('Quick provider state exceeds the JSON byte limit')
    }
    const snapshot: QuickStateSnapshot = { revision, value: JSON.parse(json) }
    try { this.#storage.set(key, record) } catch { throw new Error('Quick provider state could not be written') }
    return snapshot
  }

  encodeIdentities(identities: string[]): string[] {
    if (!Array.isArray(identities) || identities.length > MAX_IDENTITY_BATCH) {
      throw new TypeError('Invalid Quick identity batch')
    }
    for (let index = 0; index < identities.length; index++) {
      if (typeof identities[index] !== 'string') throw new TypeError('Invalid Quick identity batch')
    }
    if (!identities.length) return []
    const secret = this.#getIdentitySecret()
    return identities.map(identity => `qid_${createHmac('sha256', secret)
      .update('enest.quick.catalog-identity.v1\0')
      .update(Buffer.from(identity, 'utf16le'))
      .digest('base64url')}`)
  }

  removeSource(source: string): void {
    const prefix = sourcePrefix(source)
    if (!this.#storage.deletePrefix) throw new Error('Quick provider state removal is unavailable')
    try { this.#storage.deletePrefix(prefix) } catch { throw new Error('Quick provider state could not be removed') }
  }

  #readKey(key: string): QuickStateSnapshot {
    let raw: string | null
    try { raw = this.#storage.get(key) } catch { throw new Error('Quick provider state could not be read') }
    return decodeState(raw)
  }

  #getIdentitySecret(): Buffer {
    if (this.#identitySecret) return this.#identitySecret
    let stored: string | null
    try { stored = this.#storage.get(SECRET_KEY) } catch { throw new Error('Quick identity secret could not be read') }
    if (stored !== null) {
      if (typeof stored !== 'string' || !/^[a-f0-9]{64}$/.test(stored)) throw new Error('Quick identity secret is invalid')
      this.#identitySecret = Buffer.from(stored, 'hex')
    } else {
      const secret = randomBytes(32)
      try { this.#storage.set(SECRET_KEY, secret.toString('hex')) } catch { throw new Error('Quick identity secret could not be written') }
      this.#identitySecret = secret
    }
    return this.#identitySecret
  }
}
