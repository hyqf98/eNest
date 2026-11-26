import { useMemo, type ReactNode } from 'react'
import { safeRichText } from '@renderer/services/safeRichText'
import { MarkdownView } from './MarkdownView'

const HTML_NOTES = /^(?:<!--[\s\S]*?-->\s*)*<(?:p|br|h[1-6]|ul|ol|li|div|a|strong|em|pre|code|blockquote|table|details|section)\b/i

export function ReleaseNotes({ source, fallback }: { source?: string; fallback: ReactNode }) {
  const content = useMemo(() => {
    const notes = source?.slice(0, 256 * 1024).trim()
    if (!notes) return null
    if (!HTML_NOTES.test(notes)) return <MarkdownView source={notes} />
    const safe = safeRichText(notes, 12000)
    return safe.textContent?.trim()
      ? <div className="markdown-body release-notes-html" dangerouslySetInnerHTML={{ __html: safe.innerHTML }} /> : null
  }, [source])
  return <>{content ?? fallback}</>
}
