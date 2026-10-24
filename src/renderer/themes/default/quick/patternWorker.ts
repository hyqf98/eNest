import type { QuickContentMatch } from '@shared/types/quick'

interface PatternRequest { text: string; rules: Array<QuickContentMatch & { id: string }> }
const worker = self as unknown as { onmessage: ((event: MessageEvent<PatternRequest>) => void) | null; postMessage(value: unknown): void }

worker.onmessage = ({ data }) => {
  worker.postMessage({ started: true })
  for (const rule of data.rules) {
    if (data.text.length < rule.minLength || data.text.length > (rule.maxLength ?? Infinity)) continue
    try {
      const pattern = rule.source === undefined ? null : new RegExp(rule.source, rule.flags ?? '')
      const accepted = rule.type === 'regex' ? Boolean(pattern?.test(data.text)) : !pattern || !pattern.test(data.text)
      if (accepted) worker.postMessage({ id: rule.id })
    } catch { /* A malformed declaration is not a search match. */ }
  }
  worker.postMessage({ done: true })
}
