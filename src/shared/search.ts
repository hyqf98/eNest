/** 首页与快捷启动共用的文本规则：兼容全角输入、大小写和多余空白。 */
export function normalizeSearchText(value: string): string {
  return value.normalize('NFKC').trim().replace(/\s+/g, ' ').toLocaleLowerCase()
}

/** 空格分开的多个关键词可分别命中名称、描述或 id。 */
export function matchesSearchTerms(text: string, query: string): boolean {
  const haystack = normalizeSearchText(text)
  return normalizeSearchText(query).split(' ').every((term) => haystack.includes(term))
}
