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
 *  - hreflang：8 种语言各输出一条 alternate，外加 x-default 指向**英语**版
 *    （FALLBACK_LANG）—— x-default 的语义是「语言对不上的人看哪份」，
 *    对一个面向全球的站来说那应该是英语，而不是站点母语简体中文。
 *    index.html 里那段自动跳转脚本用的是同一套兜底规则，两边要保持一致。
 *  - 组件卸载时会把本页写入的标签清理掉，避免路由切换后残留上一页的 meta。
 */
import { useEffect } from 'react'
import { useT, fmt } from './i18n'
import { getLang } from './lang'
import { HREFLANG, LANGUAGES, FALLBACK_LANG, localizedPath, stripLang } from '@/config/languages'
import { romUrlForKey } from './roms'
import { splitDevelopers } from '@/lib/developers'

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
  /** 内容首次发布时间；日期值会按本站时区补成 ISO 8601 */
  publishedTime?: string
  /** 内容最后更新时间；日期值会按本站时区补成 ISO 8601 */
  updatedTime?: string
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

/**
 * 头条时间因子要求完整 ISO 8601。数据库的 TIMESTAMP 已带真实时刻；后台只填了
 * YYYY-MM-DD 时没有可凭空恢复的钟点，因此统一取当天零点，并明确写东八区偏移。
 */
function contentTime(value?: string): string {
  const s = value?.trim() ?? ''
  if (!s) return ''
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? `${s}T00:00:00+08:00` : s
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
  const {
    title,
    description,
    image,
    type = 'website',
    publishedTime,
    updatedTime,
    noindex = false,
    canonicalPath,
    jsonLd,
  } = opts

  const lang = getLang()
  const fullTitle = title
    ? fmt(t.site.titleTemplate, { title, site: SITE_NAME })
    : fmt(t.site.defaultTitle, { site: SITE_NAME })

  // 与语言无关的路径（去掉 /en 这类前缀），用来生成各语言的 hreflang
  const barePath =
    canonicalPath ??
    (typeof window === 'undefined' ? currentSsrPath() : stripLang(window.location.pathname))

  const canonicalUrl = absoluteUrl(localizedPath(barePath, lang))
  /**
   * 社交卡片图。
   *
   * 传进来的 image 可能是三种东西：对象存储 key（封面就是这种，`covers/xxx.jpg`）、
   * 站内路径（`/og-default.png`）、完整 URL。romUrlForKey 三种都认，而 absoluteUrl 不认
   * 第一种 —— 直接拿站点域名去拼，结果是 https://本站/covers/xxx.jpg，一个 404。
   * 封面真身在对象存储上（assets.…），页面里的封面走的是 romUrlForKey 所以看着正常，
   * 只有 og:image 和结构化数据这两处是坏的：分享出去没图，富媒体摘要也拿不到图。
   *
   * 拼不出地址（没配公开根地址）时退回默认图，别输出一个必然 404 的 URL。
   */
  const img = absoluteUrl((image ? romUrlForKey(image) : '') || '/og-default.png')
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
  const published = contentTime(publishedTime)
  const updated = contentTime(updatedTime || publishedTime)
  if (published) metas.push(['property', 'bytedance:published_time', published])
  if (updated) {
    // 平台给出的示例中 lrDate_time 与 updated_time 都表示本页最后更新时间。
    metas.push(['property', 'bytedance:lrDate_time', updated])
    metas.push(['property', 'bytedance:updated_time', updated])
  }

  // hreflang：每种语言一条，外加 x-default 指向英语版（语言对不上的人看这份）
  const alternates: Array<[string, string]> = noindex
    ? []
    : [
        ...LANGUAGES.map((l) => [HREFLANG[l.code], absoluteUrl(localizedPath(barePath, l.code))] as [string, string]),
        ['x-default', absoluteUrl(localizedPath(barePath, FALLBACK_LANG))],
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
    // 从内容详情切到列表页时必须删掉上一页的时间，否则列表页会冒充那篇内容的日期。
    if (!published) document.head.querySelector('meta[property="bytedance:published_time"]')?.remove()
    if (!updated) {
      document.head.querySelector('meta[property="bytedance:lrDate_time"]')?.remove()
      document.head.querySelector('meta[property="bytedance:updated_time"]')?.remove()
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
  // 同 og:image：封面存的是对象 key，得先拼成公开地址（拼不出来就不输出这个字段）
  const imageUrl = g.image ? romUrlForKey(g.image) : ''
  if (imageUrl) schema.image = absoluteUrl(imageUrl)
  if (g.platform) schema.gamePlatform = g.platform
  if (g.genres?.length) schema.genre = g.genres
  if (g.year) schema.datePublished = String(g.year)
  const developers = splitDevelopers(g.developer)
  if (developers.length) schema.author = developers.map((name) => ({ '@type': 'Organization', name }))
  // 这里刻意不输出 aggregateRating：站内没有评分功能，编一个聚合评分属于虚假结构化数据，
  // Google 对此的处理是取消整站的富媒体摘要资格。将来真做了评分系统再按真实数据补回来。
  return schema
}

/** 博客文章 */
export function articleSchema(p: {
  title: string
  slug: string
  excerpt?: string
  date?: string
  updated?: string
  author?: string
}) {
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
  if (p.updated) schema.dateModified = p.updated
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
