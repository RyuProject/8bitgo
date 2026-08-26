import type { ReactNode } from 'react'

/**
 * 极简 Markdown 渲染：
 *   块级：## / ### 标题、- 列表、> 引用、普通段落（空行分隔）
 *   行内：**加粗**、`代码`、[文字](链接)
 * 全部输出为 React 元素，不使用 innerHTML。
 */
export function renderMarkdown(source: string): ReactNode[] {
  const blocks = source.replace(/\r\n/g, '\n').split(/\n{2,}/)
  return blocks.map((block, i) => renderBlock(block.trim(), i)).filter(Boolean)
}

function renderBlock(block: string, key: number): ReactNode {
  if (!block) return null
  const lines = block.split('\n')

  if (/^###\s+/.test(block)) return <h3 key={key}>{inline(block.replace(/^###\s+/, ''))}</h3>
  if (/^##\s+/.test(block)) return <h2 key={key}>{inline(block.replace(/^##\s+/, ''))}</h2>
  if (/^#\s+/.test(block)) return <h2 key={key}>{inline(block.replace(/^#\s+/, ''))}</h2>

  if (lines.every((l) => /^[-*]\s+/.test(l))) {
    return (
      <ul key={key}>
        {lines.map((l, j) => (
          <li key={j}>{inline(l.replace(/^[-*]\s+/, ''))}</li>
        ))}
      </ul>
    )
  }

  if (lines.every((l) => /^\d+\.\s+/.test(l))) {
    return (
      <ol key={key}>
        {lines.map((l, j) => (
          <li key={j}>{inline(l.replace(/^\d+\.\s+/, ''))}</li>
        ))}
      </ol>
    )
  }

  if (lines.every((l) => /^>\s?/.test(l))) {
    return <blockquote key={key}>{inline(lines.map((l) => l.replace(/^>\s?/, '')).join(' '))}</blockquote>
  }

  return (
    <p key={key}>
      {lines.map((l, j) => (
        <span key={j}>
          {inline(l)}
          {j < lines.length - 1 && <br />}
        </span>
      ))}
    </p>
  )
}

const INLINE_RE = /(\*\*[^*]+\*\*|`[^`]+`|\[[^\]]+\]\([^)]+\))/g

function inline(text: string): ReactNode[] {
  const parts = text.split(INLINE_RE)
  return parts.map((part, i) => {
    if (!part) return null
    if (part.startsWith('**') && part.endsWith('**')) return <strong key={i}>{part.slice(2, -2)}</strong>
    if (part.startsWith('`') && part.endsWith('`')) return <code key={i}>{part.slice(1, -1)}</code>
    const link = part.match(/^\[([^\]]+)\]\(([^)]+)\)$/)
    if (link) {
      const href = link[2]
      const external = /^https?:\/\//.test(href)
      return (
        <a key={i} href={href} target={external ? '_blank' : undefined} rel={external ? 'noreferrer' : undefined}>
          {link[1]}
        </a>
      )
    }
    return part
  })
}
