#!/usr/bin/env node
/**
 * 检查公开抓取入口与少量 sitemap 代表页：robots.txt、sitemap 索引、各子 sitemap 和可索引 HTML。
 * 供 smoke-watch 从公网定期调用；它不替代 Search Console 的真实抓取与收录状态。
 */
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { SITE_DEFAULT_LANGUAGE, SITE_LANGUAGES } from '../shared/site-languages.js'

const DEFAULT_BASE_URL = 'https://8bitgo.com'
const REQUEST_TIMEOUT_MS = 12_000
const RETRIES = 2
const STATIC_PAGE_SAMPLE_LIMIT = 8
const SITEMAP_CONCURRENCY = 6
// 每个 SSR 页约 270 KB；并发四页会让慢链路的完整响应超过 8 秒，巡检反而制造瞬时流量尖峰。
const PAGE_CONCURRENCY = 2
const HOMEPAGE_COLLECTION_SAMPLE_LIMIT = 8
const SITE_LANGUAGE_CODES = new Set(SITE_LANGUAGES.map(({ code }) => code))
const SITE_HREFLANG_BY_CODE = new Map(SITE_LANGUAGES.map(({ code, hreflang }) => [code, hreflang]))
const SUPPORTED_HREFLANG = new Set(SITE_LANGUAGES.map(({ hreflang }) => hreflang.toLowerCase()))

function parseArgs(argv) {
  const args = [...argv]
  let baseUrl = process.env.SMOKE_WATCH_BASE || DEFAULT_BASE_URL
  while (args.length) {
    const arg = args.shift()
    if (arg === '--base') {
      baseUrl = args.shift() || ''
      continue
    }
    throw new Error(`未知参数：${arg}`)
  }
  const parsed = new URL(baseUrl)
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) {
    throw new Error('--base 必须是没有账号信息的 HTTP(S) 站点地址')
  }
  return parsed.origin
}

async function fetchText(fetchImpl, url) {
  let lastError
  for (let attempt = 1; attempt <= RETRIES; attempt += 1) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
    try {
      const response = await fetchImpl(url, {
        redirect: 'follow',
        signal: controller.signal,
        headers: {
          Accept: 'application/xml, text/plain;q=0.9, */*;q=0.8',
          // 使用常规浏览器 UA 避免把“通用脚本 UA 被风控”误报成站点故障；这不等同于验证真实爬虫。
          'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36',
        },
      })
      const body = await response.text()
      if (response.status !== 200) throw new Error(`HTTP ${response.status}`)
      return {
        body,
        contentType: response.headers.get('content-type') || '',
        xRobotsTag: response.headers.get('x-robots-tag') || '',
      }
    } catch (error) {
      lastError = error
      if (attempt < RETRIES) await new Promise((resolve) => setTimeout(resolve, 500))
    } finally {
      clearTimeout(timer)
    }
  }
  throw new Error(`${url}：${lastError?.name === 'AbortError' ? '请求超时' : lastError?.message || '请求失败'}`)
}

function assertXmlDocument(body, rootTag, label) {
  if (!body.trimStart().startsWith('<?xml')) throw new Error(`${label} 没有 XML 声明`)
  if (!new RegExp(`<${rootTag}(?:\\s|>)`).test(body) || !new RegExp(`</${rootTag}>`).test(body)) {
    throw new Error(`${label} 缺少完整的 <${rootTag}> 根元素`)
  }
}

function assertRobotsPolicy(body) {
  const lines = body.split(/\r?\n/).map((line) => line.split('#', 1)[0].trim()).filter(Boolean)
  const userAgents = lines.filter((line) => /^User-agent\s*:/i.test(line))
  if (userAgents.length !== 1 || !/^User-agent\s*:\s*\*$/i.test(userAgents[0])) {
    throw new Error('robots.txt 必须保持单一 User-agent: * 规则组，避免指定爬虫绕过私密路径限制')
  }
  if (lines.some((line) => /^Disallow\s*:\s*\/$/i.test(line))) throw new Error('robots.txt 禁止了整个站点')
  if (!lines.some((line) => /^Allow\s*:\s*\/$/i.test(line))) throw new Error('robots.txt 未明确允许抓取公开路径')
  if (!lines.some((line) => /^Disallow\s*:\s*\/api\/$/i.test(line))) throw new Error('robots.txt 未限制 /api/ 抓取')
  if (!lines.some((line) => /^Allow\s*:\s*\/api\/games\/\*\/media\/$/i.test(line))) {
    throw new Error('robots.txt 未放行游戏封面 / 视频代理')
  }
}

function sitemapLocations(xml) {
  return [...xml.matchAll(/<loc>\s*([^<]+?)\s*<\/loc>/g)].map((match) => match[1]
    .replaceAll('&amp;', '&')
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&quot;', '"')
    .replaceAll('&apos;', "'"))
}

function sitemapPageLocations(xml) {
  return [...xml.matchAll(/<url\b[^>]*>([\s\S]*?)<\/url>/gi)].map(([, entry]) =>
    entry.match(/<loc>\s*([^<]+?)\s*<\/loc>/i)?.[1]
      ?.replaceAll('&amp;', '&')
      .replaceAll('&lt;', '<')
      .replaceAll('&gt;', '>')
      .replaceAll('&quot;', '"')
      .replaceAll('&apos;', "'"),
  ).filter(Boolean)
}

async function mapInBatches(items, batchSize, callback) {
  const results = []
  for (let index = 0; index < items.length; index += batchSize) {
    const batch = await Promise.all(items.slice(index, index + batchSize).map(callback))
    results.push(...batch)
  }
  return results
}

function tagAttribute(tag, name) {
  const match = tag.match(new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, 'i'))
  return match?.[1] ?? match?.[2] ?? ''
}

function decodeHtmlEntities(value) {
  return value.replace(/&(#x[\da-f]+|#\d+|amp|lt|gt|quot|apos|#39);/gi, (entity, token) => {
    const normalized = token.toLowerCase()
    if (normalized === 'amp') return '&'
    if (normalized === 'lt') return '<'
    if (normalized === 'gt') return '>'
    if (normalized === 'quot') return '"'
    if (normalized === 'apos' || normalized === '#39') return "'"
    const codePoint = normalized.startsWith('#x')
      ? Number.parseInt(normalized.slice(2), 16)
      : Number.parseInt(normalized.slice(1), 10)
    return Number.isInteger(codePoint) && codePoint >= 0 && codePoint <= 0x10ffff
      ? String.fromCodePoint(codePoint)
      : entity
  })
}

function normalizeVisibleText(value) {
  return decodeHtmlEntities(value).replace(/\s+/gu, ' ').trim().normalize('NFC')
}

function jsonLdObjects(value) {
  if (Array.isArray(value)) return value.flatMap(jsonLdObjects)
  if (!value || typeof value !== 'object') return []
  const children = Array.isArray(value['@graph']) ? value['@graph'].flatMap(jsonLdObjects) : []
  return [value, ...children]
}

function videoGameEntity(page) {
  const scripts = [...page.matchAll(/<script\b[^>]*type\s*=\s*(?:"application\/ld\+json"|'application\/ld\+json')[^>]*>([\s\S]*?)<\/script>/gi)]
  for (const [, json] of scripts) {
    try {
      const entities = jsonLdObjects(JSON.parse(json))
      const found = entities.find((entity) => {
        const types = Array.isArray(entity['@type']) ? entity['@type'] : [entity['@type']]
        return types.some((type) => String(type).toLowerCase().split(/[\u002F:#]/).at(-1) === 'videogame')
      })
      if (found) return found
    } catch {
      // 其它 JSON-LD 可能不是严格 JSON；后面仍会查找独立的 VideoGame 实体。
    }
  }
  return null
}

function hydratedGame(page, label) {
  // SSR 把实际传给页面的数据留在 window.__8BITGO__；用它判断已录入的本地标题有没有真正进入首响 HTML。
  const marker = 'window.__8BITGO__='
  const assignment = page.indexOf(marker)
  if (assignment < 0) throw new Error(`${label} 缺少服务端游戏数据`)
  const start = assignment + marker.length
  const end = page.indexOf('</script>', start)
  if (end < 0) throw new Error(`${label} 的服务端游戏数据脚本不完整`)
  let json = page.slice(start, end).trim()
  if (json.endsWith(';')) json = json.slice(0, -1).trimEnd()
  let payload
  try {
    payload = JSON.parse(json)
  } catch {
    throw new Error(`${label} 的服务端游戏数据不是有效 JSON`)
  }
  const game = payload?.data?.game
  if (!game || typeof game.title !== 'string') throw new Error(`${label} 的服务端路由数据缺少游戏标题`)
  return game
}

export function localizedTitleForPage(game, language) {
  if (language === 'zh-Hant') {
    return String(game.titleLocalized?.[language] || game.titleI18n?.[language] || '').trim()
  }
  if (language === 'zh-Hans' || language === 'en') return ''
  return String(game.titleLocalized?.[language] ?? '').trim()
}

function assertGameTitleConsistency(page, label, expectedLanguage) {
  const title = page.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i)?.[1]
  const heading = page.match(/<h1\b[^>]*>([\s\S]*?)<\/h1>/i)?.[1]?.replace(/<[^>]*>/g, '')
  const entity = videoGameEntity(page)
  if (!entity) throw new Error(`${label} 缺少可解析的 VideoGame JSON-LD`)

  const normalizedHeading = normalizeVisibleText(heading ?? '')
  const normalizedName = normalizeVisibleText(String(entity.name ?? ''))
  const game = hydratedGame(page, label)
  const localizedTitle = localizedTitleForPage(game, expectedLanguage)
  if (localizedTitle && normalizeVisibleText(localizedTitle) !== normalizedHeading) {
    throw new Error(`${label} 的 H1 没有使用已保存的 ${expectedLanguage} 游戏标题`)
  }
  if (!normalizedHeading || normalizedHeading !== normalizedName) {
    throw new Error(`${label} 的 VideoGame.name 与页面 H1 不一致`)
  }
  if (!normalizeVisibleText(title ?? '').includes(normalizedHeading)) {
    throw new Error(`${label} 的浏览器标题没有包含页面游戏名`)
  }
  const metaTags = [...page.matchAll(/<meta\b[^>]*>/gi)].map(([tag]) => tag)
  for (const [kind, attribute, expected] of [
    ['Open Graph', 'property', 'og:title'],
    ['Twitter', 'name', 'twitter:title'],
  ]) {
    const tag = metaTags.find((candidate) => tagAttribute(candidate, attribute).toLowerCase() === expected)
    const value = tag ? normalizeVisibleText(tagAttribute(tag, 'content')) : ''
    if (!value || !value.includes(normalizedHeading)) {
      throw new Error(`${label} 的 ${kind} 标题没有包含页面游戏名`)
    }
  }
}

function assertGameHreflang(page, pageUrl, expectedLanguage, label) {
  const requested = new URL(pageUrl)
  const tags = [...page.matchAll(/<link\b[^>]*>/gi)].map(([tag]) => tag).filter((tag) => {
    const rel = tagAttribute(tag, 'rel').toLowerCase().split(/\s+/)
    return rel.includes('alternate') && Boolean(tagAttribute(tag, 'hreflang'))
  })
  const alternates = new Map()
  for (const tag of tags) {
    const language = tagAttribute(tag, 'hreflang').trim().toLowerCase()
    const href = tagAttribute(tag, 'href').replaceAll('&amp;', '&')
    if (!language || alternates.has(language)) throw new Error(`${label} 的 hreflang 缺失或重复：${language || '(空)'}`)
    if (!href) throw new Error(`${label} 的 ${language} hreflang 缺少 URL`)
    if (language !== 'x-default' && !SUPPORTED_HREFLANG.has(language)) {
      throw new Error(`${label} 声明了本站不支持的 hreflang：${language}`)
    }
    let target
    try { target = new URL(href, requested) } catch { throw new Error(`${label} 含无效 hreflang URL：${href}`) }
    if (target.origin !== requested.origin || target.search || target.hash || target.username || target.password) {
      throw new Error(`${label} 的 hreflang 必须指向本站干净 URL：${href}`)
    }
    alternates.set(language, target)
  }

  const expectedHreflang = SITE_HREFLANG_BY_CODE.get(expectedLanguage)?.toLowerCase()
  const self = expectedHreflang ? alternates.get(expectedHreflang) : undefined
  if (!self || self.href !== requested.href) {
    throw new Error(`${label} 缺少指向自身的 ${expectedLanguage} hreflang`)
  }
  if (!alternates.has('x-default')) throw new Error(`${label} 缺少 x-default hreflang`)
}

function assertIndexableHtml(page, pageUrl, expectedLanguage, xRobotsTag, label, expectedCanonicalUrl = pageUrl) {
  if (!page.toLowerCase().includes('<!doctype html')) throw new Error(`${label} 缺少 HTML doctype`)
  const htmlTag = page.match(/<html\b[^>]*>/i)?.[0] ?? ''
  const language = tagAttribute(htmlTag, 'lang')
  if (!language) throw new Error(`${label} 缺少 html[lang]`)
  if (expectedLanguage && language.toLowerCase() !== expectedLanguage.toLowerCase()) {
    throw new Error(`${label} html[lang]=${language}，与 sitemap 语言 ${expectedLanguage} 不符`)
  }

  const title = page.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i)?.[1]?.trim()
  if (!title) throw new Error(`${label} 缺少服务端标题`)
  const heading = page.match(/<h1\b[^>]*>([\s\S]*?)<\/h1>/i)?.[1]
    ?.replace(/<[^>]*>/g, '')
    .trim()
  if (!heading) throw new Error(`${label} 缺少服务端 H1`)

  const canonicalTag = [...page.matchAll(/<link\b[^>]*>/gi)]
    .map(([tag]) => tag)
    .find((tag) => tagAttribute(tag, 'rel').toLowerCase().split(/\s+/).includes('canonical'))
  const canonicalHref = canonicalTag ? tagAttribute(canonicalTag, 'href').replaceAll('&amp;', '&') : ''
  if (!canonicalHref) throw new Error(`${label} 缺少 canonical`)
  const requested = new URL(pageUrl)
  const canonical = new URL(canonicalHref, requested)
  const expectedCanonical = new URL(expectedCanonicalUrl, requested)
  if (canonical.href !== expectedCanonical.href || canonical.origin !== requested.origin || canonical.hash) {
    throw new Error(`${label} canonical 与预期规范 URL 不一致：${canonical.href}（预期 ${expectedCanonical.href}）`)
  }

  const robotsMeta = [...page.matchAll(/<meta\b[^>]*>/gi)]
    .map(([tag]) => tag)
    .filter((tag) => ['robots', 'googlebot', 'bingbot'].includes(tagAttribute(tag, 'name').toLowerCase()))
    .map((tag) => tagAttribute(tag, 'content'))
    .join(',')
  if (/\bnoindex\b/i.test(`${robotsMeta},${xRobotsTag}`)) throw new Error(`${label} 索引入口中的 URL 被 noindex`)
}

function expectedLanguageForSitemap(pathname, pageUrl) {
  const languageSitemap = pathname.match(/\/(?:games|posts|taxonomy)-([A-Za-z-]+)\.xml$/)
  if (languageSitemap) return languageSitemap[1]
  if (pathname === '/sitemaps/collections.xml') {
    const firstPathSegment = new URL(pageUrl).pathname.split('/').filter(Boolean)[0]
    return SITE_LANGUAGE_CODES.has(firstPathSegment) ? firstPathSegment : SITE_DEFAULT_LANGUAGE
  }
  return undefined
}

function homepageCollectionUrls(page, pageUrl, origin) {
  const homepage = new URL(pageUrl)
  const expectedLanguage = homepage.pathname === '/'
    ? SITE_DEFAULT_LANGUAGE
    : homepage.pathname.slice(1)
  const found = new Map()
  for (const [tag] of page.matchAll(/<a\b[^>]*>/gi)) {
    const href = tagAttribute(tag, 'href').replaceAll('&amp;', '&')
    if (!href) continue
    let target
    try { target = new URL(href, homepage) } catch { continue }
    if (target.origin !== origin || target.search || target.hash || target.username || target.password) continue
    const match = target.pathname.match(/^\/(?:([A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*)\/)?collections\/(\d+)\/?$/)
    if (!match) continue
    const language = match[1] || SITE_DEFAULT_LANGUAGE
    if (language !== expectedLanguage) continue
    found.set(target.pathname, {
      pageUrl: target.href,
      expectedLanguage: language,
      // 用户合集只有简体中文一份真实内容，其他 UI 语言路由按页面规则 canonical 回默认路径。
      expectedCanonicalUrl: new URL(`/collections/${match[2]}`, origin).href,
    })
  }
  return [...found.values()].slice(0, HOMEPAGE_COLLECTION_SAMPLE_LIMIT)
}

export async function runCrawlSmoke(baseUrl, fetchImpl = fetch) {
  const origin = new URL(baseUrl).origin
  const robotsUrl = new URL('/robots.txt', origin).href
  const indexUrl = new URL('/sitemap.xml', origin).href
  const robots = await fetchText(fetchImpl, robotsUrl)
  if (!robots.contentType.toLowerCase().includes('text/plain')) throw new Error(`/robots.txt Content-Type 异常：${robots.contentType || '缺失'}`)
  assertRobotsPolicy(robots.body)
  if (!robots.body.includes(`Sitemap: ${indexUrl}`)) throw new Error(`/robots.txt 未声明 ${indexUrl}`)
  console.log('✔ /robots.txt：HTTP 200、纯文本且声明 sitemap')

  const index = await fetchText(fetchImpl, indexUrl)
  if (!index.contentType.toLowerCase().includes('xml')) throw new Error(`/sitemap.xml Content-Type 异常：${index.contentType || '缺失'}`)
  assertXmlDocument(index.body, 'sitemapindex', '/sitemap.xml')
  const locations = sitemapLocations(index.body)
  const staticUrl = new URL('/sitemap-static.xml', origin).href
  const gamesUrl = new URL('/sitemaps/games-zh-Hans.xml', origin).href
  if (!locations.includes(staticUrl)) throw new Error('/sitemap.xml 未列出 sitemap-static.xml')
  if (!locations.includes(gamesUrl)) throw new Error('/sitemap.xml 未列出默认语言游戏 sitemap')
  console.log(`✔ /sitemap.xml：HTTP 200、XML 有效并列出 ${locations.length} 份子 sitemap`)

  for (const location of locations) {
    let parsed
    try { parsed = new URL(location) } catch { throw new Error(`子 sitemap 地址无效：${location}`) }
    if (
      parsed.origin !== origin || parsed.username || parsed.password || parsed.search || parsed.hash ||
      !/^\/(?:sitemap-static\.xml|sitemaps\/[A-Za-z-]+\.xml)$/.test(parsed.pathname)
    ) {
      throw new Error(`子 sitemap 地址必须是本站的标准路径：${location}`)
    }
  }
  if (new Set(locations).size !== locations.length) throw new Error('/sitemap.xml 重复列出子 sitemap')

  const checks = locations.map((url) => [url, `/${new URL(url).pathname.slice(1)}`])
  const sitemapResults = await mapInBatches(checks, SITEMAP_CONCURRENCY, async ([url, label]) => {
    const sitemap = await fetchText(fetchImpl, url)
    if (!sitemap.contentType.toLowerCase().includes('xml')) throw new Error(`${label} Content-Type 异常：${sitemap.contentType || '缺失'}`)
    assertXmlDocument(sitemap.body, 'urlset', label)
    const entries = sitemapPageLocations(sitemap.body)
    const pathname = new URL(url).pathname
    if ((pathname === '/sitemap-static.xml' || pathname === '/sitemaps/games-zh-Hans.xml') && !entries.length) {
      throw new Error(`${label} 没有可抓取 URL`)
    }
    console.log(`✔ ${label}：HTTP 200、XML 有效（${entries.length} 条 URL）`)
    return { url, label, pathname, body: sitemap.body, entries }
  })

  const pageSamples = []
  for (const sitemap of sitemapResults) {
    for (const pageUrl of sitemap.entries) {
      let parsed
      try { parsed = new URL(pageUrl) } catch { throw new Error(`${sitemap.label} 含无效页面 URL：${pageUrl}`) }
      if (parsed.origin !== origin || parsed.username || parsed.password || !['http:', 'https:'].includes(parsed.protocol)) {
        throw new Error(`${sitemap.label} 含本站以外的页面 URL：${pageUrl}`)
      }
    }
    const isStaticSitemap = sitemap.pathname === '/sitemap-static.xml'
    const isGameSitemap = /\/games-[A-Za-z-]+\.xml$/.test(sitemap.pathname)
    const selected = isStaticSitemap
      ? sitemap.entries.slice(0, STATIC_PAGE_SAMPLE_LIMIT)
      : sitemap.entries.slice(0, 1)
    for (const pageUrl of selected) {
      pageSamples.push({
        pageUrl,
        expectedLanguage: isStaticSitemap ? undefined : expectedLanguageForSitemap(sitemap.pathname, pageUrl),
        isGameSitemap,
      })
    }
  }

  // 首页通常也在静态 sitemap 中；放在 sitemap 样本之后，确保保留首页专属检查标记。
  pageSamples.push(
    { pageUrl: new URL('/', origin).href, expectedLanguage: SITE_DEFAULT_LANGUAGE, isHomePage: true },
    { pageUrl: new URL('/ja', origin).href, expectedLanguage: 'ja', isHomePage: true },
  )

  const uniquePageSamples = [...new Map(pageSamples.map((sample) => [sample.pageUrl, sample])).values()]
  const homeCollectionSamples = []
  await mapInBatches(uniquePageSamples, PAGE_CONCURRENCY, async ({ pageUrl, expectedLanguage, isGameSitemap, isHomePage }) => {
    const label = new URL(pageUrl).pathname || '/'
    const page = await fetchText(fetchImpl, pageUrl)
    if (!page.contentType.toLowerCase().includes('text/html')) {
      throw new Error(`${label} Content-Type 异常：${page.contentType || '缺失'}`)
    }
    assertIndexableHtml(page.body, pageUrl, expectedLanguage, page.xRobotsTag, label)
    if (isGameSitemap) {
      assertGameTitleConsistency(page.body, label, expectedLanguage)
      assertGameHreflang(page.body, pageUrl, expectedLanguage, label)
    }
    console.log(`✔ ${label}：HTTP 200、SSR 标题/H1${isGameSitemap ? '/OG/Twitter/VideoGame.name 一致、hreflang 自指与 x-default' : ''}、canonical、语言与索引状态有效`)
    if (isHomePage) homeCollectionSamples.push(...homepageCollectionUrls(page.body, pageUrl, origin))
  })

  const uniqueCollectionSamples = [...new Map(homeCollectionSamples.map((sample) => [sample.pageUrl, sample])).values()]
  await mapInBatches(uniqueCollectionSamples, PAGE_CONCURRENCY, async ({ pageUrl, expectedLanguage, expectedCanonicalUrl }) => {
    const label = new URL(pageUrl).pathname
    const page = await fetchText(fetchImpl, pageUrl)
    if (!page.contentType.toLowerCase().includes('text/html')) {
      throw new Error(`${label} Content-Type 异常：${page.contentType || '缺失'}`)
    }
    assertIndexableHtml(page.body, pageUrl, expectedLanguage, page.xRobotsTag, label, expectedCanonicalUrl)
    console.log(`✔ ${label}：首页推荐合集可索引且没有 noindex`)
  })
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    await runCrawlSmoke(parseArgs(process.argv.slice(2)))
  } catch (error) {
    console.error(`✖ 抓取入口检查失败：${error?.message || error}`)
    process.exitCode = 1
  }
}
