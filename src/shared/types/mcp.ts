/** Portable MCP contracts. No SDK or Electron runtime dependency crosses this boundary. */
export type McpErrorCode =
  | 'busy'
  | 'needs-consent'
  | 'permission-denied'
  | 'interaction-required'
  | 'not-found'
  | 'invalid-arguments'
  | 'not-ready'
  | 'timeout'
  | 'cancelled'
  | 'unavailable'
  | 'internal-error'
  | 'result-too-large'

/** A self-contained JSON Schema 2020-12 document; references must stay local. */
export type McpJsonSchema = Record<string, unknown>

/** Descriptive hints only; these never grant host permissions. */
export interface McpToolAnnotations {
  title?: string
  readOnlyHint?: boolean
  destructiveHint?: boolean
  idempotentHint?: boolean
  openWorldHint?: boolean
}

export interface McpToolDeclaration {
  id: string
  description: string
  inputSchema: McpJsonSchema
  title?: string
  outputSchema?: McpJsonSchema
  annotations?: McpToolAnnotations
}

export interface McpContentAnnotations {
  audience?: Array<'user' | 'assistant'>
  priority?: number
  lastModified?: string
}

export type McpContentBlock = (
  | { type: 'text'; text: string }
  | { type: 'image'; data: string; mimeType: string }
  | { type: 'audio'; data: string; mimeType: string }
  | { type: 'resource_link'; uri: string; name: string; title?: string; description?: string; mimeType?: string; size?: number }
  | { type: 'resource'; resource: { uri: string; mimeType?: string } & ({ text: string } | { blob: string }) }
) & { annotations?: McpContentAnnotations }

export interface McpToolResult {
  content: McpContentBlock[]
  /** Must be JSON-serializable. False, zero and null are meaningful results. */
  structuredContent?: unknown
  isError?: boolean
}

export interface McpHandlerContext {
  requestId: string
  /** Absolute Unix time in milliseconds. */
  deadlineAt: number
  /** Runs immediately if already cancelled; returns an unsubscribe function. */
  onCancel(callback: () => void): () => void
}

export type McpToolHandler = (argumentsValue: Record<string, unknown>, context: McpHandlerContext) => McpToolResult | Promise<McpToolResult>
export type McpToolHandlers = Record<string, McpToolHandler>

export interface McpRegisterRequest {
  toolIds: string[]
}

export interface McpRegistrationAck {
  registrationId: string
}

export interface McpDispatchMessage {
  registrationId: string
  requestId: string
  toolId: string
  arguments: Record<string, unknown>
  deadlineAt: number
}

export interface McpCancelMessage {
  registrationId: string
  requestId: string
}

/** Also acknowledges actual handler settlement after cancellation or timeout. */
export interface McpResultMessage {
  registrationId: string
  requestId: string
  result?: McpToolResult
  errorCode?: McpErrorCode
}
