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

export function useSeo(opts: SeoOptions) {
  const t = useT()
  const { title, description, image, type = 'website', noindex = false, canonicalPath, jsonLd } = opts

  // jsonLd 是对象数组，直接进依赖会每次渲染都变；用序列化后的字符串比较。
  const jsonLdKey = jsonLd ? JSON.stringify(jsonLd) : ''

  useEffect(() => {
    const fullTitle = title
      ? fmt(t.site.titleTemplate, { title, site: SITE_NAME })
      : fmt(t.site.defaultTitle, { site: SITE_NAME })
    document.title = fullTitle

    const path = canonicalPath ?? window.location.pathname
    const url = absoluteUrl(path)
    const desc = description ?? ''
    const img = image ? absoluteUrl(image) : absoluteUrl('/og-default.png')

    if (desc) upsertMeta('name', 'description', desc)
    upsertMeta('name', 'robots', noindex ? 'noindex,nofollow' : 'index,follow,max-image-preview:large')

    upsertMeta('property', 'og:title', fullTitle)
    upsertMeta('property', 'og:type', type)
    upsertMeta('property', 'og:url', url)
    upsertMeta('property', 'og:site_name', SITE_NAME)
    if (desc) upsertMeta('property', 'og:description', desc)
    upsertMeta('property', 'og:image', img)
    upsertMeta('property', 'og:locale', getLang())

    upsertMeta('name', 'twitter:card', 'summary_large_image')
    upsertMeta('name', 'twitter:title', fullTitle)
    if (desc) upsertMeta('name', 'twitter:description', desc)
    upsertMeta('name', 'twitter:image', img)

    // canonical：noindex 的页面不需要
    if (!noindex) upsertLink('canonical', url)

    // 结构化数据
    const scripts: HTMLScriptElement[] = []
    if (jsonLd?.length) {
      for (const obj of jsonLd) {
        const s = document.createElement('script')
        s.type = 'application/ld+json'
        s.setAttribute(MARK, '')
        s.textContent = JSON.stringify(obj)
        document.head.appendChild(s)
        scripts.push(s)
      }
    }

    return () => {
      for (const s of scripts) s.remove()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [title, description, image, type, noindex, canonicalPath, jsonLdKey, t])
}

/* ---------------- 结构化数据构造器 ---------------- */

/** 首页：网站 + 站内搜索（可能让 Google 展示搜索框） */
export function websiteSchema(description: string) {
  const origin = siteOrigin()
  return {
    '@context': 'https://schema.org',
    '@type': 'WebSite',
    name: SITE_NAME,
    url: origin + '/',
    description,
    potentialAction: {
      '@type': 'SearchAction',
      target: { '@type': 'EntryPoint', urlTemplate: `${origin}/games?q={search_term_string}` },
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
  rating?: number
  ratingCount?: number
}

/** 游戏详情页：VideoGame + 评分 */
export function videoGameSchema(g: GameSchemaInput) {
  const schema: Record<string, unknown> = {
    '@context': 'https://schema.org',
    '@type': 'VideoGame',
    name: g.name,
    url: absoluteUrl(`/games/${g.slug}`),
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
  // 只有真的有人评分才输出 aggregateRating，否则属于虚假结构化数据
  if (g.rating && g.ratingCount && g.ratingCount > 0) {
    schema.aggregateRating = {
      '@type': 'AggregateRating',
      ratingValue: g.rating,
      ratingCount: g.ratingCount,
      bestRating: 5,
      worstRating: 1,
    }
  }
  return schema
}

/** 博客文章 */
export function articleSchema(p: { title: string; slug: string; excerpt?: string; date?: string; author?: string }) {
  const schema: Record<string, unknown> = {
    '@context': 'https://schema.org',
    '@type': 'BlogPosting',
    headline: p.title,
    url: absoluteUrl(`/blog/${p.slug}`),
    mainEntityOfPage: absoluteUrl(`/blog/${p.slug}`),
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
      item: absoluteUrl(it.path),
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
      url: absoluteUrl(it.path),
    })),
  }
}
