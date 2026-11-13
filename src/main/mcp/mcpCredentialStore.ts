import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { defaultDataRoot } from '@main/paths/pathsService'
import type { McpConfiguration } from '@shared/types/mcpSettings'

export const DEFAULT_MCP_CONFIGURATION: McpConfiguration = { enabled: false, port: 43921 }
function directory(): string { return join(defaultDataRoot(), 'host-mcp') }
function atomicWrite(name: string, data: string | Buffer, root = directory()): void {
  const target = join(root, name), temporary = `${target}.${randomUUID()}.tmp`
  mkdirSync(root, { recursive: true, mode: 0o700 })
  try { writeFileSync(temporary, data, { mode: 0o600 }); renameSync(temporary, target) }
  finally { rmSync(temporary, { force: true }) }
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
