import { createHash } from 'node:crypto'
import { pluginRegistry } from '@main/plugin/PluginRegistry'
import { pluginHost } from '@main/plugin/PluginHost'
import { collectMcpToolDeclarationIssues } from '@shared/mcpTools'
import type { McpCatalogPage, McpCatalogQuery, McpCatalogTool } from '@shared/types/mcpSettings'
import { MCP_MAX_BYTES, McpFailure } from './mcpErrors'
import { validateMcpSchema } from './mcpSchemaValidator'

export interface CatalogEntry { tool: McpCatalogTool; buildRevision: string; schemaKey: string }
let signature = '', cached: Promise<CatalogEntry[]> | undefined

export function getMcpCatalog(): Promise<CatalogEntry[]> {
  const descriptors = pluginRegistry.getInstalledDescriptors().filter(item => item.enabled && !item.dev && !pluginHost.isBlockedForOpen(item.id))
  const next = JSON.stringify(descriptors.map(item => [item.id, item.buildRevision]))
  if (cached && signature === next) return cached
  signature = next
  cached = (async () => {
    const entries: CatalogEntry[] = []
    for (const item of descriptors) {
      const tools = item.manifest.contributes?.mcpTools
      if (!tools?.length || collectMcpToolDeclarationIssues(tools).length) continue
      const group: CatalogEntry[] = []
      for (const tool of tools) {
        const schemaKey = createHash('sha256').update(JSON.stringify([item.id, item.buildRevision, tool])).digest('hex')
        if (!await validateMcpSchema(`${schemaKey}:in`, tool.inputSchema, undefined, true)
          || tool.outputSchema && !await validateMcpSchema(`${schemaKey}:out`, tool.outputSchema, undefined, true)) { group.length = 0; break }
        group.push({ tool: { ...structuredClone(tool), pluginId: item.id, pluginName: item.manifest.name }, buildRevision: item.buildRevision, schemaKey })
      }
      entries.push(...group)
    }
    return entries.sort((a, b) => a.tool.pluginId.localeCompare(b.tool.pluginId) || a.tool.id.localeCompare(b.tool.id))
  })().catch(error => { cached = undefined; throw error })
  return cached
}

export async function listMcpTools(input: McpCatalogQuery = {}): Promise<McpCatalogPage> {
  if (!input || typeof input !== 'object' || Array.isArray(input)
    || Object.keys(input).some(key => !['pluginId', 'query', 'cursor', 'limit'].includes(key))
    || input.pluginId !== undefined && (typeof input.pluginId !== 'string' || input.pluginId.length > 256)
    || input.query !== undefined && (typeof input.query !== 'string' || input.query.length > 256)
    || input.cursor !== undefined && (typeof input.cursor !== 'string' || input.cursor.length > 512)
    || input.limit !== undefined && (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > 100)) throw new McpFailure('invalid-arguments')
  const catalog = await getMcpCatalog()
  const query = input.query?.trim().toLocaleLowerCase() ?? ''
  const revision = createHash('sha256').update(JSON.stringify([signature, input.pluginId, query])).digest('hex')
  let offset = 0
  if (input.cursor) {
    try {
      const parsed = JSON.parse(Buffer.from(input.cursor, 'base64url').toString('utf8'))
      if (parsed.revision !== revision || !Number.isSafeInteger(parsed.offset) || parsed.offset < 0) throw new Error()
      offset = parsed.offset
    } catch { throw new McpFailure('invalid-arguments', 'Catalog changed; restart pagination') }
  }
  const matching = catalog.filter(({ tool }) => (!input.pluginId || tool.pluginId === input.pluginId)
    && (!query || `${tool.pluginName} ${tool.id} ${tool.title ?? ''} ${tool.description}`.toLocaleLowerCase().includes(query)))
  const page: McpCatalogPage = { tools: [] }
  let bytes = 1024, end = offset
  for (; end < matching.length && page.tools.length < (input.limit ?? 20); end++) {
    const tool = matching[end].tool
    // The generic MCP result carries both text and structuredContent.
    const size = Buffer.byteLength(JSON.stringify(tool)) * 2
    if (bytes + size > MCP_MAX_BYTES - 8192) break
    page.tools.push(tool); bytes += size
  }
  if (end < matching.length) page.nextCursor = Buffer.from(JSON.stringify({ revision, offset: end })).toString('base64url')
  return page
}
