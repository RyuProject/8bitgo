import type { ReactNode } from 'react'

/**
 * 极简 Markdown 渲染：
 *   块级：## / ### 标题、- 列表、> 引用、普通段落（空行分隔）
 *   行内：**加粗**、`代码`、[文字](链接)
 * 全部输出为 React 元素，不使用 innerHTML。
 *
 * 额外支持「游戏内嵌」：一个**整块都是** `<iframe>` 的段落，且 src 只指向本站
 * `/embed/...`（同源，也兼容带域名的完整 URL），会被渲染成真正的可玩嵌入框。
 * 这是给博客文章嵌游戏用的 —— 故意只认 /embed/，别的网站、别的标签一律当普通文字，
 * 既不让作者写任意 HTML（XSS 风险），也不让外站 iframe 随便嵌进来。
 * 其它用途（法律页、后台预览）默认不开，只有文章正文显式传 embeds:true。
 */
export function renderMarkdown(source: string, opts?: { embeds?: boolean }): ReactNode[] {
  const blocks = source.replace(/\r\n/g, '\n').split(/\n{2,}/)
  return blocks.map((block, i) => renderBlock(block.trim(), i, opts?.embeds ?? false)).filter(Boolean)
}

function renderBlock(block: string, key: number, embeds: boolean): ReactNode {
  if (!block) return null

  // 游戏内嵌：整块或夹在段落里的 <iframe src="/embed/..."> 都拎出来渲染成可玩框。
  if (embeds && /<iframe\b/i.test(block)) {
    const node = renderEmbedBlock(block, key)
    if (node) return node
    // 没过校验（比如外站、别的标签）就当普通文字处理，不要凭空丢内容
  }

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

function attr(src: string, name: string): string | undefined {
  const m = src.match(new RegExp(`${name}\\s*=\\s*["']([^"']*)["']`, 'i'))
  return m ? m[1] : undefined
}

/** 一段文字里可能夹着一个 /embed/ 的 iframe：把 iframe 单独渲染成可玩框，前后的文字照常排。 */
function renderEmbedBlock(block: string, key: number): ReactNode | null {
  // 整块都是 iframe 的最老写法：直接渲染（过不了校验就退回文字）
  if (/^<iframe\b[\s\S]*<\/iframe>$/i.test(block)) {
    return renderEmbed(block, key)
  }
  // 否则按 iframe 切一刀：前面 / 后面是普通文字，中间是嵌入框。
  // 用 div 装而不是 <p> —— 嵌入框是块级元素，塞进 <p> 非法，浏览器会把 <p> 截断。
  const parts = block.split(/(<iframe\b[\s\S]*?<\/iframe>)/i)
  let valid = false
  const nodes = parts
    .map((part, j) => {
      if (!part) return null
      if (/^<iframe\b/i.test(part)) {
        const node = renderEmbed(part, key * 1000 + j)
        if (node) {
          valid = true
          return node
        }
        // 非法 iframe 当普通文字（不 innerHTML，安全）
        return <span key={j}>{inline(part)}</span>
      }
      if (!part.trim()) return null
      return <span key={j}>{inline(part)}</span>
    })
    .filter(Boolean)
  return valid ? <div key={key}>{nodes}</div> : null
}

/** 只认同源 /embed/ 的 iframe，其余一律返回 null（当文字处理） */
function renderEmbed(block: string, key: number): ReactNode | null {
  const src = attr(block, 'src')
  if (!src) return null
  // 同源两种写法都放行：裸路径 /embed/... 或带域名的 https://8bitgo.com/embed/...
  const ok = /^\/embed\//.test(src) || /^https?:\/\/(?:[\w-]+\.)*8bitgo\.com\/embed\//i.test(src)
  if (!ok) return null

  const title = attr(block, 'title') ?? '8BitGo'
  return (
    <div key={key} className="my-6 aspect-[4/3] w-full overflow-hidden rounded-xl border border-line bg-black">
      <iframe
        src={src}
        title={title}
        frameBorder={0}
        allowFullScreen
        allow="fullscreen; autoplay; gamepad"
        className="h-full w-full"
      />
    </div>
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
