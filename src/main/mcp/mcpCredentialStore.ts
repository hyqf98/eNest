import { randomBytes, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { defaultDataRoot } from '@main/paths/pathsService'
import { decryptCredential, encryptCredential } from '@main/vault/secureStorage'
import type { McpConfiguration } from '@shared/types/mcpSettings'

export const DEFAULT_MCP_CONFIGURATION: McpConfiguration = { enabled: false, port: 43921 }
function directory(): string { return join(defaultDataRoot(), 'host-mcp') }
function atomicWrite(name: string, data: string | Buffer, root = directory()): void {
  const target = join(root, name), temporary = `${target}.${randomUUID()}.tmp`
  mkdirSync(root, { recursive: true, mode: 0o700 })
  try { writeFileSync(temporary, data, { mode: 0o600 }); renameSync(temporary, target) }
  finally { rmSync(temporary, { force: true }) }
}
let credentialGeneration = 0
let tokenOperations = Promise.resolve()
let pendingTokenOperations = 0
const MAX_PENDING_TOKEN_OPERATIONS = 8

export function invalidateMcpTokenOperations(): void { credentialGeneration++ }

function withToken<T>(assertOwner: () => void, action: (root: string, assertCurrent: () => void) => Promise<T>): Promise<T> {
  assertOwner()
  if (pendingTokenOperations >= MAX_PENDING_TOKEN_OPERATIONS) throw new Error('MCP 凭据操作繁忙，请解锁系统密钥库后重试')
  const root = directory(), generation = credentialGeneration
  const assertCurrent = (): void => {
    assertOwner()
    if (generation !== credentialGeneration || root !== directory()) throw new Error('MCP 凭据操作已取消')
  }
  pendingTokenOperations++
  const operation = tokenOperations.then(async () => { assertCurrent(); return action(root, assertCurrent) }).finally(() => { pendingTokenOperations-- })
  tokenOperations = operation.then(() => {}, () => {})
  return operation
}

function assertUnchanged(file: string, original: Buffer | null): void {
  if (original === null ? existsSync(file) : !existsSync(file) || !readFileSync(file).equals(original)) {
    throw new Error('MCP 凭据已变更，请重试')
  }
}

async function encryptToken(token: string): Promise<Buffer> {
  try { return await encryptCredential(token) }
  catch { throw new Error('系统安全存储不可用或加密失败，MCP 不会降级为明文凭据') }
}

async function createToken(root: string, assertCurrent: () => void): Promise<string> {
  const file = join(root, 'token.bin'), original = existsSync(file) ? readFileSync(file) : null
  const token = randomBytes(32).toString('base64url')
  const encrypted = await encryptToken(token)
  assertCurrent()
  assertUnchanged(file, original)
  atomicWrite('token.bin', encrypted, root)
  return token
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
export async function readOrCreateMcpToken(assertOwner: () => void = () => {}): Promise<string> {
  return withToken(assertOwner, async (root, assertCurrent) => {
    const file = join(root, 'token.bin')
    if (!existsSync(file)) return createToken(root, assertCurrent)
    const original = readFileSync(file)
    let decoded: Electron.DecryptStringAsyncReturnValue
    try { decoded = await decryptCredential(original) }
    catch { throw new Error('MCP 凭据无法解密，请解锁系统密钥库或在设置中重置令牌（现有凭据保留）') }
    assertCurrent()
    const { result: token, shouldReEncrypt } = decoded
    if (!/^[A-Za-z0-9_-]{43}$/.test(token)) throw new Error('MCP 凭据损坏，请在设置中重置令牌')
    const replacement = shouldReEncrypt ? await encryptToken(token) : undefined
    assertCurrent()
    assertUnchanged(file, original)
    if (replacement) atomicWrite('token.bin', replacement, root)
    return token
  })
}
export async function replaceMcpToken(assertOwner: () => void = () => {}): Promise<string> {
  return withToken(assertOwner, createToken)
}
