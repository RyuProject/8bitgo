import { StrictMode } from 'react'
import { renderToString } from 'react-dom/server'
import { StaticRouter } from 'react-router'
import { AppRoutes } from './AppRoutes'
import { setSsrData, type PageData } from '@/services/pageData'
import { setLangForRender } from '@/services/lang'
import { beginHeadCollection, endHeadCollection, setSsrPath, takeSsrNotFound, type CollectedHead } from '@/services/seo'
import { langFromPath, langPrefix, stripLang } from '@/config/languages'
import { loadLocale } from '@/locales'

export interface RenderInput {
  /** 完整请求路径（含语言前缀），例如 /en/games/mario */
  url: string
  /** 服务端按路由取好的数据（见 server/src/content.js 的 loadForRoute） */
  data: PageData
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
 * 注意：renderToString 是同步的，所以下面这些模块级状态（语言、页面数据、head 收集器）
 * 在一次请求内不会被其它请求打断——这是刻意依赖的前提。
 *
 * ⚠️ 唯一的 await 必须停在设置模块级状态**之前**。
 * 非基准语言的文案现在是动态 import 的，这里要先等它到位；但如果把 await 放到
 * setLangForRender 之后，两个并发请求就会这样交错：
 *   A 设好状态 → A 让出 → B 覆盖状态 → A 回来用着 B 的语言和数据渲染。
 * 结果是偶发地「英文页面吐出日文内容」，而且只在有并发时出现，极难复现。
 * 所以顺序是：算出语言 → await → 之后一路同步到 renderToString。
 */
export async function render({ url, data }: RenderInput): Promise<RenderResult> {
  // 先把查询串剥掉再判语言。以前直接把 req.originalUrl 传进去，
  // /en?utm_source=x 的首段会被解析成 'en?utm_source=x'，认不出语言 →
  // 按默认中文渲染、basename 为空 → 路由全不匹配 → 服务端吐一个中文 404 页，
  // 客户端却按英文首页 hydrate，两边对不上。
  const pathname = url.split('?')[0].split('#')[0]
  const lang = langFromPath(pathname)

  // —— 这条线以上可以有 await，以下不行 ——
  await loadLocale(lang)

  setLangForRender(lang)
  setSsrPath(stripLang(pathname))

  // 本页的数据。v1 是把整个游戏库灌进 store，v2 只给这一页要用的那部分。
  setSsrData(data)

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
  setSsrData(null)
  return { html, head, lang, notFound: takeSsrNotFound() }
}
