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
}

/** 链接协议白名单，拦截 javascript: 等危险协议 */
const SAFE_LINK = /^(https?:\/\/|mailto:)/i

/** 将纯文本按行内 Markdown 标记拆成 React 节点（文本已由 React 自动转义） */
function parseInline(text: string, keyBase: string): ReactNode[] {
  const nodes: ReactNode[] = []
  // 顺序：行内码 → 粗体 → 斜体 → 链接
  const pattern =
    /(`[^`]+`)|(\*\*[^*]+\*\*)|(\*[^*\n]+\*)|(\[[^\]]+\]\([^)\s]+\))/g
  let last = 0
  let m: RegExpExecArray | null
  let i = 0

  while ((m = pattern.exec(text)) !== null) {
    if (m.index > last) nodes.push(text.slice(last, m.index))
    const token = m[0]
    const key = `${keyBase}-i${i++}`

    if (token.startsWith('`')) {
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
      if (SAFE_LINK.test(href)) {
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
function parseMarkdown(source: string): ReactNode[] {
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
      const content = parseInline(heading[2].trim(), `h${key}`)
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
        items.push(<li key={`li${key}-${items.length}`}>{parseInline(item, `li${key}${items.length}`)}</li>)
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
        items.push(<li key={`ol${key}-${items.length}`}>{parseInline(item, `ol${key}${items.length}`)}</li>)
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
      push(<p className="md-p">{parseInline(para.join(' '), `p${key}`)}</p>)
    } else {
      i += 1
    }
  }

  return blocks
}

/** Markdown 正文渲染器 */
export function MarkdownView({ source }: Props) {
  return <div className="markdown-body">{parseMarkdown(source)}</div>
}
