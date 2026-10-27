import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import test from 'node:test'
import ts from 'typescript'

const require = createRequire(import.meta.url)
const source = readFileSync(new URL('../../eNest_plugin/plugins/remote-desktop/backend/rdpProtocol.ts', import.meta.url), 'utf8')
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText
const module = { exports: {} }
new Function('require', 'module', 'exports', compiled)(name => {
  if (name.startsWith('node:')) return require(name)
  throw Error(`Unexpected dependency: ${name}`)
}, module, module.exports)
const { parseRdpCleanPathRequest: parse, validateX224Pdu, extractCertChain, buildRdpCleanPathResponse, buildRdpCleanPathError } = module.exports

function length(size) {
  if (size < 128) return Buffer.from([size])
  const bytes = []
  for (let n = size; n; n = Math.floor(n / 256)) bytes.unshift(n & 255)
  return Buffer.from([0x80 | bytes.length, ...bytes])
}
const tlv = (tag, value) => Buffer.concat([Buffer.from([tag]), length(value.length), value])
const utf8 = value => tlv(0x0c, Buffer.from(value))
const field = (tag, value) => tlv(0xa0 + tag, value)
const sequence = fields => tlv(0x30, Buffer.concat(fields))
const version = field(0, tlv(0x02, Buffer.from([0x0d, 0x3e])))
const destination = field(2, utf8('fixture.invalid:3389'))
const x224Request = Buffer.from([3, 0, 0, 19, 14, 0xe0, 0, 0, 0, 0, 0, 1, 0, 8, 0, 3, 0, 0, 0])
const x224Confirm = Buffer.from([3, 0, 0, 19, 14, 0xd0, 0, 0, 0, 0, 0, 2, 0, 8, 0, 1, 0, 0, 0])
const x224 = field(6, tlv(0x04, x224Request))
const request = (extras = []) => sequence([version, destination, ...extras, x224])

function chain(raws) {
  let head
  for (const raw of [...raws].reverse()) head = { raw, issuerCertificate: head }
  return head
}

function readTlv(data, offset = 0) {
  const tag = data[offset++]
  let size = data[offset++]
  if (size & 0x80) {
    const count = size & 0x7f
    size = 0
    for (let i = 0; i < count; i++) size = size * 256 + data[offset++]
  }
  return { tag, value: data.subarray(offset, offset + size), end: offset + size }
}
function children(data) {
  const values = []
  for (let offset = 0; offset < data.length;) {
    const value = readTlv(data, offset)
    values.push(value)
    offset = value.end
  }
  return values
}

test('valid requests retain optional fields and copy no protocol semantics into the host', () => {
  assert.doesNotMatch(source, /from\s+['"](?:@main|@shared|electron)/)
  assert.deepEqual(parse(request()), {
    destination: 'fixture.invalid:3389', proxyAuth: '', x224ConnectionRequest: x224Request, preconnectionBlob: undefined
  })
  assert.deepEqual(parse(request([field(3, utf8('auth')), field(5, utf8('blob'))])), {
    destination: 'fixture.invalid:3389', proxyAuth: 'auth', x224ConnectionRequest: x224Request, preconnectionBlob: 'blob'
  })
})

test('request byte budget is inclusive at 64 KiB and checked before DER parsing', () => {
  const draft = request([field(3, utf8('a'.repeat(64_000)))])
  const authLength = 64_000 + 65_536 - draft.length
  const boundary = request([field(3, utf8('a'.repeat(authLength)))])
  assert.equal(boundary.length, 65_536)
  assert.equal(parse(boundary).proxyAuth.length, authLength)
  assert.throws(() => parse(Buffer.concat([boundary, Buffer.from([0])])), /64 KiB/)
  assert.throws(() => parse(Buffer.alloc(65_537)), /64 KiB/)
  assert.throws(() => parse(new Uint8Array(request())), /expected Buffer/)
})

test('outer DER must be one complete canonical SEQUENCE', () => {
  const valid = request()
  const invalid = [
    Buffer.alloc(0), valid.subarray(0, valid.length - 1), Buffer.concat([valid, Buffer.from([0])]),
    tlv(0x31, valid.subarray(2)), Buffer.from([0x30, 0x80, 0, 0]), Buffer.from([0x30, 0x81]),
    Buffer.from([0x30, 0x85, 0, 0, 0, 0, 0]), Buffer.from([0x30, 0x84, 0xff, 0xff, 0xff, 0xff]),
    Buffer.concat([Buffer.from([0x30, 0x81, valid.length - 2]), valid.subarray(2)]),
    Buffer.concat([Buffer.from([0x30, 0x82, 0, valid.length - 2]), valid.subarray(2)])
  ]
  for (const data of invalid) assert.throws(() => parse(data), /DER|SEQUENCE/)
})

test('request fields require exact constructed context-specific tags in schema order', () => {
  for (const tag of [0x00, 0x20, 0x80, 0xc0, 0xe0]) {
    assert.throws(() => parse(sequence([tlv(tag, tlv(0x02, Buffer.from([0x0d, 0x3e]))), destination, x224])), /field/)
  }
  for (const tag of [1, 4, 7, 8, 9, 30, 31]) {
    assert.throws(() => parse(sequence([version, destination, field(tag, utf8('unknown')), x224])), /field/)
  }
  assert.throws(() => parse(sequence([destination, version, x224])), /order/)
})

test('duplicate required and optional fields are rejected instead of overwritten', () => {
  const fields = [version, destination, field(3, utf8('auth')), field(5, utf8('blob')), x224]
  for (let i = 0; i < fields.length; i++) {
    const duplicated = [...fields.slice(0, i), fields[i], fields[i], ...fields.slice(i + 1)]
    assert.throws(() => parse(sequence(duplicated)), /duplicate/)
  }
})

test('EXPLICIT fields require the declared inner type and exactly one inner TLV', () => {
  const specifications = [[0, 0x02, Buffer.from([0x0d, 0x3e])], [2, 0x0c, Buffer.from('fixture')], [3, 0x0c, Buffer.from('auth')], [5, 0x0c, Buffer.from('blob')], [6, 0x04, x224Request]]
  for (const [tag, innerTag, value] of specifications) {
    const make = modified => sequence(specifications.map(([n, t, v]) => n === tag ? modified : field(n, tlv(t, v))))
    assert.throws(() => parse(make(field(tag, tlv(innerTag === 0x04 ? 0x0c : 0x04, value)))), /inner DER tag/)
    assert.throws(() => parse(make(field(tag, Buffer.concat([tlv(innerTag, value), tlv(innerTag, value)])))), /trailing explicit/)
    assert.throws(() => parse(make(field(tag, Buffer.alloc(0)))), /missing DER/)
  }
})

test('version is canonical positive INTEGER 3390, not a truncated or wrapped equivalent', () => {
  const invalid = [[], [0], [0x0d, 0x3d], [0xff], [0, 0x0d, 0x3e], [0x80, 0, 0x0d, 0x3e], [1, 0, 0, 0x0d, 0x3e]]
  for (const bytes of invalid) {
    assert.throws(() => parse(sequence([field(0, tlv(0x02, Buffer.from(bytes))), destination, x224])), /integer|version/)
  }
  assert.throws(() => parse(sequence([destination, x224])), /version/)
})

test('mandatory fields and UTF8String validation fail closed', () => {
  assert.throws(() => parse(sequence([version, x224])), /missing destination/)
  assert.throws(() => parse(sequence([version, field(2, utf8('')), x224])), /missing destination/)
  assert.throws(() => parse(sequence([version, destination])), /missing x224/)
  for (const tag of [2, 3, 5]) {
    const invalid = field(tag, tlv(0x0c, Buffer.from([0xc3, 0x28])))
    const fields = tag === 2 ? [version, invalid, x224] : [version, destination, invalid, x224]
    assert.throws(() => parse(sequence(fields)), /invalid UTF8String/)
  }
})

test('X.224 validator requires bounded aligned TPKT and the requested CR or CC role', () => {
  assert.equal(validateX224Pdu(x224Request, 'request'), undefined)
  assert.equal(validateX224Pdu(x224Confirm, 'confirm'), undefined)
  assert.equal(validateX224Pdu(x224Request), undefined)
  assert.equal(validateX224Pdu(x224Confirm), undefined)
  const shortest = Buffer.from([3, 0, 0, 11, 6, 0xe0, 0, 0, 0, 0, 0])
  assert.equal(validateX224Pdu(shortest, 'request'), undefined)
  const largest = Buffer.alloc(65_535)
  largest.set([3, 0, 0xff, 0xff, 6, 0xe0])
  assert.equal(validateX224Pdu(largest, 'request'), undefined)
  assert.throws(() => validateX224Pdu(x224Request, 'confirm'), /type/)
  assert.throws(() => validateX224Pdu(x224Confirm, 'request'), /type/)
  for (const [index, value] of [[0, 2], [1, 1], [2, 1], [3, 18], [4, 5], [4, 15], [5, 0xf0]]) {
    const malformed = Buffer.from(x224Request)
    malformed[index] = value
    assert.throws(() => validateX224Pdu(malformed, 'request'), /X\.224/)
    assert.throws(() => parse(sequence([version, destination, field(6, tlv(0x04, malformed))])), /X\.224/)
  }
  for (const data of [Buffer.alloc(10), Buffer.alloc(65_536), new Uint8Array(x224Request)]) {
    assert.throws(() => validateX224Pdu(data), /size/)
  }
})

test('certificate extraction copies DER and terminates self, object and repeated-DER cycles', () => {
  assert.deepEqual(extractCertChain(null), [])
  assert.deepEqual(extractCertChain({}), [])
  const first = { raw: Buffer.from([1]), fingerprint256: 'untrusted-same-label' }
  const second = { raw: Buffer.from([2]), fingerprint256: 'untrusted-same-label' }
  first.issuerCertificate = second
  second.issuerCertificate = first
  const actual = extractCertChain(first)
  assert.deepEqual(actual, [Buffer.from([1]), Buffer.from([2])])
  assert.notEqual(actual[0], first.raw)
  first.issuerCertificate = first
  assert.deepEqual(extractCertChain(first), [Buffer.from([1])])
  first.issuerCertificate = { raw: Buffer.from([1]), issuerCertificate: second }
  assert.deepEqual(extractCertChain(first), [Buffer.from([1])])
})

test('certificate extraction permits 64 certificates but rejects the 65th distinct one', () => {
  const raws = Array.from({ length: 65 }, (_, index) => Buffer.from([index]))
  assert.equal(extractCertChain(chain(raws.slice(0, 64))).length, 64)
  assert.throws(() => extractCertChain(chain(raws)), /64 certificates/)
  assert.equal(extractCertChain(chain([...raws.slice(0, 64), raws[0]])).length, 64)
})

test('certificate extraction enforces 1 MiB before copying and across the complete chain', () => {
  const maximum = Buffer.alloc(1024 * 1024, 1)
  assert.equal(extractCertChain({ raw: maximum })[0].length, maximum.length)
  assert.throws(() => extractCertChain({ raw: Buffer.alloc(maximum.length + 1) }), /1 MiB/)
  assert.throws(() => extractCertChain(chain([Buffer.alloc(512 * 1024, 1), Buffer.alloc(512 * 1024 + 1, 2)])), /1 MiB/)
  assert.equal(extractCertChain(chain([Buffer.alloc(512 * 1024, 1), Buffer.alloc(512 * 1024, 2)])).length, 2)
  assert.throws(() => extractCertChain({ raw: Buffer.alloc(0) }), /invalid certificate/)
  assert.throws(() => extractCertChain({ raw: new Uint8Array([1]) }), /invalid certificate/)
})

test('response encoder retains version, confirmed X.224, complete chain and pinned address', () => {
  const certs = [Buffer.from([1, 2]), Buffer.from([3, 4])]
  const encoded = buildRdpCleanPathResponse('192.0.2.1:3389', x224Confirm, certs)
  const outer = readTlv(encoded)
  assert.equal(outer.tag, 0x30)
  assert.equal(outer.end, encoded.length)
  const values = children(outer.value)
  assert.deepEqual(values.map(value => value.tag), [0xa0, 0xa6, 0xa7, 0xa9])
  assert.deepEqual(readTlv(values[0].value).value, Buffer.from([0x0d, 0x3e]))
  assert.deepEqual(readTlv(values[1].value).value, x224Confirm)
  assert.deepEqual(children(readTlv(values[2].value).value).map(value => value.value), certs)
  assert.equal(readTlv(values[3].value).value.toString(), '192.0.2.1:3389')
  assert.throws(() => buildRdpCleanPathResponse('fixture', x224Request, certs), /type/)
  assert.throws(() => buildRdpCleanPathResponse('fixture', x224Confirm, Array(65).fill(Buffer.from([1]))), /64 certificates/)
  assert.throws(() => buildRdpCleanPathResponse('fixture', x224Confirm, [Buffer.alloc(1024 * 1024 + 1)]), /1 MiB/)
  assert.throws(() => buildRdpCleanPathResponse('fixture', x224Confirm, [Buffer.alloc(0)]), /invalid certificate/)
})

test('error encoder preserves the protocol error shape and rejects invalid integer input', () => {
  const encoded = buildRdpCleanPathError(2, 403)
  const values = children(readTlv(encoded).value)
  assert.deepEqual(values.map(value => value.tag), [0xa0, 0xa1])
  const details = children(readTlv(values[1].value).value)
  assert.deepEqual(details.map(value => value.tag), [0xa0, 0xa1])
  assert.deepEqual(readTlv(details[0].value).value, Buffer.from([2]))
  assert.deepEqual(readTlv(details[1].value).value, Buffer.from([1, 0x93]))
  for (const value of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 0x80000000]) {
    assert.throws(() => buildRdpCleanPathError(value), /integer/)
  }
})
