import type { PluginFeature, PluginFeatureInput } from '@shared/types/plugin'
import type { QuickEnterInput } from '@shared/types/quick'
import { normalizeSearchText } from '@shared/search'

export const PLUGIN_TEXT_QUERY_MAX_LENGTH = 4096

/** Existing unrestricted text consumers opt in; regex/media-only/name-only features do not. */
export function resolvePluginFeatureInput(feature: Pick<PluginFeature, 'input' | 'cmds'>): PluginFeatureInput | undefined {
  if (feature.input) return { type: 'text', trigger: feature.input.trigger }
  return feature.cmds.some(command => typeof command === 'object' && command.type === 'over' && command.exclude === undefined)
    ? { type: 'text', trigger: 'prefix' } : undefined
}

export function preparePluginTextQuery(query: string) {
  const raw = query.slice(0, PLUGIN_TEXT_QUERY_MAX_LENGTH)
  return { raw, words: [...raw.matchAll(/\S+/gu)].map(match => ({
    normalized: normalizeSearchText(match[0]), start: match.index ?? 0, end: (match.index ?? 0) + match[0].length
  })) }
}

export function preparePluginTextAliases(aliases: readonly string[]): string[][] {
  return aliases.map(normalizeSearchText).filter(Boolean).map(alias => alias.split(' '))
}

/** Literal matching retains original body offsets; workers prepare query once and aliases per revision. */
export function matchPreparedPluginTextPrefix(
  { raw, words }: ReturnType<typeof preparePluginTextQuery>, aliases: readonly (readonly string[])[]
): { text: string; trigger: string } | undefined {
  if (words.length < 2) return undefined
  let matchedWords = 0
  for (const tokens of aliases) {
    if (tokens.length <= matchedWords || tokens.length >= words.length) continue
    if (tokens.every((token, index) => words[index].normalized === token)) matchedWords = tokens.length
  }
  if (!matchedWords) return undefined
  return { trigger: raw.slice(words[0].start, words[matchedWords - 1].end), text: raw.slice(words[matchedWords].start) }
}

export function matchPluginTextPrefix(query: string, aliases: readonly string[]): { text: string; trigger: string } | undefined {
  return matchPreparedPluginTextPrefix(preparePluginTextQuery(query), preparePluginTextAliases(aliases))
}

/** Main derives this from the selected native command, never from theme-authored input metadata. */
export function buildPluginTextInput(query: string | undefined, aliases: readonly string[], declaration: PluginFeatureInput | undefined): QuickEnterInput | undefined {
  if (!declaration || typeof query !== 'string' || !query.trim()) return undefined
  const raw = query.slice(0, PLUGIN_TEXT_QUERY_MAX_LENGTH)
  const match = declaration.trigger === 'prefix' ? matchPluginTextPrefix(raw, aliases) : undefined
  return { text: match?.text ?? raw, query: { raw, ...(match ? { trigger: match.trigger } : {}) } }
}
