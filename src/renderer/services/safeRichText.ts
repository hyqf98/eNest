import { safeNotificationLink } from '@shared/notification'

const ALLOWED = new Set(['P', 'BR', 'STRONG', 'B', 'EM', 'I', 'U', 'S', 'CODE', 'PRE', 'UL', 'OL', 'LI', 'BLOCKQUOTE', 'H2', 'H3', 'H4', 'HR', 'A', 'SPAN', 'DIV', 'TABLE', 'THEAD', 'TBODY', 'TR', 'TH', 'TD'])
const DROP = new Set(['SCRIPT', 'STYLE', 'IFRAME', 'FRAME', 'OBJECT', 'EMBED', 'SVG', 'MATH', 'TEMPLATE', 'FORM', 'INPUT', 'BUTTON', 'TEXTAREA', 'SELECT', 'LINK', 'META', 'BASE', 'IMG', 'VIDEO', 'AUDIO', 'SOURCE'])

/** Parse in an inert template, then rebuild an allowlisted tree. No original element is mounted. */
export function safeRichText(source: string, maxNodes: number): HTMLDivElement {
  const template = document.createElement('template')
  template.innerHTML = source
  const output = document.createElement('div')
  let count = 0
  const append = (node: Node, parent: Node, depth: number): void => {
    if (++count > maxNodes || depth > 24) return
    if (node.nodeType === Node.TEXT_NODE) { parent.appendChild(document.createTextNode(node.textContent ?? '')); return }
    if (!(node instanceof Element)) return
    const tag = node.tagName.toUpperCase()
    if (DROP.has(tag)) return
    if (!ALLOWED.has(tag)) {
      for (const child of Array.from(node.childNodes)) append(child, parent, depth + 1)
      return
    }
    const element = document.createElement(tag.toLowerCase())
    if (tag === 'A') {
      const href = safeNotificationLink(node.getAttribute('href') ?? '')
      if (href) {
        element.setAttribute('href', href)
        element.setAttribute('target', '_blank')
        element.setAttribute('rel', 'noopener noreferrer')
      }
    }
    for (const child of Array.from(node.childNodes)) append(child, element, depth + 1)
    parent.appendChild(element)
  }
  for (const node of Array.from(template.content.childNodes)) append(node, output, 0)
  return output
}
