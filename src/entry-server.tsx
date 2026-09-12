import { StrictMode } from 'react'
import { renderToString } from 'react-dom/server'
import { StaticRouter } from 'react-router'
import { AppRoutes } from './AppRoutes'
import { setSsrData, type PageData } from '@/services/pageData'
import { setSsrTvHost } from '@/services/tvHost'
import { setLangForRender } from '@/services/lang'
import { beginHeadCollection, endHeadCollection, setSsrPath, splitHoistedHead, takeSsrNotFound, type CollectedHead } from '@/services/seo'
import { langFromPath, langPrefix, stripLang } from '@/config/languages'
import { loadLocale } from '@/locales'

export interface RenderInput {
  /** 完整请求路径（含语言前缀），例如 /en/games/mario */
  url: string
  /** 服务端按路由取好的数据（见 server/src/content.js 的 loadForRoute） */
  data: PageData
  /**
   * 这次请求打在 TV 子域上吗（见 shared/tv-host.js）。
   * 客户端自己看 location.hostname，服务端没有 location，只能由调用方告诉它。
   * 两边算出来的必须一致，否则 `/` 会出现「服务端渲 TV 页、客户端 hydrate 成首页」。
   */
  tvHost?: boolean
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
export async function render({ url, data, tvHost = false }: RenderInput): Promise<RenderResult> {
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
  // 必须在 renderToString 之前、且这条线以下不能有 await（理由同上）
  setSsrTvHost(tvHost)

  // 本页的数据。v1 是把整个游戏库灌进 store，v2 只给这一页要用的那部分。
  setSsrData(data)

  beginHeadCollection()
  takeSsrNotFound() // 清掉上一次的残留
  const rendered = renderToString(
    <StrictMode>
      <StaticRouter location={url} basename={langPrefix(lang) || undefined}>
        <AppRoutes />
      </StaticRouter>
    </StrictMode>,
  )
  const head = endHeadCollection()
  /*
    renderToString 会把 React 自动生成的 `<link rel="preload">` 吐在字符串最前面
    （流式渲染才会自己提进 head）。不摘出来的话它们会落进 #root，而客户端 hydrate 时
    React 把它们提到 head —— 两边的 #root 头几个子节点对不上，报 React #418。
    完整病历见 services/seo.ts 的 splitHoistedHead。
  */
  const { hoisted, body } = splitHoistedHead(rendered)
  if (hoisted.length) head.tags.push(...hoisted)
  setSsrData(null)
  return { html: body, head, lang, notFound: takeSsrNotFound() }
}
