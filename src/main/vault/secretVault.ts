/**
 * secretVault — 插件密钥保险库
 * 职责：接受插件 vault.set(key, secret)，用 Electron safeStorage 加密后落
 *      ~/.eNest/data/secrets/{pluginId}/，返回不透明 secretRef。
 *      宿主内部（ssh/db）按 secretRef 解密；插件永远拿不到明文 get。
 * 设计：
 *  - secretRef 格式：`sv:{pluginId}:{base64url(key)}`（可逆解析出插件与逻辑键）
 *  - 磁盘：`{root}/data/secrets/{pluginId}/{base64url(key)}.bin`，内容为 safeStorage.encryptString 密文
 *  - safeStorage 不可用时降级为 XOR 混淆（仅开发态兜底，日志警告）
 * 被 pluginHandlers（vault.*）与 sshSessionManager / dbSessionManager 内部调用。
 * 关键依赖：electron safeStorage、pathsService（data 目录）。
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { safeStorage } from 'electron'
import { getAppPaths } from '@main/paths/pathsService'
import { logWarn } from '@main/logs/logService'

const SECRET_REF_PREFIX = 'sv:'

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

/** 开发态降级混淆（safeStorage 不可用时）；非生产强度 */
function fallbackEncrypt(plain: string): Buffer {
  const buf = Buffer.from(plain, 'utf-8')
  const out = Buffer.alloc(buf.length)
  for (let i = 0; i < buf.length; i++) out[i] = buf[i] ^ 0x5a ^ (i & 0xff)
  return Buffer.concat([Buffer.from([0x01]), out])
}

function fallbackDecrypt(blob: Buffer): string {
  const body = blob.subarray(1)
  const out = Buffer.alloc(body.length)
  for (let i = 0; i < body.length; i++) out[i] = body[i] ^ 0x5a ^ (i & 0xff)
  return out.toString('utf-8')
}

function encryptSecret(plain: string): Buffer {
  try {
    if (safeStorage.isEncryptionAvailable()) {
      return Buffer.concat([Buffer.from([0x00]), safeStorage.encryptString(plain)])
    }
  } catch (err) {
    logWarn('vault', `safeStorage encrypt unavailable: ${(err as Error).message}`)
  }
  return fallbackEncrypt(plain)
}

function decryptSecret(blob: Buffer): string {
  if (blob.length === 0) throw new Error('empty secret blob')
  const tag = blob[0]
  const body = blob.subarray(1)
  if (tag === 0x00) {
    return safeStorage.decryptString(body)
  }
  return fallbackDecrypt(blob)
}

/**
 * 写入密钥：加密落盘，返回 secretRef。
 * key 按 pluginId 命名空间隔离；同 key 覆盖写。
 */
export function vaultSet(pluginId: string, key: string, secret: string): { secretRef: string } {
  const k = String(key ?? '').trim()
  if (!k) throw new Error('vault key required')
  if (typeof secret !== 'string') throw new Error('vault secret must be string')
  const dir = pluginSecretsDir(pluginId)
  mkdirSync(dir, { recursive: true })
  const blob = encryptSecret(secret)
  writeFileSync(blobPath(pluginId, k), blob)
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
  try {
    const blob = readFileSync(p)
    return decryptSecret(blob)
  } catch (err) {
    logWarn('vault', `decrypt failed for ${parsed.pluginId}:${parsed.key}: ${(err as Error).message}`)
    return null
  }
}
