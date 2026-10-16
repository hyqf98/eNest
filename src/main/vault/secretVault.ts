/**
 * secretVault — 插件密钥保险库
 * 职责：接受插件 vault.set(key, secret)，用 Electron safeStorage 加密后落
 *      ~/.eNest/data/secrets/{pluginId}/，返回不透明 secretRef。
 *      宿主内部（ssh/db）按 secretRef 解密；插件永远拿不到明文 get。
 * 设计：
 *  - secretRef 格式：`sv:{pluginId}:{base64url(key)}`（可逆解析出插件与逻辑键）
 *  - 磁盘：`{root}/data/secrets/{pluginId}/{base64url(key)}.bin`，内容为 safeStorage.encryptString 密文
 *  - safeStorage 不可用或 Linux 使用弱后端时拒绝读写；旧 XOR 数据保留并要求重新输入。
 *  - 新 key ≤128 UTF-8 字节，secret ≤64 KiB，每插件 ≤256 条 / 8 MiB 密文；旧超额数据仅允许不增量更新。
 * 被 pluginHandlers（vault.*）、PluginUninstaller（vaultClearPlugin）与
 * sshSessionManager / dbSessionManager 内部调用。
 * 关键依赖：electron safeStorage、pathsService（data 目录）。
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { safeStorage } from 'electron'
import { getAppPaths } from '@main/paths/pathsService'
import { logWarn } from '@main/logs/logService'

const SECRET_REF_PREFIX = 'sv:'
const MAX_KEY_BYTES = 128
const MAX_SECRET_BYTES = 64 * 1024
const MAX_SECRETS_PER_PLUGIN = 256
const MAX_CIPHERTEXT_BYTES_PER_PLUGIN = 8 * 1024 * 1024

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

/** Linux basic_text is reversible with a fixed key and is not a secure secret store. */
function assertSecureStorage(): void {
  try {
    if (!safeStorage.isEncryptionAvailable()) throw new Error('unavailable')
    if (process.platform === 'linux') {
      const backend = safeStorage.getSelectedStorageBackend()
      if (!['gnome_libsecret', 'kwallet', 'kwallet5', 'kwallet6'].includes(backend)) {
        throw new Error('weak backend')
      }
    }
  } catch {
    throw new Error('secure credential storage unavailable; unlock or configure the system keyring and retry')
  }
}

function encryptSecret(plain: string): Buffer {
  assertSecureStorage()
  try {
    return Buffer.concat([Buffer.from([0x00]), safeStorage.encryptString(plain)])
  } catch {
    throw new Error('secure credential encryption failed; existing secret was not changed')
  }
}

function decryptSecret(blob: Buffer): string {
  if (blob.length < 2) throw new Error('vault secret is damaged; re-enter credentials (existing data preserved)')
  const tag = blob[0]
  if (tag === 0x01) {
    throw new Error('legacy insecure vault secret requires re-entry; existing data preserved')
  }
  if (tag !== 0x00) throw new Error('unsupported vault secret format; re-enter credentials (existing data preserved)')
  assertSecureStorage()
  try {
    return safeStorage.decryptString(blob.subarray(1))
  } catch {
    throw new Error('vault secret cannot be decrypted; unlock the system keyring or re-enter credentials (existing data preserved)')
  }
}

/**
 * 写入密钥：加密落盘，返回 secretRef。
 * key 按 pluginId 命名空间隔离；同 key 覆盖写。
 */
export function vaultSet(pluginId: string, key: string, secret: string): { secretRef: string } {
  const k = String(key ?? '').trim()
  if (!k) throw new Error('vault key required')
  if (typeof secret !== 'string') throw new Error('vault secret must be string')
  const dir = pluginSecretsDir(pluginId), target = blobPath(pluginId, k)
  const existing = existsSync(target)
  const previousBytes = existing ? statSync(target).size : 0
  if (Buffer.byteLength(k, 'utf8') > MAX_KEY_BYTES && !existing) throw new Error('vault key exceeds 128 UTF-8 bytes')
  const secretBytes = Buffer.byteLength(secret, 'utf8')
  if (secretBytes > MAX_SECRET_BYTES && (!existing || secretBytes > previousBytes)) {
    throw new Error('vault secret exceeds 64 KiB; an existing oversized secret may only shrink')
  }
  const blob = encryptSecret(secret)
  if (secretBytes > MAX_SECRET_BYTES && blob.length > previousBytes) {
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
  return { secretRef: makeSecretRef(pluginId, k) }
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
  if (existsSync(p)) rmSync(p, { force: true })
  return true
}

/**
 * 卸载清理：整删该插件的密钥目录（.bin 密文 + 中断写 tmp 残留）。
 * 返回删除的 .bin 条数；目录不存在时返回 0（幂等）。
 */
export function vaultClearPlugin(pluginId: string): number {
  const dir = pluginSecretsDir(pluginId)
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
 * 内部解密：宿主 ssh/db 在 connect 时调用。
 * pluginId 用于限定插件只能解自己的密钥。
 */
export function resolveSecret(pluginId: string, secretRef: string): string | null {
  const parsed = parseSecretRef(secretRef)
  if (!parsed) return null
  if (parsed.pluginId !== pluginId) {
    throw new Error('secretRef does not belong to this plugin')
  }
  const p = blobPath(parsed.pluginId, parsed.key)
  if (!existsSync(p)) return null
  try { return decryptSecret(readFileSync(p)) }
  catch (err) {
    logWarn('vault', 'secret unavailable; existing credential data preserved')
    throw err
  }
}
