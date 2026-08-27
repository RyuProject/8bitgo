import { StrictMode } from 'react'
import { renderToString } from 'react-dom/server'
import { StaticRouter } from 'react-router'
import { AppRoutes } from './AppRoutes'
import { gamesStore } from '@/services/store'
import { postsStore } from '@/services/posts'
import { setLangForRender } from '@/services/lang'
import { beginHeadCollection, endHeadCollection, setSsrPath, takeSsrNotFound, type CollectedHead } from '@/services/seo'
import { langFromPath, langPrefix, stripLang } from '@/config/languages'
import type { Game, Post } from '@/types'

export interface RenderInput {
  /** 完整请求路径（含语言前缀），例如 /en/games/mario */
  url: string
  games: Game[]
  posts: Post[]
}

export interface RenderResult {
  html: string
  head: CollectedHead
  lang: string
  /** 是否渲染出了「页面不存在」，服务端据此回 404 而不是 200 */
  notFound: boolean
}

/**
 * 把某个 URL 渲染成 HTML 字符串。
 *
 * 注意：renderToString 是同步的，所以下面这些模块级状态（语言、数据、head 收集器）
 * 在一次请求内不会被其它请求打断——这是刻意依赖的前提。
 */
export function render({ url, games, posts }: RenderInput): RenderResult {
  // 先把查询串剥掉再判语言。以前直接把 req.originalUrl 传进去，
  // /en?utm_source=x 的首段会被解析成 'en?utm_source=x'，认不出语言 →
  // 按默认中文渲染、basename 为空 → 路由全不匹配 → 服务端吐一个中文 404 页，
  // 客户端却按英文首页 hydrate，两边对不上。分享链接、广告落地页最容易踩到。
  const pathname = url.split('?')[0].split('#')[0]
  const lang = langFromPath(pathname)
  setLangForRender(lang)
  setSsrPath(stripLang(pathname))

  // 灌数据：seed 只写内存，服务端本来也没有 localStorage
  gamesStore.seed(games)
  postsStore.seed(posts)

  beginHeadCollection()
  takeSsrNotFound() // 清掉上一次的残留
  const html = renderToString(
    <StrictMode>
      <StaticRouter location={url} basename={langPrefix(lang) || undefined}>
        <AppRoutes />
      </StaticRouter>
    </StrictMode>,
  )
  const head = endHeadCollection()
  return { html, head, lang, notFound: takeSsrNotFound() }
}
