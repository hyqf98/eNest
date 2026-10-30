import { pinyin } from 'pinyin-pro'
import { normalizeSearchText } from '@shared/search'

/** Prepared once per catalog entry, never once per keystroke. */
export interface QuickNameIndex {
  text: string
  compact: string
  pinyin: string
  initials: string
  acronym: string
}

const prepared = new Map<string, QuickNameIndex>()

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
  if (text === query) return 10000
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
    continuousScore(index.compact, compactQuery) * 0.98,
    continuousScore(index.pinyin, compactQuery) * 0.75,
    continuousScore(index.initials, compactQuery) * 0.7,
    index.acronym.length > 1 ? continuousScore(index.acronym, compactQuery) * 0.7 : 0
  )
  const terms = queryTerms ?? query.split(/\s+/).filter(Boolean)
  if (terms.length < 2 || terms.length > 16) return continuous
  const scores = terms.map(term => Math.max(continuousScore(index.text, term), continuousScore(index.pinyin, term) * 0.75,
    continuousScore(index.initials, term) * 0.7))
  return Math.max(continuous, scores.every(score => score > 0) ? scores.reduce((sum, score) => sum + score, 0) / scores.length * 0.6 : 0)
}
