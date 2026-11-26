/** 首页与快捷启动共用的文本规则：兼容全角输入、大小写和多余空白。 */
export function normalizeSearchText(value: string): string {
  return value.normalize('NFKC').trim().replace(/\s+/g, ' ').toLocaleLowerCase()
}

export function publicLaunchAliases(aliases: readonly string[]): string[] {
  const result = new Set<string>()
  for (const alias of aliases) {
    if (typeof alias !== 'string' || alias.length > 256 || /[\u0000-\u001f\u007f]/u.test(alias)) continue
    const name = alias.trim()
    if (!name || /^(?:[\\/]|[a-z]:[\\/])/i.test(name)) continue
    result.add(name)
    if (result.size === 100) break
  }
  return [...result]
}

/** 空格分开的多个关键词可分别命中名称、描述或 id。 */
export function matchesSearchTerms(text: string, query: string): boolean {
  const haystack = normalizeSearchText(text)
  return normalizeSearchText(query).split(' ').every((term) => haystack.includes(term))
}
