import type { QuickCommandKind } from '@shared/types/quick'

/** Theme-private index keys carry no native paths, images or launch payloads. */
export interface QuickNameRow { key: string; kind: QuickCommandKind | 'market'; title: string; names: string[]; prefix?: boolean }
export interface QuickNameHit { index: number; keyword: string; prefix?: boolean }
export interface QuickNameSearchRequest {
  id: number
  index?: { upsert: QuickNameRow[]; remove: string[]; order?: string[] }
  query: string
  filter: QuickCommandKind | 'market' | null
  preferred: number[]
}
export interface QuickNameSearchResponse { id: number; hits: QuickNameHit[] }
