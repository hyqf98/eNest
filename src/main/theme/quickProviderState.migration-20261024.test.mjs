import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import ts from 'typescript'

const compiled = ts.transpileModule(await readFile(new URL('./quickProviderState.ts', import.meta.url), 'utf8'), {
  reportDiagnostics: true,
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext }
})
assert.deepEqual(compiled.diagnostics?.filter(item => item.category === ts.DiagnosticCategory.Error) ?? [], [])
// Execute the complete current production class in this realm, without Electron or temporary files.
const { QuickProviderStateStore, QuickStateConflictError } = await import(
  `data:text/javascript;base64,${Buffer.from(compiled.outputText).toString('base64')}`
)
const OWNER = { source: 'fixture.theme', packId: 'default' }
const MAX_BYTES = 128 * 1024
const SECRET_KEY = '__enest.quick.identity-secret.v1'

function memoryStore(options = {}) {
  const data = new Map()
  const calls = { get: [], set: [], deletePrefix: [] }
  const failures = { get: false, set: false, deletePrefix: false }
  const storage = {
    get(key) {
      calls.get.push(key)
      if (failures.get) throw new Error(`private-get:${data.get(key)}`)
      return data.get(key) ?? null
    },
    set(key, value) {
      calls.set.push({ key, value })
      if (failures.set) throw new Error(`private-set:${value}`)
      data.set(key, value)
    },
    ...(!options.withoutRemoval && {
      deletePrefix(prefix) {
        calls.deletePrefix.push(prefix)
        if (failures.deletePrefix) throw new Error(`private-delete:${prefix}`)
        for (const key of data.keys()) if (key.startsWith(prefix)) data.delete(key)
      }
    })
  }
  return { data, calls, failures, storage, store: new QuickProviderStateStore(storage) }
}

function nested(depth) {
  let value = null
  for (let index = 0; index < depth; index++) value = [value]
  return value
}

test('missing state is revision zero and each successful CAS replaces one atomic provider record', () => {
  const { store, data, calls } = memoryStore()
  assert.deepEqual(store.read(OWNER), { revision: 0, value: null })
  assert.deepEqual(store.write(OWNER, 0, { enabled: true }), { revision: 1, value: { enabled: true } })
  assert.deepEqual(store.write(OWNER, 1, null), { revision: 2, value: null })
  assert.equal(data.size, 1)
  assert.equal(calls.set.length, 2)
  assert.equal(calls.set[0].key, calls.set[1].key)
  assert.deepEqual(JSON.parse(calls.set[1].value), { revision: 2, value: null })
})

test('CAS checks the backing record across store instances and never writes on conflict', () => {
  const { store, storage, calls } = memoryStore()
  const other = new QuickProviderStateStore(storage)
  store.write(OWNER, 0, 'first')
  assert.throws(() => other.write(OWNER, 0, 'stale'), error => {
    assert.ok(error instanceof QuickStateConflictError)
    assert.equal(error.currentRevision, 1)
    return true
  })
  assert.equal(calls.set.length, 1)
  assert.deepEqual(other.write(OWNER, 1, 'second'), { revision: 2, value: 'second' })
  assert.deepEqual(store.read(OWNER), { revision: 2, value: 'second' })
})

test('invalid and exhausted revisions never overflow or create records', () => {
  const { store, calls, data } = memoryStore()
  for (const revision of [-1, 0.1, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, '0', null]) {
    assert.throws(() => store.write(OWNER, revision, null), /Invalid Quick provider state revision/)
  }
  assert.equal(calls.set.length, 0)
  store.write(OWNER, 0, null)
  const key = calls.set[0].key
  data.set(key, JSON.stringify({ revision: Number.MAX_SAFE_INTEGER, value: null }))
  assert.equal(store.read(OWNER).revision, Number.MAX_SAFE_INTEGER)
  assert.throws(() => store.write(OWNER, Number.MAX_SAFE_INTEGER, 'overflow'), /revision exhausted/)
  assert.equal(calls.set.length, 1)
  assert.equal(store.read(OWNER).revision, Number.MAX_SAFE_INTEGER)
})

test('source and pack names are collision-safe, private namespaces even for unusual code units', () => {
  const { store, data } = memoryStore()
  const owners = [
    { source: 'a', packId: 'b.c' }, { source: 'a.b', packId: 'c' },
    { source: 'a', packId: 'b' }, { source: 'a-extra', packId: 'b' },
    { source: '/Users/private/theme', packId: 'default' },
    { source: '\ud800', packId: 'default' }, { source: '\ufffd', packId: 'default' }
  ]
  owners.forEach((owner, index) => store.write(owner, 0, index))
  assert.equal(data.size, owners.length)
  owners.forEach((owner, index) => assert.equal(store.read(owner).value, index))
  assert.equal([...data.keys()].some(key => key.includes('/Users/private/theme')), false)
})

test('invalid owner values cannot read, write, or remove another namespace', () => {
  const { store, calls } = memoryStore()
  const owners = [null, {}, { source: '', packId: 'x' }, { source: 'x', packId: '' },
    { source: 1, packId: 'x' }, { source: 'x', packId: null },
    { source: 'a'.repeat(4097), packId: 'x' }, { source: 'x', packId: '\u754c'.repeat(1366) }]
  for (const owner of owners) {
    assert.throws(() => store.read(owner), /Invalid Quick provider owner/)
    assert.throws(() => store.write(owner, 0, null), /Invalid Quick provider owner/)
  }
  assert.throws(() => store.removeSource(''), /Invalid Quick provider owner/)
  assert.deepEqual(calls, { get: [], set: [], deletePrefix: [] })
})

test('JSON data is copied at write and read boundaries, including null-prototype objects', () => {
  const { store } = memoryStore()
  const value = { nil: null, bool: false, number: 1.25, text: '\u754c', items: [true, -0],
    plain: Object.assign(Object.create(null), { safe: 'value' }) }
  const written = store.write(OWNER, 0, value)
  assert.deepEqual(written, { revision: 1, value: { nil: null, bool: false, number: 1.25,
    text: '\u754c', items: [true, 0], plain: { safe: 'value' } } })
  value.items.push('original mutation')
  written.value.items.push('returned mutation')
  const read = store.read(OWNER)
  assert.deepEqual(read.value.items, [true, 0])
  read.value.plain.safe = 'read mutation'
  assert.equal(store.read(OWNER).value.plain.safe, 'value')
})

test('non-JSON primitives and non-plain containers are rejected without persistence', () => {
  const { store, calls } = memoryStore()
  class Custom {}
  class CustomArray extends Array {}
  const values = [undefined, NaN, Infinity, -Infinity, 1n, Symbol('value'), () => null,
    new Date(), new Map(), new Set(), new Uint8Array([1]), /value/, new Custom(),
    new CustomArray(), new String('value'), new Number(1)]
  for (const value of values) assert.throws(() => store.write(OWNER, 0, value), /JSON/)
  assert.equal(calls.set.length, 0)
})

test('unsafe keys, sparse arrays, symbol keys, and extra array properties are rejected', () => {
  const { store, calls } = memoryStore()
  for (const key of ['__proto__', 'constructor', 'prototype']) {
    assert.throws(() => store.write(OWNER, 0, { nested: JSON.parse(`{"${key}":true}`) }), /invalid object key/)
  }
  const sparse = new Array(1)
  const withExtra = Object.assign([1], { extra: true })
  const withSymbol = { [Symbol('hidden')]: true }
  const nonEnumerable = Object.defineProperty({}, 'hidden', { value: true })
  for (const value of [sparse, withExtra, withSymbol, nonEnumerable]) {
    assert.throws(() => store.write(OWNER, 0, value), /JSON|data properties|invalid object key/)
  }
  assert.equal(calls.set.length, 0)
})

test('validation never invokes getter, toJSON, or Proxy traps', () => {
  const { store } = memoryStore()
  let calls = 0
  const getter = Object.defineProperty({}, 'value', { enumerable: true, get() { calls++; return true } })
  const withToJson = { toJSON() { calls++; return {} } }
  const proxy = new Proxy({}, { getPrototypeOf() { calls++; throw new Error('proxy trap') } })
  for (const value of [getter, withToJson, proxy]) assert.throws(() => store.write(OWNER, 0, value), /JSON|data properties/)
  assert.equal(calls, 0)
})

test('cycles are rejected while repeated acyclic values are encoded as independent JSON data', () => {
  const { store } = memoryStore()
  const objectCycle = {}; objectCycle.self = objectCycle
  const arrayCycle = []; arrayCycle.push(arrayCycle)
  for (const value of [objectCycle, arrayCycle]) assert.throws(() => store.write(OWNER, 0, value), /cycles/)
  const repeated = { value: 1 }
  const result = store.write(OWNER, 0, [repeated, repeated])
  assert.deepEqual(result.value, [{ value: 1 }, { value: 1 }])
  assert.notEqual(result.value[0], result.value[1])
})

test('the JSON depth and node limits are enforced at their inclusive boundaries', () => {
  const { store, calls } = memoryStore()
  assert.deepEqual(store.write(OWNER, 0, nested(20)).value, nested(20))
  assert.throws(() => store.write(OWNER, 1, nested(21)), /depth limit/)
  assert.equal(store.write(OWNER, 1, Array(9999).fill(null)).value.length, 9999)
  assert.throws(() => store.write(OWNER, 2, Array(10000).fill(null)), /JSON/)
  assert.throws(() => store.write(OWNER, 2, [Array(9999).fill(null)]), /node limit/)
  assert.equal(calls.set.length, 2)
})

test('the 128 KiB UTF-8 limit includes escaping and the complete persisted envelope', () => {
  const { store, calls, data } = memoryStore()
  const overhead = Buffer.byteLength(JSON.stringify({ revision: 1, value: '' }), 'utf8')
  const boundary = 'a'.repeat(MAX_BYTES - overhead)
  assert.equal(store.write(OWNER, 0, boundary).value, boundary)
  assert.equal(Buffer.byteLength(calls.set[0].value, 'utf8'), MAX_BYTES)
  for (const value of ['a'.repeat(MAX_BYTES - overhead + 1), '\u754c'.repeat(Math.ceil(MAX_BYTES / 3)),
    '\\'.repeat(MAX_BYTES / 2), { ['k'.repeat(MAX_BYTES)]: 1 }]) {
    assert.throws(() => store.write(OWNER, 1, value), /byte limit/)
  }
  assert.equal(calls.set.length, 1)
  assert.equal(data.get(calls.set[0].key), calls.set[0].value)
})

test('corrupt stored records are rejected rather than reset or silently rewritten', () => {
  const { store, data, calls } = memoryStore()
  store.write(OWNER, 0, null)
  const key = calls.set[0].key
  const records = ['', '{', 'null', '[]', '{"revision":0}',
    '{"revision":0,"value":null,"extra":true}', '{"revision":-1,"value":null}',
    '{"revision":0.5,"value":null}', '{"revision":9007199254740992,"value":null}',
    '{"revision":1,"value":{"__proto__":true}}',
    JSON.stringify({ revision: 1, value: nested(21) }),
    JSON.stringify({ revision: 1, value: Array(10000).fill(null) }), ' '.repeat(MAX_BYTES + 1)]
  for (const raw of records) {
    data.set(key, raw)
    assert.throws(() => store.read(OWNER), { message: 'Quick provider state is invalid' })
    assert.throws(() => store.write(OWNER, 0, null), { message: 'Quick provider state is invalid' })
    assert.equal(data.get(key), raw)
  }
  assert.equal(calls.set.length, 1)
})

test('storage failures are sanitized and failed writes do not advance revision or cache state', () => {
  const { store, failures, calls } = memoryStore()
  store.write(OWNER, 0, 'confirmed-private-state')
  failures.set = true
  assert.throws(() => store.write(OWNER, 1, 'failed-private-state'), { message: 'Quick provider state could not be written' })
  assert.deepEqual(store.read(OWNER), { revision: 1, value: 'confirmed-private-state' })
  failures.set = false
  assert.equal(store.write(OWNER, 1, 'retried').revision, 2)
  failures.get = true
  assert.throws(() => store.read(OWNER), { message: 'Quick provider state could not be read' })
  assert.throws(() => store.write(OWNER, 2, 'not-written'), { message: 'Quick provider state could not be read' })
  assert.equal(calls.set.length, 3)
  failures.get = false
  assert.deepEqual(store.read(OWNER), { revision: 2, value: 'retried' })
})

test('opaque identities are real domain-separated HMACs, stable across instances and free of raw paths', () => {
  const { store, storage, data } = memoryStore()
  const identities = ['/Users/private/app.app', 'plugin:fixture', '/Users/private/app.app', '', '\ud800', '\ufffd']
  const encoded = store.encodeIdentities(identities)
  const secret = data.get(SECRET_KEY)
  assert.match(secret, /^[a-f0-9]{64}$/)
  assert.deepEqual(encoded, identities.map(identity => `qid_${createHmac('sha256', Buffer.from(secret, 'hex'))
    .update('enest.quick.catalog-identity.v1\0').update(Buffer.from(identity, 'utf16le')).digest('base64url')}`))
  for (const id of encoded) assert.match(id, /^qid_[A-Za-z0-9_-]{43}$/)
  assert.equal(encoded[0], encoded[2])
  assert.notEqual(encoded[4], encoded[5])
  assert.equal(new Set(encoded).size, identities.length - 1)
  assert.deepEqual(new QuickProviderStateStore(storage).encodeIdentities(identities), encoded)
  assert.equal(JSON.stringify(encoded).includes('/Users/private/'), false)
  assert.equal(JSON.stringify(encoded).includes(secret), false)
  assert.deepEqual(store.read(OWNER), { revision: 0, value: null })
  assert.equal(JSON.stringify(store), '{}')
})

test('an 8192-item identity batch loads the persistent secret only once per store instance', () => {
  const { store, storage, calls } = memoryStore()
  const identities = Array.from({ length: 8192 }, (_, index) => `/private/catalog/item-${index}`)
  const first = store.encodeIdentities(identities)
  assert.equal(first.length, identities.length)
  assert.equal(new Set(first).size, identities.length)
  assert.deepEqual(store.encodeIdentities(identities), first)
  assert.deepEqual(calls.get, [SECRET_KEY])
  assert.equal(calls.set.length, 1)
  assert.deepEqual(new QuickProviderStateStore(storage).encodeIdentities(identities), first)
  assert.deepEqual(calls.get, [SECRET_KEY, SECRET_KEY])
  assert.equal(calls.set.length, 1)
})

test('empty or invalid identity batches have no secret-storage side effects', () => {
  const { store, calls } = memoryStore()
  assert.deepEqual(store.encodeIdentities([]), [])
  for (const value of [null, 'identity', [1], new Array(1), Array(8193).fill('identity')]) {
    assert.throws(() => store.encodeIdentities(value), /Invalid Quick identity batch/)
  }
  assert.deepEqual(calls, { get: [], set: [], deletePrefix: [] })
})

test('secret read and creation failures never leak values, return IDs, or cache an uncommitted secret', () => {
  const { store, storage, failures, calls, data } = memoryStore()
  failures.get = true
  assert.throws(() => store.encodeIdentities(['identity']), { message: 'Quick identity secret could not be read' })
  assert.equal(calls.set.length, 0)
  failures.get = false
  failures.set = true
  assert.throws(() => store.encodeIdentities(['identity']), { message: 'Quick identity secret could not be written' })
  assert.equal(data.size, 0)
  failures.set = false
  const result = store.encodeIdentities(['identity'])
  assert.equal(calls.set.length, 2)
  assert.equal(calls.get.length, 3)
  assert.deepEqual(new QuickProviderStateStore(storage).encodeIdentities(['identity']), result)
  assert.equal(data.size, 1)
})

test('a corrupt identity secret is never overwritten or silently rotated', () => {
  for (const value of ['', 'ab'.repeat(31), 'AB'.repeat(32), 'gg'.repeat(32), '/private/secret-value']) {
    const { store, data, calls } = memoryStore()
    data.set(SECRET_KEY, value)
    assert.throws(() => store.encodeIdentities(['identity']), { message: 'Quick identity secret is invalid' })
    assert.equal(data.get(SECRET_KEY), value)
    assert.equal(calls.set.length, 0)
  }
})

test('source removal deletes only that source, preserves the identity secret, and reports failures', () => {
  const { store, data, calls, failures } = memoryStore()
  const first = { source: 'fixture.source', packId: 'first' }
  const second = { source: 'fixture.source', packId: 'second' }
  const other = { source: 'fixture.source-extra', packId: 'first' }
  for (const owner of [first, second, other]) store.write(owner, 0, owner.packId)
  const ids = store.encodeIdentities(['identity'])
  failures.deletePrefix = true
  assert.throws(() => store.removeSource(first.source), { message: 'Quick provider state could not be removed' })
  assert.equal(store.read(first).revision, 1)
  failures.deletePrefix = false
  store.removeSource(first.source)
  assert.deepEqual(store.read(first), { revision: 0, value: null })
  assert.deepEqual(store.read(second), { revision: 0, value: null })
  assert.deepEqual(store.read(other), { revision: 1, value: 'first' })
  const expectedPrefix = `__enest.quick.provider-state.v1.${Buffer.from(first.source, 'utf16le').toString('base64url')}.`
  assert.deepEqual(calls.deletePrefix, [expectedPrefix, expectedPrefix])
  assert.equal(data.size, 2)
  assert.ok(data.has(SECRET_KEY))
  assert.deepEqual(store.encodeIdentities(['identity']), ids)
  assert.throws(() => memoryStore({ withoutRemoval: true }).store.removeSource(first.source), /removal is unavailable/)
})
