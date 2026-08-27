/**
 * 每个页面的 SEO 头信息。
 *
 * 本站是 SPA（客户端渲染），所以 <head> 里的 title / description / canonical /
 * og / JSON-LD 都要在运行时写入。用法：
 *
 *   useSeo({
 *     title: '全部游戏',
 *     description: '……',
 *     jsonLd: [collectionSchema(...)],
 *   })
 *
 * 说明：
 *  - canonical / og:url 用 VITE_SITE_URL + 当前 pathname（不带查询串，避免筛选参数
 *    产生成千上万个重复页面；需要收录带参数的页面时显式传 canonicalPath）。
 *  - hreflang：站点有 8 种语言，但目前语言是存在 localStorage 的、URL 不区分语言，
 *    所以这里只输出 x-default 指向当前 URL。等接入「按路径分语言」后再补全（见 README）。
 *  - 组件卸载时会把本页写入的标签清理掉，避免路由切换后残留上一页的 meta。
 */
import { useEffect } from 'react'
import { useT, fmt } from './i18n'
import { getLang } from './lang'
import { HREFLANG, LANGUAGES, DEFAULT_LANG, localizedPath, stripLang } from '@/config/languages'

const SITE_NAME = import.meta.env.VITE_SITE_NAME ?? '8BitGo'
const SITE_URL = (import.meta.env.VITE_SITE_URL ?? '').replace(/\/+$/, '')

/** 本页由 useSeo 写入的标签都打上这个标记，便于卸载时精确清理 */
const MARK = 'data-seo-managed'

export interface SeoOptions {
  /** 页面标题（不含站点名，会自动拼成「标题 - 8BitGo」） */
  title?: string
  /** 页面描述，建议 70–160 字符 */
  description?: string
  /** 社交分享图：对象存储 key 或完整 URL */
  image?: string
  /** og:type，文章页传 'article' */
  type?: 'website' | 'article'
  /** 不希望被搜索引擎收录（个人中心、登录、后台等） */
  noindex?: boolean
  /** 覆盖 canonical 的路径，默认取当前 pathname */
  canonicalPath?: string
  /** 结构化数据，可传多个 */
  jsonLd?: object[]
}

/** 站点绝对地址；没配 VITE_SITE_URL 时退回当前域名 */
export function siteOrigin(): string {
  if (SITE_URL) return SITE_URL
  return typeof window === 'undefined' ? '' : window.location.origin
}

export function absoluteUrl(path: string): string {
  const origin = siteOrigin()
  if (/^https?:\/\//i.test(path)) return path
  return origin + (path.startsWith('/') ? path : '/' + path)
}

function upsertMeta(attr: 'name' | 'property', key: string, content: string) {
  let el = document.head.querySelector<HTMLMetaElement>(`meta[${attr}="${key}"]`)
  if (!el) {
    el = document.createElement('meta')
    el.setAttribute(attr, key)
    el.setAttribute(MARK, '')
    document.head.appendChild(el)
  }
  el.setAttribute('content', content)
}

function upsertLink(rel: string, href: string, hreflang?: string) {
  const sel = hreflang ? `link[rel="${rel}"][hreflang="${hreflang}"]` : `link[rel="${rel}"]:not([hreflang])`
  let el = document.head.querySelector<HTMLLinkElement>(sel)
  if (!el) {
    el = document.createElement('link')
    el.setAttribute('rel', rel)
    if (hreflang) el.setAttribute('hreflang', hreflang)
    el.setAttribute(MARK, '')
    document.head.appendChild(el)
  }
  el.setAttribute('href', href)
}


/* ---------------- SSR：渲染期间收集 head ---------------- */

export interface CollectedHead {
  title: string
  tags: string[]
  jsonLd: string[]
}

let collected: CollectedHead | null = null

/**
 * 服务端每次请求前调用：开始收集本次渲染的 head。
 * renderToString 是同步的，一次请求渲染完再处理下一个，所以模块级变量是安全的。
 */
export function beginHeadCollection() {
  collected = { title: '', tags: [], jsonLd: [] }
}

export function endHeadCollection(): CollectedHead {
  const c = collected ?? { title: '', tags: [], jsonLd: [] }
  collected = null
  return c
}

const escapeAttr = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

/** JSON-LD 要防 </script> 提前闭合 */
const escapeJson = (s: string) => s.replace(/</g, '\\u003c')

export function useSeo(opts: SeoOptions) {
  const t = useT()
  const { title, description, image, type = 'website', noindex = false, canonicalPath, jsonLd } = opts

  const lang = getLang()
  const fullTitle = title
    ? fmt(t.site.titleTemplate, { title, site: SITE_NAME })
    : fmt(t.site.defaultTitle, { site: SITE_NAME })

  // 与语言无关的路径（去掉 /en 这类前缀），用来生成各语言的 hreflang
  const barePath =
    canonicalPath ??
    (typeof window === 'undefined' ? currentSsrPath() : stripLang(window.location.pathname))

  const canonicalUrl = absoluteUrl(localizedPath(barePath, lang))
  const img = image ? absoluteUrl(image) : absoluteUrl('/og-default.png')
  const robots = noindex ? 'noindex,nofollow' : 'index,follow,max-image-preview:large'

  /** 本页要写入的所有 meta/link，服务端和客户端共用同一份定义 */
  const metas: Array<['name' | 'property', string, string]> = [
    ['name', 'robots', robots],
    ['property', 'og:title', fullTitle],
    ['property', 'og:type', type],
    ['property', 'og:url', canonicalUrl],
    ['property', 'og:site_name', SITE_NAME],
    ['property', 'og:image', img],
    ['property', 'og:locale', OG_LOCALE[lang] ?? 'en_US'],
    ['name', 'twitter:card', 'summary_large_image'],
    ['name', 'twitter:title', fullTitle],
    ['name', 'twitter:image', img],
  ]
  if (description) {
    metas.push(['name', 'description', description])
    metas.push(['property', 'og:description', description])
    metas.push(['name', 'twitter:description', description])
  }

  // hreflang：每种语言一条，外加 x-default 指向默认语言
  const alternates: Array<[string, string]> = noindex
    ? []
    : [
        ...LANGUAGES.map((l) => [HREFLANG[l.code], absoluteUrl(localizedPath(barePath, l.code))] as [string, string]),
        ['x-default', absoluteUrl(localizedPath(barePath, DEFAULT_LANG))],
      ]

  // ---- 服务端：渲染期间收集，不碰 DOM ----
  if (import.meta.env.SSR && collected) {
    collected.title = fullTitle
    for (const [attr, key, content] of metas) {
      collected.tags.push(`<meta ${attr}="${key}" content="${escapeAttr(content)}" />`)
    }
    if (!noindex) collected.tags.push(`<link rel="canonical" href="${escapeAttr(canonicalUrl)}" />`)
    for (const [hl, href] of alternates) {
      collected.tags.push(`<link rel="alternate" hreflang="${escapeAttr(hl)}" href="${escapeAttr(href)}" />`)
    }
    for (const obj of jsonLd ?? []) {
      collected.tags.push(
        `<script type="application/ld+json">${escapeJson(JSON.stringify(obj))}</script>`,
      )
    }
  }

  // jsonLd 是对象数组，直接进依赖会每次渲染都变；用序列化后的字符串比较
  const jsonLdKey = jsonLd ? JSON.stringify(jsonLd) : ''
  const metaKey = JSON.stringify({ metas, alternates, canonicalUrl, noindex })

  // ---- 客户端：写入 DOM ----
  useEffect(() => {
    document.title = fullTitle
    for (const [attr, key, content] of metas) upsertMeta(attr, key, content)

    // 本页没有 description 时要把上一页的删掉，否则客户端路由切过去之后
    // head 里还留着上一页的描述，和已经更新的 og:url 对不上。
    if (!description) {
      for (const sel of ['meta[name="description"]', 'meta[property="og:description"]', 'meta[name="twitter:description"]']) {
        document.head.querySelector(sel)?.remove()
      }
    }
    // 同理，noindex 页面不写 canonical，也不能留着上一页的
    if (noindex) document.head.querySelector('link[rel="canonical"]')?.remove()
    else upsertLink('canonical', canonicalUrl)

    // 先清掉上一页留下的 hreflang，再按本页写
    document.head.querySelectorAll('link[rel="alternate"][hreflang]').forEach((el) => el.remove())
    for (const [hl, href] of alternates) upsertLink('alternate', href, hl)

    const scripts: HTMLScriptElement[] = []
    for (const obj of jsonLd ?? []) {
      const el = document.createElement('script')
      el.type = 'application/ld+json'
      el.setAttribute(MARK, '')
      el.textContent = JSON.stringify(obj)
      document.head.appendChild(el)
      scripts.push(el)
    }
    return () => {
      for (const el of scripts) el.remove()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fullTitle, metaKey, jsonLdKey])
}

/**
 * 本次服务端渲染是否命中了「页面不存在」。
 *
 * 以前所有 URL 一律返回 200，包括不存在的路径 —— 即所谓 soft 404：
 * 页面上写着 GAME OVER，HTTP 状态码却告诉爬虫和监控「一切正常」，
 * 结果这些垃圾 URL 会被当成正常页面收录。
 */
let ssrNotFound = false
export function markSsrNotFound() {
  ssrNotFound = true
}
export function takeSsrNotFound(): boolean {
  const v = ssrNotFound
  ssrNotFound = false
  return v
}

/** SSR 期间当前请求的路径（由 entry-server 设定） */
let ssrPath = '/'
export function setSsrPath(p: string) {
  ssrPath = p
}
function currentSsrPath(): string {
  return ssrPath
}

/* ---------------- 结构化数据构造器 ---------------- */

/**
 * 当前语言下的绝对 URL。
 *
 * 结构化数据里的页面地址必须和 canonical 指向同一个 URL。以前这里一律用 absoluteUrl，
 * 于是 /en/games/mario 的 canonical 是英文页，JSON-LD 里的 url 和面包屑却全指向中文页 ——
 * 等于把 7 种语言的权重都导回中文站，还和 canonical 自相矛盾。
 * 图片之类与语言无关的资源仍然用 absoluteUrl。
 */
function langUrl(path: string): string {
  return absoluteUrl(localizedPath(path, getLang()))
}

/** Open Graph 的 og:locale 要求 language_TERRITORY，不能直接给 'en' / 'zh-Hans' */
const OG_LOCALE: Record<string, string> = {
  'zh-Hans': 'zh_CN',
  'zh-Hant': 'zh_TW',
  en: 'en_US',
  es: 'es_ES',
  fr: 'fr_FR',
  it: 'it_IT',
  de: 'de_DE',
  ja: 'ja_JP',
}

/** 首页：网站 + 站内搜索（可能让 Google 展示搜索框） */
export function websiteSchema(description: string) {
  return {
    '@context': 'https://schema.org',
    '@type': 'WebSite',
    name: SITE_NAME,
    url: langUrl('/'),
    description,
    potentialAction: {
      '@type': 'SearchAction',
      target: { '@type': 'EntryPoint', urlTemplate: `${langUrl('/games')}?q={search_term_string}` },
      'query-input': 'required name=search_term_string',
    },
  }
}

export interface GameSchemaInput {
  name: string
  slug: string
  description?: string
  image?: string
  platform?: string
  genres?: string[]
  year?: number
  developer?: string
}

/** 游戏详情页：VideoGame + 评分 */
export function videoGameSchema(g: GameSchemaInput) {
  const schema: Record<string, unknown> = {
    '@context': 'https://schema.org',
    '@type': 'VideoGame',
    name: g.name,
    url: langUrl(`/games/${g.slug}`),
    playMode: 'SinglePlayer',
    applicationCategory: 'Game',
    // 浏览器里直接运行
    operatingSystem: 'Web Browser',
    offers: { '@type': 'Offer', price: '0', priceCurrency: 'USD', availability: 'https://schema.org/InStock' },
  }
  if (g.description) schema.description = g.description
  if (g.image) schema.image = absoluteUrl(g.image)
  if (g.platform) schema.gamePlatform = g.platform
  if (g.genres?.length) schema.genre = g.genres
  if (g.year) schema.datePublished = String(g.year)
  if (g.developer) schema.author = { '@type': 'Organization', name: g.developer }
  // 这里刻意不输出 aggregateRating：站内没有评分功能，编一个聚合评分属于虚假结构化数据，
  // Google 对此的处理是取消整站的富媒体摘要资格。将来真做了评分系统再按真实数据补回来。
  return schema
}

/** 博客文章 */
export function articleSchema(p: { title: string; slug: string; excerpt?: string; date?: string; author?: string }) {
  const schema: Record<string, unknown> = {
    '@context': 'https://schema.org',
    '@type': 'BlogPosting',
    headline: p.title,
    url: langUrl(`/blog/${p.slug}`),
    mainEntityOfPage: langUrl(`/blog/${p.slug}`),
    publisher: { '@type': 'Organization', name: SITE_NAME },
  }
  if (p.excerpt) schema.description = p.excerpt
  if (p.date) schema.datePublished = p.date
  if (p.author) schema.author = { '@type': 'Person', name: p.author }
  return schema
}

/** 面包屑：让搜索结果显示层级路径 */
export function breadcrumbSchema(items: Array<{ name: string; path: string }>) {
  return {
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: items.map((it, i) => ({
      '@type': 'ListItem',
      position: i + 1,
      name: it.name,
      item: langUrl(it.path),
    })),
  }
}

/** 常见问题：可能在搜索结果里展开 FAQ 富摘要 */
export function faqSchema(items: Array<{ q: string; a: string }>) {
  return {
    '@context': 'https://schema.org',
    '@type': 'FAQPage',
    mainEntity: items.map((it) => ({
      '@type': 'Question',
      name: it.q,
      acceptedAnswer: { '@type': 'Answer', text: it.a },
    })),
  }
}

/** 列表页：游戏合集 */
export function itemListSchema(name: string, items: Array<{ name: string; path: string }>) {
  return {
    '@context': 'https://schema.org',
    '@type': 'ItemList',
    name,
    numberOfItems: items.length,
    itemListElement: items.map((it, i) => ({
      '@type': 'ListItem',
      position: i + 1,
      name: it.name,
      url: langUrl(it.path),
    })),
  }
}
