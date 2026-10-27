import type { QuickCommandKind } from '@shared/types/quick'

/** Theme-private worker DTOs deliberately exclude handles, images and launch payloads. */
export interface QuickNameRow { kind: QuickCommandKind; title: string; names: string[] }
export interface QuickNameHit { index: number; keyword: string }
export interface QuickNameSearchRequest {
  id: number
  rows?: QuickNameRow[]
  query: string
  filter: QuickCommandKind | null
  preferred: number[]
}
export interface QuickNameSearchResponse { id: number; hits: QuickNameHit[] }
