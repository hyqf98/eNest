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

export function prepareQuickName(value: string): QuickNameIndex {
  const text = normalizeSearchText(value)
  const compact = text.replace(/\s+/g, '')
  const hasChinese = /\p{Script=Han}/u.test(text)
  return {
    text,
    compact,
    pinyin: hasChinese ? pinyin(text, { toneType: 'none', type: 'array' }).join('').replace(/\s+/g, '') : '',
    initials: hasChinese ? pinyin(text, { pattern: 'first', toneType: 'none', type: 'array' }).join('').replace(/\s+/g, '') : '',
    acronym: text.split(/[\s\-_.]+/).filter(Boolean).map((word) => word[0]).join('')
  }
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

/** Continuous name/pinyin matching; descriptions and arbitrary subsequences are excluded. */
export function scoreQuickName(index: QuickNameIndex, query: string): number {
  const compactQuery = query.replace(/\s+/g, '')
  return Math.max(
    continuousScore(index.text, query),
    continuousScore(index.compact, compactQuery) * 0.98,
    continuousScore(index.pinyin, compactQuery) * 0.75,
    continuousScore(index.initials, compactQuery) * 0.7,
    index.acronym.length > 1 ? continuousScore(index.acronym, compactQuery) * 0.7 : 0
  )
}
