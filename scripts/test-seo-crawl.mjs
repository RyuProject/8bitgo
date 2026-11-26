import assert from 'node:assert/strict'
import test from 'node:test'
import { localizedTitleForPage, runCrawlSmoke } from './smoke-seo-crawl.mjs'

const origin = 'https://example.test'

test('crawl smoke uses the automatic Traditional Chinese title when the manual field is blank', () => {
  assert.equal(localizedTitleForPage({
    titleLocalized: { 'zh-Hant': '' },
    titleI18n: { 'zh-Hant': '寶可夢 火紅' },
  }, 'zh-Hant'), '寶可夢 火紅')
})

const responses = new Map([
  ['/robots.txt', {
    contentType: 'text/plain; charset=utf-8',
    body: `User-agent: *\nAllow: /\nAllow: /api/games/*/media/\nDisallow: /api/\nSitemap: ${origin}/sitemap.xml\n`,
  }],
  ['/sitemap.xml', {
    contentType: 'application/xml; charset=utf-8',
    body: `<?xml version="1.0" encoding="UTF-8"?><sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><sitemap><loc>${origin}/sitemap-static.xml</loc></sitemap><sitemap><loc>${origin}/sitemaps/collections.xml</loc></sitemap><sitemap><loc>${origin}/sitemaps/games-zh-Hans.xml</loc></sitemap><sitemap><loc>${origin}/sitemaps/games-en.xml</loc></sitemap><sitemap><loc>${origin}/sitemaps/games-ja.xml</loc></sitemap><sitemap><loc>${origin}/sitemaps/posts-ja.xml</loc></sitemap><sitemap><loc>${origin}/sitemaps/taxonomy-ja.xml</loc></sitemap></sitemapindex>`,
  }],
  ['/sitemap-static.xml', {
    contentType: 'application/xml; charset=utf-8',
    body: `<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>${origin}/</loc></url></urlset>`,
  }],
  ['/sitemaps/collections.xml', {
    contentType: 'application/xml; charset=utf-8',
    body: `<?xml version="1.0" encoding="UTF-8"?><urlset><url><loc>${origin}/collections/1</loc></url></urlset>`,
  }],
  ['/sitemaps/games-zh-Hans.xml', {
    contentType: 'application/xml; charset=utf-8',
    body: `<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>${origin}/games/super-mario-bros</loc></url></urlset>`,
  }],
  ['/sitemaps/games-en.xml', {
    contentType: 'application/xml; charset=utf-8',
    body: `<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>${origin}/en/games/super-mario-bros</loc></url></urlset>`,
  }],
  ['/sitemaps/games-ja.xml', {
    contentType: 'application/xml; charset=utf-8',
    body: `<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>${origin}/ja/games/pokemon-firered</loc></url></urlset>`,
  }],
  ['/sitemaps/posts-ja.xml', {
    contentType: 'application/xml; charset=utf-8',
    body: `<?xml version="1.0" encoding="UTF-8"?><urlset><url><loc>${origin}/ja/posts/example</loc></url></urlset>`,
  }],
  ['/sitemaps/taxonomy-ja.xml', {
    contentType: 'application/xml; charset=utf-8',
    body: `<?xml version="1.0" encoding="UTF-8"?><urlset><url><loc>${origin}/ja/genres/action</loc></url></urlset>`,
  }],
  ['/', {
    contentType: 'text/html; charset=utf-8',
    body: '<!doctype html><html lang="zh-Hans"><head><title>8BitGo</title><link rel="canonical" href="https://example.test/"></head><body><h1>在线玩游戏</h1><a href="/collections/2">精选合集</a></body></html>',
  }],
  ['/ja', {
    contentType: 'text/html; charset=utf-8',
    body: '<!doctype html><html lang="ja"><head><title>8BitGo</title><link rel="canonical" href="https://example.test/ja"></head><body><h1>ゲームを遊ぶ</h1><a href="/ja/collections/1">おすすめ</a></body></html>',
  }],
  ['/collections/2', {
    contentType: 'text/html; charset=utf-8',
    body: '<!doctype html><html lang="zh-Hans"><head><title>精选游戏</title><link rel="canonical" href="https://example.test/collections/2"></head><body><h1>精选游戏</h1></body></html>',
  }],
  ['/collections/1', {
    contentType: 'text/html; charset=utf-8',
    body: '<!doctype html><html lang="zh-Hans"><head><title>精选合集</title><link rel="canonical" href="https://example.test/collections/1"></head><body><h1>精选合集</h1></body></html>',
  }],
  ['/games/super-mario-bros', {
    contentType: 'text/html; charset=utf-8',
    body: '<!doctype html><html lang="zh-Hans"><head><title>超级马力欧兄弟</title><meta property="og:title" content="超级马力欧兄弟"><meta name="twitter:title" content="超级马力欧兄弟"><link rel="canonical" href="https://example.test/games/super-mario-bros"><link rel="alternate" hreflang="zh-Hans" href="https://example.test/games/super-mario-bros"><link rel="alternate" hreflang="x-default" href="https://example.test/en/games/super-mario-bros"><script type="application/ld+json">{"@type":"VideoGame","name":"超级马力欧兄弟"}</script></head><body><h1>超级马力欧兄弟</h1></body></html>',
  }],
  ['/en/games/super-mario-bros', {
    contentType: 'text/html; charset=utf-8',
    body: '<!doctype html><html lang="en"><head><title>Play Super Mario Bros. (NES) Online - 8BitGo</title><meta property="og:title" content="Play Super Mario Bros. (NES) Online - 8BitGo"><meta name="twitter:title" content="Play Super Mario Bros. (NES) Online - 8BitGo"><link rel="canonical" href="https://example.test/en/games/super-mario-bros"><link rel="alternate" hreflang="en" href="https://example.test/en/games/super-mario-bros"><link rel="alternate" hreflang="x-default" href="https://example.test/en/games/super-mario-bros"><script type="application/ld+json">{"@type":"VideoGame","name":"Super Mario Bros."}</script></head><body><h1>Super Mario Bros.</h1></body></html>',
  }],
  ['/ja/games/pokemon-firered', {
    contentType: 'text/html; charset=utf-8',
    body: '<!doctype html><html lang="ja"><head><title>ポケットモンスター ファイアレッド（GBA）をオンラインでプレイ｜8BitGo</title><meta property="og:title" content="ポケットモンスター ファイアレッド（GBA）をオンラインでプレイ｜8BitGo"><meta name="twitter:title" content="ポケットモンスター ファイアレッド（GBA）をオンラインでプレイ｜8BitGo"><link rel="canonical" href="https://example.test/ja/games/pokemon-firered"><link rel="alternate" hreflang="ja" href="https://example.test/ja/games/pokemon-firered"><link rel="alternate" hreflang="x-default" href="https://example.test/en/games/pokemon-firered"><script type="application/ld+json">{"@graph":[{"@type":["https://schema.org/VideoGame","WebApplication"],"name":"ポケットモンスター ファイアレッド"}]}</script></head><body><h1>ポケットモンスター ファイアレッド</h1></body></html>',
  }],
  ['/ja/collections/1', {
    contentType: 'text/html; charset=utf-8',
    body: '<!doctype html><html lang="ja"><head><title>コレクション</title><link rel="canonical" href="https://example.test/collections/1"></head><body><h1>コレクション</h1></body></html>',
  }],
  ['/ja/posts/example', {
    contentType: 'text/html; charset=utf-8',
    body: '<!doctype html><html lang="ja"><head><title>記事</title><link rel="canonical" href="https://example.test/ja/posts/example"></head><body><h1>記事</h1></body></html>',
  }],
  ['/ja/genres/action', {
    contentType: 'text/html; charset=utf-8',
    body: '<!doctype html><html lang="ja"><head><title>アクション</title><link rel="canonical" href="https://example.test/ja/genres/action"></head><body><h1>アクション</h1></body></html>',
  }],
])

function fakeFetch({ failures = new Map(), overrides = new Map() } = {}) {
  const calls = []
  const fetchImpl = async (url, init) => {
    const path = new URL(url).pathname
    calls.push({ url, path, init })
    const remaining = failures.get(path) ?? 0
    if (remaining > 0) {
      failures.set(path, remaining - 1)
      return new Response('temporary error', { status: 503, headers: { 'content-type': 'text/plain' } })
    }
    const entry = overrides.get(path) ?? responses.get(path)
    if (!entry) return new Response('not found', { status: 404 })
    let body = entry.body
    const gameRoute = path.match(/^\/(?:([A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*)\/)?games\/([^/]+)$/)
    if (gameRoute) {
      const [, language = 'zh-Hans', slug] = gameRoute
      const game = { slug, title: slug === 'pokemon-firered' ? 'Pokémon FireRed' : 'Super Mario Bros.' }
      if (language === 'ja' && slug === 'pokemon-firered') {
        game.titleLocalized = { ja: 'ポケットモンスター ファイアレッド' }
      }
      // 线上游戏详情页用这份 SSR 数据驱动 H1 / meta / JSON-LD，测试也要模拟这条真实数据链。
      const serialized = `<script>window.__8BITGO__=${JSON.stringify({ data: { game }, lang: language })}</script>`
      body = body.replace('</body>', `${serialized}</body>`)
    }
    return new Response(body, {
      status: entry.status ?? 200,
      headers: {
        'content-type': entry.contentType,
        ...(entry.xRobotsTag ? { 'x-robots-tag': entry.xRobotsTag } : {}),
      },
    })
  }
  return { fetchImpl, calls }
}

test('crawl smoke validates every listed sitemap and samples indexable pages by type and language', async () => {
  const { fetchImpl, calls } = fakeFetch()
  await runCrawlSmoke(origin, fetchImpl)
  assert.deepEqual(new Set(calls.map(({ path }) => path)), new Set([
    '/robots.txt',
    '/sitemap.xml',
    '/sitemap-static.xml',
    '/sitemaps/collections.xml',
    '/sitemaps/games-zh-Hans.xml',
    '/sitemaps/games-en.xml',
    '/sitemaps/games-ja.xml',
    '/sitemaps/posts-ja.xml',
    '/sitemaps/taxonomy-ja.xml',
    '/',
    '/ja',
    '/collections/1',
    '/games/super-mario-bros',
    '/en/games/super-mario-bros',
    '/ja/games/pokemon-firered',
    '/ja/collections/1',
    '/collections/2',
    '/ja/posts/example',
    '/ja/genres/action',
  ]))
  for (const { init } of calls) {
    assert.match(init.headers['User-Agent'], /Chrome\//)
    assert.doesNotMatch(init.headers['User-Agent'], /Googlebot|Bingbot|OAI-SearchBot/)
  }
})

test('crawl smoke retries one transient endpoint failure', async () => {
  const failures = new Map([['/sitemap.xml', 1]])
  const { fetchImpl, calls } = fakeFetch({ failures })
  await runCrawlSmoke(origin, fetchImpl)
  assert.equal(calls.filter(({ path }) => path === '/sitemap.xml').length, 2)
})

test('crawl smoke catches robots rules that block search or expose crawler-specific groups', async () => {
  const blockedRobots = new Map([['/robots.txt', {
    contentType: 'text/plain; charset=utf-8',
    body: `User-agent: *\nDisallow: /\nDisallow: /api/\nAllow: /api/games/*/media/\nSitemap: ${origin}/sitemap.xml\n`,
  }]])
  await assert.rejects(runCrawlSmoke(origin, fakeFetch({ overrides: blockedRobots }).fetchImpl), /禁止了整个站点/)

  const splitGroups = new Map([['/robots.txt', {
    contentType: 'text/plain; charset=utf-8',
    body: `User-agent: *\nAllow: /\nDisallow: /api/\nAllow: /api/games/*/media/\nUser-agent: Googlebot\nAllow: /\nSitemap: ${origin}/sitemap.xml\n`,
  }]])
  await assert.rejects(runCrawlSmoke(origin, fakeFetch({ overrides: splitGroups }).fetchImpl), /单一 User-agent/)
})

test('crawl smoke rejects successful but non-200 sitemap responses', async () => {
  const overrides = new Map([['/sitemap-static.xml', {
    status: 206,
    contentType: 'application/xml',
    body: `<?xml version="1.0"?><urlset><url><loc>${origin}/</loc></url></urlset>`,
  }]])
  const { fetchImpl } = fakeFetch({ overrides })
  await assert.rejects(runCrawlSmoke(origin, fetchImpl), /HTTP 206/)
})

test('crawl smoke fails when the sitemap index omits the required default-language sitemap', async () => {
  const overrides = new Map([['/sitemap.xml', {
    contentType: 'application/xml',
    body: `<?xml version="1.0"?><sitemapindex><sitemap><loc>${origin}/sitemap-static.xml</loc></sitemap></sitemapindex>`,
  }]])
  const { fetchImpl } = fakeFetch({ overrides })
  await assert.rejects(runCrawlSmoke(origin, fetchImpl), /未列出默认语言游戏 sitemap/)
})

test('crawl smoke rejects HTML error pages served with HTTP 200', async () => {
  const overrides = new Map([['/sitemap-static.xml', {
    contentType: 'text/html',
    body: '<html><body>challenge</body></html>',
  }]])
  const { fetchImpl } = fakeFetch({ overrides })
  await assert.rejects(runCrawlSmoke(origin, fetchImpl), /Content-Type 异常/)
})

test('crawl smoke checks representative pages for SSR title, H1, canonical, language and indexing', async () => {
  const overrides = new Map([['/ja/games/pokemon-firered', {
    contentType: 'text/html; charset=utf-8',
    xRobotsTag: 'noindex',
    body: '<!doctype html><html lang="ja"><head><title>Pokémon FireRed（GBA）をオンラインでプレイ｜8BitGo</title><meta property="og:title" content="Pokémon FireRed（GBA）をオンラインでプレイ｜8BitGo"><meta name="twitter:title" content="Pokémon FireRed（GBA）をオンラインでプレイ｜8BitGo"><link rel="canonical" href="https://example.test/ja/games/pokemon-firered"><link rel="alternate" hreflang="ja" href="https://example.test/ja/games/pokemon-firered"><link rel="alternate" hreflang="x-default" href="https://example.test/en/games/pokemon-firered"><script type="application/ld+json">{"@type":"VideoGame","name":"Pokémon FireRed"}</script></head><body><h1>Pokémon FireRed</h1></body></html>',
  }]])
  const { fetchImpl } = fakeFetch({ overrides })
  await assert.rejects(runCrawlSmoke(origin, fetchImpl), /索引入口中的 URL 被 noindex/)
})

test('crawl smoke rejects localized game pages whose schema name differs from the visible H1', async () => {
  const overrides = new Map([['/ja/games/pokemon-firered', {
    contentType: 'text/html; charset=utf-8',
    body: '<!doctype html><html lang="ja"><head><title>ポケットモンスター ファイアレッド（GBA）｜8BitGo</title><meta property="og:title" content="ポケットモンスター ファイアレッド（GBA）｜8BitGo"><meta name="twitter:title" content="ポケットモンスター ファイアレッド（GBA）｜8BitGo"><link rel="canonical" href="https://example.test/ja/games/pokemon-firered"><link rel="alternate" hreflang="ja" href="https://example.test/ja/games/pokemon-firered"><link rel="alternate" hreflang="x-default" href="https://example.test/en/games/pokemon-firered"><script type="application/ld+json">{"@type":["VideoGame","WebApplication"],"name":"Pokémon FireRed"}</script></head><body><h1>ポケットモンスター ファイアレッド</h1></body></html>',
  }]])
  await assert.rejects(runCrawlSmoke(origin, fakeFetch({ overrides }).fetchImpl), /VideoGame.name 与页面 H1 不一致/)
})

test('crawl smoke rejects an all-English game title when SSR data has a verified Japanese title', async () => {
  const overrides = new Map([['/ja/games/pokemon-firered', {
    contentType: 'text/html; charset=utf-8',
    body: '<!doctype html><html lang="ja"><head><title>Pokémon FireRed (GBA) online - 8BitGo</title><meta property="og:title" content="Pokémon FireRed (GBA) online - 8BitGo"><meta name="twitter:title" content="Pokémon FireRed (GBA) online - 8BitGo"><link rel="canonical" href="https://example.test/ja/games/pokemon-firered"><link rel="alternate" hreflang="ja" href="https://example.test/ja/games/pokemon-firered"><link rel="alternate" hreflang="x-default" href="https://example.test/en/games/pokemon-firered"><script type="application/ld+json">{"@type":"VideoGame","name":"Pokémon FireRed"}</script></head><body><h1>Pokémon FireRed</h1></body></html>',
  }]])
  await assert.rejects(
    runCrawlSmoke(origin, fakeFetch({ overrides }).fetchImpl),
    /H1 没有使用已保存的 ja 游戏标题/,
  )
})

test('crawl smoke rejects a game title that falls back to another language while H1 and schema are localized', async () => {
  const overrides = new Map([['/ja/games/pokemon-firered', {
    contentType: 'text/html; charset=utf-8',
    body: '<!doctype html><html lang="ja"><head><title>Pokémon FireRed (GBA) online spielen - 8BitGo</title><meta property="og:title" content="ポケットモンスター ファイアレッド（GBA）｜8BitGo"><meta name="twitter:title" content="ポケットモンスター ファイアレッド（GBA）｜8BitGo"><link rel="canonical" href="https://example.test/ja/games/pokemon-firered"><link rel="alternate" hreflang="ja" href="https://example.test/ja/games/pokemon-firered"><link rel="alternate" hreflang="x-default" href="https://example.test/en/games/pokemon-firered"><script type="application/ld+json">{"@type":"VideoGame","name":"ポケットモンスター ファイアレッド"}</script></head><body><h1>ポケットモンスター ファイアレッド</h1></body></html>',
  }]])
  await assert.rejects(runCrawlSmoke(origin, fakeFetch({ overrides }).fetchImpl), /浏览器标题没有包含页面游戏名/)
})

test('crawl smoke rejects a game page whose hreflang self link points to a different URL', async () => {
  const overrides = new Map([['/ja/games/pokemon-firered', {
    contentType: 'text/html; charset=utf-8',
    body: '<!doctype html><html lang="ja"><head><title>ポケットモンスター ファイアレッド（GBA）｜8BitGo</title><meta property="og:title" content="ポケットモンスター ファイアレッド（GBA）｜8BitGo"><meta name="twitter:title" content="ポケットモンスター ファイアレッド（GBA）｜8BitGo"><link rel="canonical" href="https://example.test/ja/games/pokemon-firered"><link rel="alternate" hreflang="ja" href="https://example.test/ja/games/another-game"><link rel="alternate" hreflang="x-default" href="https://example.test/en/games/pokemon-firered"><script type="application/ld+json">{"@type":"VideoGame","name":"ポケットモンスター ファイアレッド"}</script></head><body><h1>ポケットモンスター ファイアレッド</h1></body></html>',
  }]])
  await assert.rejects(runCrawlSmoke(origin, fakeFetch({ overrides }).fetchImpl), /缺少指向自身的 ja hreflang/)
})

test('crawl smoke rejects homepage collection cards that point to noindex pages', async () => {
  const overrides = new Map([
    ['/sitemaps/collections.xml', {
      contentType: 'application/xml',
      body: '<?xml version="1.0"?><urlset></urlset>',
    }],
    ['/ja/collections/1', {
      contentType: 'text/html; charset=utf-8',
      body: '<!doctype html><html lang="ja"><head><title>薄いリスト</title><link rel="canonical" href="https://example.test/collections/1"><meta name="robots" content="noindex,follow"></head><body><h1>薄いリスト</h1></body></html>',
    }],
  ])
  const { fetchImpl } = fakeFetch({ overrides })
  await assert.rejects(runCrawlSmoke(origin, fetchImpl), /索引入口中的 URL 被 noindex/)
})

test('crawl smoke accepts localized collection routes only when canonical points to the default language page', async () => {
  const overrides = new Map([['/ja/collections/1', {
    contentType: 'text/html; charset=utf-8',
    body: '<!doctype html><html lang="ja"><head><title>コレクション</title><link rel="canonical" href="https://example.test/ja/collections/1"></head><body><h1>コレクション</h1></body></html>',
  }]])
  await assert.rejects(
    runCrawlSmoke(origin, fakeFetch({ overrides }).fetchImpl),
    /canonical 与预期规范 URL 不一致/,
  )
})

test('crawl smoke does not fetch off-site URLs listed in a sitemap', async () => {
  const overrides = new Map([['/sitemaps/games-ja.xml', {
    contentType: 'application/xml',
    body: `<?xml version="1.0"?><urlset><url><loc>https://internal.example/ja/games/pokemon-firered</loc></url></urlset>`,
  }]])
  const { fetchImpl, calls } = fakeFetch({ overrides })
  await assert.rejects(runCrawlSmoke(origin, fetchImpl), /含本站以外的页面 URL/)
  assert.equal(calls.some(({ url }) => new URL(url).origin === 'https://internal.example'), false)
})

test('crawl smoke does not follow off-site sitemap locations', async () => {
  const overrides = new Map([['/sitemap.xml', {
    contentType: 'application/xml',
    body: `<?xml version="1.0"?><sitemapindex><sitemap><loc>${origin}/sitemap-static.xml</loc></sitemap><sitemap><loc>${origin}/sitemaps/games-zh-Hans.xml</loc></sitemap><sitemap><loc>https://internal.example/sitemaps/games-ja.xml</loc></sitemap></sitemapindex>`,
  }]])
  const { fetchImpl, calls } = fakeFetch({ overrides })
  await assert.rejects(runCrawlSmoke(origin, fetchImpl), /必须是本站的标准路径/)
  assert.equal(calls.some(({ url }) => new URL(url).origin === 'https://internal.example'), false)
})
