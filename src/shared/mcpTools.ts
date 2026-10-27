import type { McpToolDeclaration } from '@shared/types/mcp'

export const MCP_TOOL_LIMITS = {
  toolsPerPlugin: 128,
  idLength: 64,
  titleLength: 128,
  descriptionLength: 4096,
  schemaBytes: 64 * 1024,
  schemaDepth: 20,
  schemaNodes: 10_000,
  patternLength: 256
} as const

const TOOL_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/
const DECLARATION_KEYS = new Set(['id', 'title', 'description', 'inputSchema', 'outputSchema', 'annotations'])
const ANNOTATION_KEYS = new Set(['title', 'readOnlyHint', 'destructiveHint', 'idempotentHint', 'openWorldHint'])
const SCHEMA_MAPS = new Set(['$defs', 'definitions', 'properties', 'patternProperties', 'dependentSchemas', 'dependencies'])
const SCHEMA_ARRAYS = new Set(['allOf', 'anyOf', 'oneOf', 'prefixItems'])
const SCHEMA_CHILDREN = new Set(['additionalProperties', 'unevaluatedProperties', 'propertyNames', 'items', 'contains', 'unevaluatedItems', 'contentSchema', 'not', 'if', 'then', 'else'])

function isRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

/** Checks portable shape and resource limits; the host still compiles the schema before use. */
export function collectMcpSchemaIssues(value: unknown, input = false): string[] {
  try {
    if (!isRecord(value)) return ['must be a JSON Schema object']
    if (input && value.type !== 'object') return ['input schema must declare type object']
    const seen = new WeakSet<object>()
    const pending: Array<{ value: unknown; depth: number; schema: boolean; schemaMap?: boolean; schemaArray?: boolean }> = [
      { value, depth: 0, schema: true }
    ]
    let nodes = 0
    let characters = 0
    while (pending.length) {
      const next = pending.pop()!
      if (++nodes > MCP_TOOL_LIMITS.schemaNodes) return ['exceeds the schema node limit']
      if (next.depth > MCP_TOOL_LIMITS.schemaDepth) return ['exceeds the schema depth limit']
      const item = next.value
      if (typeof item === 'string') characters += item.length
      else if (typeof item === 'number') {
        if (!Number.isFinite(item)) return ['contains a non-finite number']
      } else if (item !== null && typeof item !== 'boolean') {
        if (typeof item !== 'object') return ['must contain JSON values only']
        if (seen.has(item)) return ['must not contain cycles or shared object references']
        seen.add(item)
        if (Array.isArray(item)) {
          if (item.length > MCP_TOOL_LIMITS.schemaNodes) return ['exceeds the schema node limit']
          for (let index = 0; index < item.length; index++) {
            const descriptor = Object.getOwnPropertyDescriptor(item, String(index))
            if (!descriptor || !('value' in descriptor)) return ['must not contain sparse arrays or accessors']
            pending.push({ value: descriptor.value, depth: next.depth + 1, schema: next.schemaArray === true })
          }
        } else {
          if (!isRecord(item)) return ['must contain plain JSON objects only']
          const descriptors = Object.getOwnPropertyDescriptors(item)
          if (Object.getOwnPropertySymbols(item).length) return ['must not contain symbol keys']
          if (next.schema) {
            const dialect = descriptors.$schema?.value
            if (dialect !== undefined && dialect !== 'https://json-schema.org/draft/2020-12/schema') return ['only JSON Schema 2020-12 is supported']
            if (descriptors.$id || descriptors.$async) return ['$id and asynchronous schemas are not supported']
            for (const keyword of ['$ref', '$dynamicRef']) {
              const reference = descriptors[keyword]?.value
              if (reference !== undefined && (typeof reference !== 'string' || !reference.startsWith('#'))) return ['schema references must be local fragments']
            }
            const pattern = descriptors.pattern?.value
            if (pattern !== undefined && (typeof pattern !== 'string' || pattern.length > MCP_TOOL_LIMITS.patternLength)) return ['schema pattern exceeds its limit']
          }
          for (const [key, descriptor] of Object.entries(descriptors)) {
            if (!('value' in descriptor)) return ['must not contain accessors']
            if (key === '__proto__' || key === 'prototype' || key === 'constructor') return ['contains a reserved object key']
            characters += key.length
            pending.push({
              value: descriptor.value,
              depth: next.depth + 1,
              schema: next.schemaMap === true || (next.schema && SCHEMA_CHILDREN.has(key)),
              schemaMap: next.schema && SCHEMA_MAPS.has(key),
              schemaArray: next.schema && SCHEMA_ARRAYS.has(key)
            })
            if (next.schema && key === 'patternProperties' && isRecord(descriptor.value)) {
              if (Object.keys(descriptor.value).some(pattern => pattern.length > MCP_TOOL_LIMITS.patternLength)) return ['schema pattern exceeds its limit']
            }
          }
        }
      }
      if (characters > MCP_TOOL_LIMITS.schemaBytes) return ['exceeds the schema byte limit']
    }
    if (new TextEncoder().encode(JSON.stringify(value)).byteLength > MCP_TOOL_LIMITS.schemaBytes) return ['exceeds the schema byte limit']
    return []
  } catch {
    return ['must be a bounded plain JSON Schema object']
  }
}

/** Shared by installation, the catalog and the generated standalone SDK validator. */
export function collectMcpToolDeclarationIssues(value: unknown): string[] {
  if (value === undefined) return []
  if (!Array.isArray(value)) return ['contributes.mcpTools must be an array']
  if (value.length > MCP_TOOL_LIMITS.toolsPerPlugin) return [`contributes.mcpTools exceeds ${MCP_TOOL_LIMITS.toolsPerPlugin} tools`]
  const errors: string[] = []
  const ids = new Set<string>()
  try {
    for (const [index, raw] of value.entries()) {
      const at = `contributes.mcpTools[${index}]`
      if (!isRecord(raw)) { errors.push(`${at} must be an object`); continue }
      if (Object.keys(raw).some(key => !DECLARATION_KEYS.has(key))) errors.push(`${at} contains an unknown field`)
      if (typeof raw.id !== 'string' || !TOOL_ID.test(raw.id)) errors.push(`${at}.id must be 1-64 letters, digits, dots, underscores or hyphens, starting with a letter or digit`)
      else {
        if (ids.has(raw.id)) errors.push(`${at}.id duplicates another tool`)
        ids.add(raw.id)
      }
      if (typeof raw.description !== 'string' || !raw.description.trim() || raw.description.length > MCP_TOOL_LIMITS.descriptionLength) errors.push(`${at}.description must be non-empty and at most ${MCP_TOOL_LIMITS.descriptionLength} characters`)
      if (raw.title !== undefined && (typeof raw.title !== 'string' || !raw.title.trim() || raw.title.length > MCP_TOOL_LIMITS.titleLength)) errors.push(`${at}.title must be non-empty and at most ${MCP_TOOL_LIMITS.titleLength} characters`)
      for (const issue of collectMcpSchemaIssues(raw.inputSchema, true)) errors.push(`${at}.inputSchema ${issue}`)
      if (raw.outputSchema !== undefined) for (const issue of collectMcpSchemaIssues(raw.outputSchema)) errors.push(`${at}.outputSchema ${issue}`)
      if (raw.annotations !== undefined) {
        if (!isRecord(raw.annotations)) errors.push(`${at}.annotations must be an object`)
        else for (const [key, annotation] of Object.entries(raw.annotations)) {
          if (!ANNOTATION_KEYS.has(key)) errors.push(`${at}.annotations contains an unknown hint`)
          else if (key === 'title' ? typeof annotation !== 'string' || annotation.length > MCP_TOOL_LIMITS.titleLength : typeof annotation !== 'boolean') errors.push(`${at}.annotations.${key} has an invalid value`)
        }
      }
      if (errors.length >= 32) return errors.slice(0, 32)
    }
  } catch {
    errors.push('contributes.mcpTools must contain plain JSON declarations')
  }
  return errors
}

export function isMcpToolDeclarationList(value: unknown): value is McpToolDeclaration[] {
  return Array.isArray(value) && collectMcpToolDeclarationIssues(value).length === 0
}
