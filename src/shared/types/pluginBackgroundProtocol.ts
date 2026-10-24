export type BackgroundRequest =
  | { id: number; kind: 'event'; event: string; data: unknown }
  | { id: number; kind: 'call'; method: string; args: unknown[] }
  | { id: number; kind: 'search'; query: string; limit: number }

export interface BackgroundResponse {
  id: number
  ok: boolean
  data?: unknown
  error?: string
}

export const BACKGROUND_MESSAGE_LIMIT = 48 * 1024 * 1024
