/**
 * secretVault — 插件密钥保险库
 * 职责：接受插件 vault.set(key, secret)，用 Electron safeStorage 加密后落
 *      ~/.eNest/data/secrets/{pluginId}/，返回不透明 secretRef。
 *      获授权的插件 Node 后端可通过 secret.resolve 解密自己的引用；页面无明文 get。
 * 设计：
 *  - secretRef 格式：`sv:{pluginId}:{base64url(key)}`（可逆解析出插件与逻辑键）
 *  - 磁盘：`{root}/data/secrets/{pluginId}/{base64url(key)}.bin`，保留 0x00 + safeStorage 密文格式
 *  - safeStorage 不可用或 Linux 使用弱后端时拒绝读写；旧 XOR 数据保留并要求重新输入。
 *  - 新 key ≤128 UTF-8 字节，secret ≤64 KiB，每插件 ≤256 条 / 8 MiB 密文；旧超额数据仅允许不增量更新。
 * 被 pluginHandlers（vault.*）、PluginUninstaller（vaultClearPlugin）与
 * 通用 pluginBackendCapabilities（secret.resolve）调用。
 * 关键依赖：electron safeStorage、pathsService（data 目录）。
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { getAppPaths, getAppPathsGeneration } from '@main/paths/pathsService'
import { logWarn } from '@main/logs/logService'
import { decryptCredential, encryptCredential } from './secureStorage'

const SECRET_REF_PREFIX = 'sv:'
const MAX_KEY_BYTES = 128
const MAX_SECRET_BYTES = 64 * 1024
const MAX_SECRETS_PER_PLUGIN = 256
const MAX_CIPHERTEXT_BYTES_PER_PLUGIN = 8 * 1024 * 1024
const MAX_PENDING_PER_PLUGIN = 16
const MAX_PENDING_GLOBAL = 64
let pendingOperations = 0
const pendingPluginOperations = new Map<string, number>()

interface VaultKeyQueue { generation: number; pending: number }
interface VaultQueue {
  tail: Promise<void>
  pending: number
  generation: number
  keys: Map<string, VaultKeyQueue>
}
const queues = new Map<string, VaultQueue>()

function withVaultCredential<T>(pluginId: string, key: string, assertOwner: () => void,
  action: (directory: string, target: string, assertCurrent: () => void) => Promise<T>): Promise<T> {
  assertOwner()
  const directory = pluginSecretsDir(pluginId), target = join(directory, `${encodeKeyPart(key)}.bin`)
  const ownerId = sanitizePathComponent(pluginId), ownerPending = pendingPluginOperations.get(ownerId) ?? 0
  const rootGeneration = getAppPathsGeneration()
  let queue = queues.get(directory)
  if (pendingOperations >= MAX_PENDING_GLOBAL || ownerPending >= MAX_PENDING_PER_PLUGIN) {
    throw new Error('vault operation limit reached (16 per plugin, 64 global); retry after the keyring is available')
  }
  if (!queue) {
    queue = { tail: Promise.resolve(), pending: 0, generation: 0, keys: new Map() }
    queues.set(directory, queue)
  }
  let keyQueue = queue.keys.get(key)
  if (!keyQueue) { keyQueue = { generation: 0, pending: 0 }; queue.keys.set(key, keyQueue) }
  const currentQueue = queue, currentKey = keyQueue, generation = queue.generation, keyGeneration = keyQueue.generation
  const assertCurrent = (): void => {
    assertOwner()
    if (getAppPathsGeneration() !== rootGeneration || pluginSecretsDir(pluginId) !== directory
      || currentQueue.generation !== generation || currentKey.generation !== keyGeneration) {
      throw new Error('vault operation cancelled; credential or data root changed')
    }
  }
  queue.pending++; keyQueue.pending++; pendingOperations++
  pendingPluginOperations.set(ownerId, ownerPending + 1)
  const operation = queue.tail.then(async () => { assertCurrent(); return action(directory, target, assertCurrent) }).finally(() => {
    pendingOperations--
    const remaining = pendingPluginOperations.get(ownerId)! - 1
    if (remaining) pendingPluginOperations.set(ownerId, remaining)
    else pendingPluginOperations.delete(ownerId)
    if (--currentKey.pending === 0 && currentQueue.keys.get(key) === currentKey) currentQueue.keys.delete(key)
    if (--currentQueue.pending === 0 && queues.get(directory) === currentQueue) queues.delete(directory)
  })
  queue.tail = operation.then(() => {}, () => {})
  return operation
}

function secretsRoot(): string {
  return join(getAppPaths().data, 'secrets')
}

function pluginSecretsDir(pluginId: string): string {
  return join(secretsRoot(), sanitizePathComponent(pluginId))
}

/** 将 pluginId / key 中的路径敏感字符替换，防目录穿越 */
function sanitizePathComponent(s: string): string {
  return s.replace(/[^a-zA-Z0-9._-]/g, '_')
}

function encodeKeyPart(key: string): string {
  return Buffer.from(key, 'utf-8').toString('base64url')
}

function decodeKeyPart(part: string): string {
  return Buffer.from(part, 'base64url').toString('utf-8')
}

/** 构造 secretRef（插件侧只持有此字符串） */
function makeSecretRef(pluginId: string, key: string): string {
  return `${SECRET_REF_PREFIX}${sanitizePathComponent(pluginId)}:${encodeKeyPart(key)}`
}

export interface ParsedSecretRef {
  pluginId: string
  key: string
}

/** 解析 secretRef → { pluginId, key }；非法 ref 返回 null */
export function parseSecretRef(secretRef: string): ParsedSecretRef | null {
  if (!secretRef || !secretRef.startsWith(SECRET_REF_PREFIX)) return null
  const rest = secretRef.slice(SECRET_REF_PREFIX.length)
  const colon = rest.indexOf(':')
  if (colon <= 0) return null
  const pluginId = rest.slice(0, colon)
  const keyPart = rest.slice(colon + 1)
  if (!keyPart) return null
  try {
    return { pluginId, key: decodeKeyPart(keyPart) }
  } catch {
    return null
  }
}

function blobPath(pluginId: string, key: string): string {
  return join(pluginSecretsDir(pluginId), `${encodeKeyPart(key)}.bin`)
}

function vaultUsage(directory: string): { count: number; bytes: number } {
  if (!existsSync(directory)) return { count: 0, bytes: 0 }
  let count = 0, bytes = 0
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (!entry.isFile()) continue
    if (entry.name.endsWith('.bin')) count++
    // Include files left by interrupted writes when checking disk usage.
    bytes += statSync(join(directory, entry.name)).size
  }
  return { count, bytes }
}

async function encryptSecret(plain: string): Promise<Buffer> {
  try {
    return Buffer.concat([Buffer.from([0x00]), await encryptCredential(plain)])
  } catch {
    throw new Error('secure credential encryption failed; unlock or configure the system keyring (existing secret was not changed)')
  }
}

async function decryptSecret(blob: Buffer): Promise<Electron.DecryptStringAsyncReturnValue> {
  if (blob.length < 1) throw new Error('vault secret is damaged; re-enter credentials (existing data preserved)')
  const tag = blob[0]
  if (tag === 0x01) {
    throw new Error('legacy insecure vault secret requires re-entry; existing data preserved')
  }
  if (tag !== 0x00) throw new Error('unsupported vault secret format; re-enter credentials (existing data preserved)')
  try {
    return await decryptCredential(blob.subarray(1))
  } catch {
    throw new Error('vault secret cannot be decrypted; unlock the system keyring or re-enter credentials (existing data preserved)')
  }
}

/**
 * 写入密钥：加密落盘，返回 secretRef。
 * key 按 pluginId 命名空间隔离；同 key 覆盖写。
 */
export async function vaultSet(pluginId: string, key: string, secret: string, assertOwner: () => void = () => {}): Promise<{ secretRef: string }> {
  const k = String(key ?? '').trim()
  if (!k) throw new Error('vault key required')
  if (typeof secret !== 'string') throw new Error('vault secret must be string')
  assertOwner()
  // Validate before retaining the payload behind a possibly locked OS keyring.
  checkSecretSize(blobPath(pluginId, k), k, secret)
  return withVaultCredential(pluginId, k, assertOwner, async (dir, target, assertCurrent) => {
    checkSecretSize(target, k, secret)
    const blob = await encryptSecret(secret)
    assertCurrent()
    writeSecretBlob(dir, target, k, secret, blob)
    return { secretRef: makeSecretRef(pluginId, k) }
  })
}

function checkSecretSize(target: string, key: string, secret: string): void {
  const existing = existsSync(target)
  const previousBytes = existing ? statSync(target).size : 0
  if (Buffer.byteLength(key, 'utf8') > MAX_KEY_BYTES && !existing) throw new Error('vault key exceeds 128 UTF-8 bytes')
  const secretBytes = Buffer.byteLength(secret, 'utf8')
  if (secretBytes > MAX_SECRET_BYTES && (!existing || secretBytes > previousBytes)) {
    throw new Error('vault secret exceeds 64 KiB; an existing oversized secret may only shrink')
  }
}

function writeSecretBlob(dir: string, target: string, key: string, secret: string, blob: Buffer): void {
  checkSecretSize(target, key, secret)
  const existing = existsSync(target), previousBytes = existing ? statSync(target).size : 0
  if (Buffer.byteLength(secret, 'utf8') > MAX_SECRET_BYTES && blob.length > previousBytes) {
    throw new Error('vault secret exceeds 64 KiB; an existing oversized secret may only shrink')
  }
  const usage = vaultUsage(dir)
  if (!existing && usage.count >= MAX_SECRETS_PER_PLUGIN) throw new Error('vault entry quota exceeded (256 per plugin)')
  const nextBytes = usage.bytes - previousBytes + blob.length
  if (nextBytes > MAX_CIPHERTEXT_BYTES_PER_PLUGIN && nextBytes > usage.bytes) {
    throw new Error('vault ciphertext quota exceeded (8 MiB per plugin)')
  }
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  const temporary = `${target}.${randomUUID()}.tmp`
  try {
    writeFileSync(temporary, blob, { flag: 'wx', mode: 0o600 })
    renameSync(temporary, target)
  } finally {
    rmSync(temporary, { force: true })
  }
}

/** 判断密钥是否存在（接受逻辑 key 或 secretRef）；跨插件 ref 一律 false */
export function vaultHas(pluginId: string, keyOrRef: string): boolean {
  const resolved = resolveKey(pluginId, keyOrRef)
  if (!resolved) return false
  if (resolved.pluginId !== pluginId) return false
  return existsSync(blobPath(resolved.pluginId, resolved.key))
}

/** 删除密钥（接受逻辑 key 或 secretRef）；不存在时也返回 true（幂等） */
export function vaultRemove(pluginId: string, keyOrRef: string): boolean {
  const resolved = resolveKey(pluginId, keyOrRef)
  if (!resolved) return true
  // 只允许删除本插件的密钥
  if (resolved.pluginId !== pluginId) {
    throw new Error('cannot remove secret of another plugin')
  }
  const p = blobPath(resolved.pluginId, resolved.key)
  const queue = queues.get(pluginSecretsDir(resolved.pluginId))
  const keyQueue = queue?.keys.get(resolved.key)
  if (keyQueue) keyQueue.generation++
  if (existsSync(p)) rmSync(p, { force: true })
  return true
}

/**
 * 卸载清理：整删该插件的密钥目录（.bin 密文 + 中断写 tmp 残留）。
 * 返回删除的 .bin 条数；目录不存在时返回 0（幂等）。
 */
export function vaultClearPlugin(pluginId: string): number {
  const dir = pluginSecretsDir(pluginId)
  const queue = queues.get(dir)
  if (queue) queue.generation++
  if (!existsSync(dir)) return 0
  const { count } = vaultUsage(dir)
  rmSync(dir, { recursive: true, force: true })
  return count
}

function resolveKey(pluginId: string, keyOrRef: string): ParsedSecretRef | null {
  const s = String(keyOrRef ?? '')
  if (s.startsWith(SECRET_REF_PREFIX)) {
    return parseSecretRef(s)
  }
  if (!s.trim()) return null
  return { pluginId, key: s.trim() }
}

/**
 * 内部解密：经授权的插件后端通过通用 secret.resolve 能力调用。
 * pluginId 用于限定插件只能解自己的密钥。
 */
export async function resolveSecret(pluginId: string, secretRef: string, assertOwner: () => void = () => {}): Promise<string | null> {
  const parsed = parseSecretRef(secretRef)
  if (!parsed) return null
  if (parsed.pluginId !== pluginId) {
    throw new Error('secretRef does not belong to this plugin')
  }
  return withVaultCredential(pluginId, parsed.key, assertOwner, async (dir, target, assertCurrent) => {
    if (!existsSync(target)) return null
    const original = readFileSync(target)
    try {
      const { result, shouldReEncrypt } = await decryptSecret(original)
      assertCurrent()
      const replacement = shouldReEncrypt ? await encryptSecret(result) : undefined
      assertCurrent()
      if (!existsSync(target) || !readFileSync(target).equals(original)) throw new Error('vault credential changed during decryption')
      if (replacement) writeSecretBlob(dir, target, parsed.key, result, replacement)
      return result
    } catch (err) {
      logWarn('vault', 'secret unavailable; existing credential data preserved')
      throw err
    }
  })
}
