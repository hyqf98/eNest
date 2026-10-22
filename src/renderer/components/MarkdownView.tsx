/**
 * MarkdownView — 零依赖轻量 Markdown 渲染组件
 * 支持：一至三级标题、粗体/斜体、行内码、围栏代码块、无序/有序列表、链接、分隔线、段落。
 * 安全策略：不注入原始 HTML；行内标记只解析转义后的文本节点，链接协议白名单。
 * 使用方：PluginDetailModal 的 README 正文。
 */
import { Fragment, type ReactNode } from 'react'

interface Props {
  /** Markdown 源文本 */
  source: string
  /** URL of the version-matched packaged Markdown file. */
  baseUrl?: string
  imageMap?: Record<string, string>
  /** Images already presented in the detail gallery. */
  omitImages?: string[]
  /** Restricted theme surfaces do not navigate or spawn untrusted popups. */
  disableLinks?: boolean
}

/** 链接协议白名单，拦截 javascript: 等危险协议 */
const SAFE_LINK = /^(https?:\/\/|mailto:)/i

/** Images may only resolve within the same package's market assets. No remote tracking pixels. */
export function resolveMarkdownImage(raw: string, baseUrl?: string, imageMap?: Record<string, string>): string | undefined {
  if (!baseUrl || /^(?:[a-z][a-z\d+.-]*:|[\\/])/i.test(raw)) return undefined
  try {
    const decoded = decodeURIComponent(raw)
    if (decoded.split('/').includes('..') || /[\\?#\u0000-\u001f]/.test(decoded)) return undefined
    const base = new URL(baseUrl)
    if (base.protocol === 'enest-home:') {
      if (base.hostname !== 'catalog' || base.username || base.password || base.port || base.search || base.hash) return undefined
      const match = /^\/([^/]+)\/readme$/.exec(base.pathname)
      const mapped = imageMap?.[decoded.replace(/^\.\//, '')]
      if (!match || !mapped) return undefined
      const image = new URL(mapped)
      if (image.protocol !== 'enest-home:' || image.hostname !== 'catalog' || image.username || image.password || image.port || image.search || image.hash) return undefined
      const parts = image.pathname.split('/')
      return parts.length === 4 && parts[1] === match[1] && parts[2] === 'screenshot' && /^[0-7]$/.test(parts[3]) ? image.href : undefined
    }
    const mapped = base.protocol === 'enest:' ? undefined : imageMap?.[decoded.replace(/^\.\//, '')]
    const image = new URL(mapped ?? raw, base)
    const directory = base.pathname.slice(0, base.pathname.lastIndexOf('/') + 1)
    if (!['enest:', 'https:', 'http:'].includes(base.protocol) || image.protocol !== base.protocol || image.host !== base.host || image.username || image.password || !image.pathname.startsWith(directory) || !/\.(png|jpe?g|webp|gif|svg)$/i.test(image.pathname)) return undefined
    return image.href
  } catch { return undefined }
}

/** 将纯文本按行内 Markdown 标记拆成 React 节点（文本已由 React 自动转义） */
function parseInline(text: string, keyBase: string, baseUrl?: string, imageMap?: Record<string, string>, omitImages: string[] = [], disableLinks = false): ReactNode[] {
  const nodes: ReactNode[] = []
  // 顺序：行内码 → 粗体 → 斜体 → 链接
  const pattern =
    /(!\[[^\]]*\]\([^)\s]+\))|(`[^`]+`)|(\*\*[^*]+\*\*)|(\*[^*\n]+\*)|(\[[^\]]+\]\([^)\s]+\))/g
  let last = 0
  let m: RegExpExecArray | null
  let i = 0

  while ((m = pattern.exec(text)) !== null) {
    if (m.index > last) nodes.push(text.slice(last, m.index))
    const token = m[0]
    const key = `${keyBase}-i${i++}`

    if (token.startsWith('![')) {
      const close = token.indexOf('](')
      const label = token.slice(2, close)
      const raw = token.slice(close + 2, -1)
      const src = resolveMarkdownImage(raw, baseUrl, imageMap)
      const inGallery = src && omitImages.some(image => {
        try { return new URL(image, baseUrl).href === src } catch { return image === src }
      })
      if (!inGallery) {
        nodes.push(src ? <img key={key} className="md-image" src={src} alt={label} loading="lazy" /> : <span key={key}>{label}</span>)
      }
    } else if (token.startsWith('`')) {
      nodes.push(
        <code key={key} className="md-code">
          {token.slice(1, -1)}
        </code>
      )
    } else if (token.startsWith('**')) {
      nodes.push(<strong key={key}>{token.slice(2, -2)}</strong>)
    } else if (token.startsWith('*')) {
      nodes.push(<em key={key}>{token.slice(1, -1)}</em>)
    } else if (token.startsWith('[')) {
      const close = token.indexOf('](')
      const label = token.slice(1, close)
      const href = token.slice(close + 2, -1)
      if (disableLinks && SAFE_LINK.test(href)) {
        nodes.push(<span key={key} className="md-link-text" title={href}>{label} ({href})</span>)
      } else if (SAFE_LINK.test(href)) {
        nodes.push(
          <a key={key} href={href} target="_blank" rel="noreferrer noopener">
            {label}
          </a>
        )
      } else {
        nodes.push(label)
      }
    } else {
      nodes.push(token)
    }
    last = m.index + token.length
  }
  if (last < text.length) nodes.push(text.slice(last))
  return nodes
}

/** 将整篇 Markdown 解析为 React 节点数组（块级） */
function parseMarkdown(source: string, baseUrl?: string, imageMap?: Record<string, string>, omitImages?: string[], disableLinks = false): ReactNode[] {
  const lines = source.replace(/\r\n/g, '\n').split('\n')
  const blocks: ReactNode[] = []
  let i = 0
  let key = 0

  const push = (node: ReactNode) => {
    blocks.push(<Fragment key={`b${key++}`}>{node}</Fragment>)
  }

  while (i < lines.length) {
    const line = lines[i]

    // 空行
    if (!line.trim()) {
      i += 1
      continue
    }

    // 围栏代码块 ```lang
    if (/^```/.test(line.trim())) {
      i += 1
      const buf: string[] = []
      while (i < lines.length && !/^```/.test(lines[i].trim())) {
        buf.push(lines[i])
        i += 1
      }
      if (i < lines.length) i += 1 // 跳过收尾 ```
      push(
        <pre className="md-pre">
          <code>{buf.join('\n')}</code>
        </pre>
      )
      continue
    }

    // 分隔线 --- / ***
    if (/^(-{3,}|\*{3,})\s*$/.test(line.trim())) {
      push(<hr className="md-hr" />)
      i += 1
      continue
    }

    // 标题 # ## ###
    const heading = /^(#{1,3})\s+(.*)$/.exec(line)
    if (heading) {
      const level = heading[1].length
      const content = parseInline(heading[2].trim(), `h${key}`, baseUrl, imageMap, omitImages, disableLinks)
      const Tag = (`h${level + 1}` as 'h2' | 'h3' | 'h4') // 正文内标题从 h2 起，避免与弹窗标题撞级
      push(<Tag className={`md-h md-h${level}`}>{content}</Tag>)
      i += 1
      continue
    }

    // 无序列表
    if (/^\s*[-*+]\s+/.test(line)) {
      const items: ReactNode[] = []
      while (i < lines.length && /^\s*[-*+]\s+/.test(lines[i])) {
        const item = lines[i].replace(/^\s*[-*+]\s+/, '')
        items.push(<li key={`li${key}-${items.length}`}>{parseInline(item, `li${key}${items.length}`, baseUrl, imageMap, omitImages, disableLinks)}</li>)
        i += 1
      }
      push(<ul className="md-ul">{items}</ul>)
      continue
    }

    // 有序列表
    if (/^\s*\d+\.\s+/.test(line)) {
      const items: ReactNode[] = []
      while (i < lines.length && /^\s*\d+\.\s+/.test(lines[i])) {
        const item = lines[i].replace(/^\s*\d+\.\s+/, '')
        items.push(<li key={`ol${key}-${items.length}`}>{parseInline(item, `ol${key}${items.length}`, baseUrl, imageMap, omitImages, disableLinks)}</li>)
        i += 1
      }
      push(<ol className="md-ol">{items}</ol>)
      continue
    }

    // 段落：连续非空、非块级行合并
    const para: string[] = []
    while (
      i < lines.length &&
      lines[i].trim() &&
      !/^```/.test(lines[i].trim()) &&
      !/^(-{3,}|\*{3,})\s*$/.test(lines[i].trim()) &&
      !/^#{1,3}\s+/.test(lines[i]) &&
      !/^\s*[-*+]\s+/.test(lines[i]) &&
      !/^\s*\d+\.\s+/.test(lines[i])
    ) {
      para.push(lines[i].trim())
      i += 1
    }
    if (para.length) {
      const content = parseInline(para.join(' '), `p${key}`, baseUrl, imageMap, omitImages, disableLinks)
      if (content.length) push(<p className="md-p">{content}</p>)
    } else {
      i += 1
    }
  }

  return blocks
}

/** Markdown 正文渲染器 */
export function MarkdownView({ source, baseUrl, imageMap, omitImages, disableLinks }: Props) {
  return <div className="markdown-body">{parseMarkdown(source, baseUrl, imageMap, omitImages, disableLinks)}</div>
}
