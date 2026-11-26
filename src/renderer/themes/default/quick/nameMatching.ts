import { pinyin } from 'pinyin-pro'
import { normalizeSearchText } from '@shared/search'
import type { QuickNameRow } from './nameSearchTypes'

/** Prepared once per catalog entry, never once per keystroke. */
export interface QuickNameIndex {
  text: string
  compact: string
  pinyin: string
  initials: string
  acronym: string
}

const prepared = new Map<string, QuickNameIndex>()
const EXACT_SCORE = 10_000
const COMPACT_WEIGHT = 0.98
const INITIALS_WEIGHT = 0.7

export function prepareQuickName(value: string): QuickNameIndex {
  const cached = prepared.get(value)
  if (cached) return cached
  const text = normalizeSearchText(value)
  const compact = text.replace(/\s+/g, '')
  const hasChinese = /\p{Script=Han}/u.test(text)
  const result = {
    text,
    compact,
    pinyin: hasChinese ? pinyin(text, { toneType: 'none', type: 'array' }).join('').replace(/\s+/g, '') : '',
    initials: hasChinese ? pinyin(text, { pattern: 'first', toneType: 'none', type: 'array' }).join('').replace(/\s+/g, '') : '',
    acronym: text.split(/[\s\-_.]+/).filter(Boolean).map((word) => word[0]).join('')
  }
  if (prepared.size >= 4_096) prepared.delete(prepared.keys().next().value!)
  prepared.set(value, result)
  return result
}

function continuousScore(text: string, query: string): number {
  if (!text || !query) return 0
  if (text === query) return EXACT_SCORE
  const position = text.indexOf(query)
  if (position < 0) return 0
  const coverage = Math.round(query.length / text.length * 1000)
  if (position === 0) return 5000 + coverage
  return 2000 + Math.max(0, 1000 - position * 10) + coverage
}

/** Continuous name/pinyin matching with all-term token fallback, never arbitrary subsequences. */
export function scoreQuickName(index: QuickNameIndex, query: string, queryTerms?: readonly string[]): number {
  const compactQuery = query.replace(/\s+/g, '')
  const continuous = Math.max(
    continuousScore(index.text, query),
    continuousScore(index.compact, compactQuery) * COMPACT_WEIGHT,
    continuousScore(index.pinyin, compactQuery) * 0.75,
    continuousScore(index.initials, compactQuery) * INITIALS_WEIGHT,
    index.acronym.length > 1 ? continuousScore(index.acronym, compactQuery) * INITIALS_WEIGHT : 0
  )
  const terms = queryTerms ?? query.split(/\s+/).filter(Boolean)
  if (terms.length < 2 || terms.length > 16) return continuous
  const scores = terms.map(term => Math.max(continuousScore(index.text, term), continuousScore(index.pinyin, term) * 0.75,
    continuousScore(index.initials, term) * INITIALS_WEIGHT))
  return Math.max(continuous, scores.every(score => score > 0) ? scores.reduce((sum, score) => sum + score, 0) / scores.length * 0.6 : 0)
}

export function prepareQuickSearchNames(title: string, aliases: string[]) {
  const names = aliases.length && title && !aliases.includes(title) ? [...aliases, title] : aliases
  return { title, prepared: names.map(prepareQuickName), combined: names.length > 1 ? prepareQuickName(names.join(' ')) : undefined }
}

interface QuickNameRank { title: string; tier: number; score: number; preferred: boolean; prefix: boolean }

export function rankQuickName(row: ReturnType<typeof prepareQuickSearchNames>, query: string, terms: string[],
  kind: QuickNameRow['kind'], preferred: boolean, prefix?: { trigger: string }): QuickNameRank | undefined {
  if (prefix) return { title: row.title, tier: 3, score: prefix.trigger.length, preferred, prefix: true }
  let score = 0
  for (const name of row.prepared) score = Math.max(score, scoreQuickName(name, query, terms))
  if (row.combined && terms.length > 1) {
    score = Math.max(score, scoreQuickName(row.combined, query, terms) * 0.5)
  }
  if (!score) return undefined
  const tier = score >= EXACT_SCORE * COMPACT_WEIGHT ? 2 : score >= EXACT_SCORE * INITIALS_WEIGHT ? 1 : 0
  if (kind === 'app' && score < EXACT_SCORE) score = Math.min(EXACT_SCORE - 1, score + 300)
  return { title: row.title, tier, score, preferred, prefix: false }
}

export function compareQuickNameRanks(left: QuickNameRank, right: QuickNameRank): number {
  return right.tier - left.tier || (left.prefix && right.prefix ? right.score - left.score : 0)
    || Number(right.preferred) - Number(left.preferred) || right.score - left.score || left.title.localeCompare(right.title, 'zh-CN')
}
