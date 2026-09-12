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
import { HREFLANG, LANGUAGES, FALLBACK_LANG, localizedPath, stripLang, type Lang } from '@/config/languages'
import { romUrlForKey } from './roms'
import { splitDevelopers } from '@/lib/developers'
import { FEATURES } from '@/config/features'

const SITE_NAME = import.meta.env.VITE_SITE_NAME ?? '8BitGo'
const SITE_URL = (import.meta.env.VITE_SITE_URL ?? '').replace(/\/+$/, '')

/** 没有专属配图时的社交卡片图。尺寸是确定的，所以敢往外写 og:image:width/height。 */
const OG_DEFAULT_IMAGE = '/og-default.png'
const OG_DEFAULT_WIDTH = '1200'
const OG_DEFAULT_HEIGHT = '630'

/** 组织标识：128×128 方形单字标，Google 认站点 logo 用的就是它。 */
const SITE_LOGO = '/ui/logo-mark.png'
const SITE_LOGO_SIZE = 128

/**
 * 官方 X / Twitter 账号（形如 @8bitgo）。**没有就留空**：
 * twitter:site 指向一个不存在的账号，卡片上会显示成一个点不开的链接。
 * 配在 .env.production 里（构建期变量，公开信息）。
 */
const TWITTER_SITE = (import.meta.env.VITE_TWITTER_SITE ?? '').trim()

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
  /**
   * 内容**最新回复时间**（头条时间因子的 lrDate_time）。
   * 没有回复就别传 —— 那个标签会整条不输出，绝不拿更新时间凑数。
   */
  replyTime?: string
  /** 不希望被搜索引擎收录（个人中心、登录、后台等） */
  noindex?: boolean
  /** 覆盖 canonical 的路径，默认取当前 pathname */
  canonicalPath?: string
  /**
   * 覆盖 canonical / og:url / hreflang 的**站点根地址**，默认是 VITE_SITE_URL。
   *
   * 目前只有一处用：TV 页搬到了 tv.8bitgo.com，它的正牌地址在子域上，
   * 而站点其余页面仍然以主域为准（见 shared/tv-host.js）。
   * ⚠️ canonical、og:url 和 hreflang 必须**一起**换 —— 只换 canonical 的话，
   * hreflang 会把 8 种语言都指回主域，等于自己和自己打架：
   * canonical 说「我在子域」，hreflang 说「我的各语言版本都在主域」。
   */
  canonicalOrigin?: string
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

/* ---------------- SSR：把 React 吐在 body 最前面的 head 标签摘回去 ---------------- */

/**
 * React 19 会为树里的 `<img src>` **自动生成** `<link rel="preload" as="image">`。
 *
 * 流式渲染（renderToPipeableStream）会把它们放进 `<head>`；而我们用的是同步的
 * `renderToString` —— 它手里没有 document，只能把这些标签**原样吐在返回字符串的最前面**，
 * 也就是最后落进 `<div id="root">` 里。客户端 hydrate 时 React 又按规矩把它们提到
 * `<head>`，于是 `#root` 的头几个子节点服务端有、客户端没有：
 *
 *     Uncaught Error: Minified React error #418
 *     （Hydration failed because the server rendered HTML didn't match the client）
 *
 * 2026-09-11 线上实测，`#root` 的前 4 个子节点是：
 *     <link rel="preload" as="image" href="/ui/logo-8bitgo.png">        ← Logo.tsx
 *     <link rel="preload" as="image" href="/ui/random-button/left.svg">  ← Sidebar.tsx
 *     <link rel="preload" as="image" href="/ui/random-button/middle.svg">
 *     <link rel="preload" as="image" href="/ui/random-button/right.svg">
 * 而客户端的 `#root` 只有 2 个子节点 —— 差的正是这 4 条。
 *
 * 所以这里把开头那一串摘下来交给 `<head>`，等于手工补上流式渲染本来会做的那一步。
 * 顺带还是**性能上的正收益**：preload 放在 head 里才是它该在的位置，
 * 放在 body 尾部的 `#root` 里等于白写一条（浏览器读到它时图片早就开始下了）。
 *
 * ⚠️ **只从字符串开头连续地摘**，不全文扫描：React 把这些放在最前面，
 * 而页面正文里如果哪天真出现一个 `<link>`，全文扫会把它一起摘走 —— 那是内容丢失，
 * 比多一次 hydration 警告严重得多。
 *
 * ⚠️ 只认 link / meta。`<title>` 故意不收：站点标题已经由 useSeo 收集在 head.title 里，
 * 再摘一个进去就是两个 `<title>`。
 */
const HOISTED_HEAD_TAG = /^\s*<(?:link|meta)\b[^>]*\/?>/i

export function splitHoistedHead(html: string): { hoisted: string[]; body: string } {
  const hoisted: string[] = []
  let body = html
  for (;;) {
    const m = HOISTED_HEAD_TAG.exec(body)
    if (!m) break
    hoisted.push(m[0].trim())
    body = body.slice(m[0].length)
  }
  return { hoisted, body }
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
    replyTime,
    noindex = false,
    canonicalPath,
    canonicalOrigin,
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

  /**
   * barePath 在某个语言下的绝对地址。canonicalOrigin 给了就换根，否则还是站点主域。
   * canonical / og:url / hreflang 三处都走它，保证要么一起在主域、要么一起在子域。
   */
  const urlInLang = (l: Lang): string => {
    const p = localizedPath(barePath, l)
    return canonicalOrigin ? canonicalOrigin + p : absoluteUrl(p)
  }
  const canonicalUrl = urlInLang(lang)
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
  const imgPath = (image ? romUrlForKey(image) : '') || OG_DEFAULT_IMAGE
  const img = absoluteUrl(imgPath)
  /** 只有默认图的尺寸是确定的。封面各不相同，宁可不写也别写错 —— 见下面 metas 里的说明。 */
  const knownImageSize = imgPath === OG_DEFAULT_IMAGE
  /**
   * `noindex` 的页面为什么给 **follow** 而不是 nofollow（2026-09-11 改）。
   *
   * Bing Webmaster 报了一条「Important pages using meta robots tag that need review」。
   * 站内确实有几页是 `noindex` 而且**挂在全站导航上**：`/rooms`（侧边栏「一起玩」+ 页脚
   * 「8BitGo TV」）、`/apps`、`/submit`、`/open`。这些页该不该收录 —— **不该**：
   * 房间列表是几分钟就变的实时内容、`/apps` 是未上线功能的占位、`/submit` 和 `/open`
   * 是表单和控制台。所以 noindex 保留。
   *
   * 但 `nofollow` 是多余且有害的：它告诉爬虫**连这一页上的链接都别跟**，
   * 而 `/rooms` 整页都是通往游戏详情页的链接、搜索结果页（`/games?q=`）同理 ——
   * 等于把这些页面的内链权重全部掐断。正确的组合是「这一页别收录，但请顺着它往下爬」。
   *
   * ⚠️ 别改回 nofollow 来「省抓取预算」：抓取预算该用 robots.txt 和 sitemap 管，
   * 用 nofollow 管的代价是内链图被打断，而那是看不见的。
   */
  const robots = noindex ? 'noindex,follow' : 'index,follow,max-image-preview:large'

  /** 本页要写入的所有 meta/link，服务端和客户端共用同一份定义 */
  const metas: Array<['name' | 'property', string, string]> = [
    ['name', 'robots', robots],
    ['property', 'og:title', fullTitle],
    ['property', 'og:type', type],
    ['property', 'og:url', canonicalUrl],
    ['property', 'og:site_name', SITE_NAME],
    ['property', 'og:image', img],
    // 图片的替代文字。读屏软件和图片加载失败时用得上，也是社交平台推荐的字段。
    ['property', 'og:image:alt', fullTitle],
    ['property', 'og:locale', OG_LOCALE[lang] ?? 'en_US'],
    ['name', 'twitter:card', 'summary_large_image'],
    ['name', 'twitter:title', fullTitle],
    ['name', 'twitter:image', img],
  ]
  /**
   * og:image:width / height 只在用默认图时输出。
   *
   * 这两个字段的作用是让平台在真正取到图之前就按比例预留位置，**写错比不写更糟**：
   * 抓取端会按声明的尺寸排版，和实际不符时卡片会裂开或被裁掉。
   * 游戏封面存在对象存储上、尺寸各不相同，这里拿不到，所以一律不声明。
   */
  if (knownImageSize) {
    metas.push(['property', 'og:image:width', OG_DEFAULT_WIDTH])
    metas.push(['property', 'og:image:height', OG_DEFAULT_HEIGHT])
  }
  if (TWITTER_SITE) metas.push(['name', 'twitter:site', TWITTER_SITE])
  if (description) {
    metas.push(['name', 'description', description])
    metas.push(['property', 'og:description', description])
    metas.push(['name', 'twitter:description', description])
  }
  const published = contentTime(publishedTime)
  const updated = contentTime(updatedTime || publishedTime)
  /**
   * 站长平台的字段解释表写得很清楚，三个字段各有各的含义：
   *   published_time = 内容发布时间
   *   updated_time   = 内容更新时间
   *   lrDate_time    = 内容**最新回复时间**
   *
   * 这里以前把 lrDate_time 也填成了更新时间 —— 那是照着平台**示例**推断的，
   * 而示例里这两个恰好是同一个时间戳，于是被当成了「两个字段一个意思」。
   * 结果是两个标签永远一模一样，把「有没有人回复、最后一条什么时候」谎报了一遍。
   *
   * 现在只有真的有可见回复时才输出 lrDate_time（游戏详情页取最新一条可见评论的时间）。
   * 没有回复的页面**整条不写** —— 时间因子是拿来换落地页体验评分的，填错比不填更亏。
   */
  const replied = contentTime(replyTime)
  if (published) metas.push(['property', 'bytedance:published_time', published])
  if (updated) metas.push(['property', 'bytedance:updated_time', updated])
  if (replied) metas.push(['property', 'bytedance:lrDate_time', replied])

  // hreflang：每种语言一条，外加 x-default 指向英语版（语言对不上的人看这份）
  const alternates: Array<[string, string]> = noindex
    ? []
    : [
        ...LANGUAGES.map((l) => [HREFLANG[l.code], urlInLang(l.code)] as [string, string]),
        ['x-default', urlInLang(FALLBACK_LANG)],
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
    // 上一页用的是默认图（带尺寸），这一页换成了封面 —— 尺寸必须删掉，
    // 否则社交平台会按 1200×630 去排一张完全不同比例的封面。
    if (!knownImageSize) {
      document.head.querySelector('meta[property="og:image:width"]')?.remove()
      document.head.querySelector('meta[property="og:image:height"]')?.remove()
    }
    // 从内容详情切到列表页时必须删掉上一页的时间，否则列表页会冒充那篇内容的日期。
    if (!published) document.head.querySelector('meta[property="bytedance:published_time"]')?.remove()
    if (!updated) document.head.querySelector('meta[property="bytedance:updated_time"]')?.remove()
    // 从「有人回复过的游戏」切到「一条回复都没有的游戏」，这条必须跟着消失
    if (!replied) document.head.querySelector('meta[property="bytedance:lrDate_time"]')?.remove()
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

/**
 * 站点所属组织。**只放首页** —— Google 用它认站点名称和 logo，每页重复没有额外收益。
 *
 * url 用裸路径首页，而不是 langUrl('/')：组织是同一个实体，八种语言不该拆成八个
 * Organization。这和上面 langUrl 那条注释不冲突 —— 「JSON-LD 的 url 必须等于 canonical」
 * 约束的是描述**当前页面**的那些类型（VideoGame、BlogPosting、面包屑）。
 */
export function organizationSchema() {
  return {
    '@context': 'https://schema.org',
    '@type': 'Organization',
    name: SITE_NAME,
    url: absoluteUrl('/'),
    logo: {
      '@type': 'ImageObject',
      url: absoluteUrl(SITE_LOGO),
      width: SITE_LOGO_SIZE,
      height: SITE_LOGO_SIZE,
    },
    // 有了官方社媒账号在这里补 sameAs: ['https://x.com/…', …]，
    // Google 靠它把站点和那些账号认成同一个主体。
  }
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
  /** 加权平均分（1~5）。0 = 还没人评过 */
  rating?: number
  /** 评分人数 */
  ratingCount?: number
}

/**
 * 少于这么多人评分就不往 schema.org 里写 aggregateRating。
 *
 * 不是因为一两票的分数不真实 —— 它是真的。是因为「⭐ 5.0（1 条评价）」出现在
 * 搜索结果里，读者只会读成刷出来的，而 Google 对判定为操纵评分的站点的处理是
 * 取消**整站**的富媒体摘要资格。等样本够了再露面，代价小得多。
 */
const MIN_RATINGS_FOR_SCHEMA = 5

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
  /**
   * 真实的聚合评分才输出。三道门都得过：功能开着、有人评过、样本够。
   *
   * ⚠️ 绝不能因为「有这个字段」就输出 —— 没人评分时 rating 是 0，
   * 而 0 在 1~5 分制里根本不是合法评分。把它当成真实评分发出去就是虚假结构化数据，
   * 代价是整站的富媒体摘要资格。
   */
  if (FEATURES.ratings && g.rating && g.rating > 0 && (g.ratingCount ?? 0) >= MIN_RATINGS_FOR_SCHEMA) {
    schema.aggregateRating = {
      '@type': 'AggregateRating',
      ratingValue: g.rating.toFixed(1),
      ratingCount: g.ratingCount,
      bestRating: 5,
      worstRating: 1,
    }
  }
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
