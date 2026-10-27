import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { safeStorage } from 'electron'
import { defaultDataRoot } from '@main/paths/pathsService'
import type { McpConfiguration } from '@shared/types/mcpSettings'

export const DEFAULT_MCP_CONFIGURATION: McpConfiguration = { enabled: false, port: 43921 }
function directory(): string { return join(defaultDataRoot(), 'host-mcp') }
function atomicWrite(name: string, data: string | Buffer): void {
  const root = directory(), target = join(root, name), temporary = `${target}.${process.pid}.tmp`
  mkdirSync(root, { recursive: true, mode: 0o700 })
  try { writeFileSync(temporary, data, { mode: 0o600 }); renameSync(temporary, target) }
  finally { rmSync(temporary, { force: true }) }
}
function assertSecureStorage(): void {
  if (!safeStorage.isEncryptionAvailable() || process.platform === 'linux'
    && !['gnome_libsecret', 'kwallet', 'kwallet5', 'kwallet6'].includes(safeStorage.getSelectedStorageBackend())) {
    throw new Error('系统安全存储不可用，MCP 不会降级为明文凭据')
  }
}
export function readMcpConfiguration(): McpConfiguration {
  const file = join(directory(), 'configuration.json')
  if (!existsSync(file)) return { ...DEFAULT_MCP_CONFIGURATION }
  const input = JSON.parse(readFileSync(file, 'utf8'))
  validateMcpConfiguration(input)
  return { enabled: input.enabled, port: input.port }
}
export function validateMcpConfiguration(input: unknown): asserts input is McpConfiguration {
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !['enabled', 'port'].includes(key))
    || typeof Reflect.get(input, 'enabled') !== 'boolean' || !Number.isInteger(Reflect.get(input, 'port'))
    || Reflect.get(input, 'port') < 1024 || Reflect.get(input, 'port') > 65535) throw new Error('MCP 配置无效：端口必须为 1024–65535 的整数')
}
export function writeMcpConfiguration(configuration: McpConfiguration): void {
  validateMcpConfiguration(configuration)
  atomicWrite('configuration.json', JSON.stringify(configuration))
}
export function readOrCreateMcpToken(): string {
  assertSecureStorage()
  const file = join(directory(), 'token.bin')
  if (!existsSync(file)) return replaceMcpToken()
  let token: string
  try { token = safeStorage.decryptString(readFileSync(file)) }
  catch { throw new Error('MCP 凭据无法解密，请解锁系统密钥库或在设置中重置令牌') }
  if (!/^[A-Za-z0-9_-]{43}$/.test(token)) throw new Error('MCP 凭据损坏，请在设置中重置令牌')
  return token
}
export function replaceMcpToken(): string {
  assertSecureStorage()
  const token = randomBytes(32).toString('base64url')
  atomicWrite('token.bin', safeStorage.encryptString(token))
  return token
}
