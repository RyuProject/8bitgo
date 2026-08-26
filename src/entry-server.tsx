import { StrictMode } from 'react'
import { renderToString } from 'react-dom/server'
import { StaticRouter } from 'react-router'
import { AppRoutes } from './AppRoutes'
import { gamesStore } from '@/services/store'
import { postsStore } from '@/services/posts'
import { setLangForRender } from '@/services/lang'
import { beginHeadCollection, endHeadCollection, setSsrPath, type CollectedHead } from '@/services/seo'
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
}

/**
 * 把某个 URL 渲染成 HTML 字符串。
 *
 * 注意：renderToString 是同步的，所以下面这些模块级状态（语言、数据、head 收集器）
 * 在一次请求内不会被其它请求打断——这是刻意依赖的前提。
 */
export function render({ url, games, posts }: RenderInput): RenderResult {
  const lang = langFromPath(url)
  setLangForRender(lang)
  setSsrPath(stripLang(url.split('?')[0]))

  // 灌数据：服务端没有 localStorage，save() 内部写失败会被忽略，但内存缓存会生效
  gamesStore.save(games)
  postsStore.save(posts)

  beginHeadCollection()
  const html = renderToString(
    <StrictMode>
      <StaticRouter location={url} basename={langPrefix(lang) || undefined}>
        <AppRoutes />
      </StaticRouter>
    </StrictMode>,
  )
  const head = endHeadCollection()
  return { html, head, lang }
}
