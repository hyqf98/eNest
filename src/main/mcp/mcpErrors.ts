import type { McpErrorCode, McpToolResult } from '@shared/types/mcp'

export class McpFailure extends Error {
  constructor(readonly code: McpErrorCode, message: string = code) { super(message) }
}

export function failureResult(code: McpErrorCode): McpToolResult {
  return { isError: true, content: [{ type: 'text', text: code }], structuredContent: { errorCode: code } }
}

const codes = new Set<McpErrorCode>(['busy', 'needs-consent', 'permission-denied', 'interaction-required', 'not-found', 'invalid-arguments', 'not-ready', 'timeout', 'cancelled', 'unavailable', 'internal-error', 'result-too-large'])
export function failureCode(error: unknown): McpErrorCode {
  const code = error && typeof error === 'object' ? Reflect.get(error, 'code') : undefined
  return codes.has(code) ? code as McpErrorCode : 'internal-error'
}

export const MCP_MAX_BYTES = 1024 * 1024
