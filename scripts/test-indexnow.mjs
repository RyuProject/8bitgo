import assert from 'node:assert/strict'
import { SITE_LANGUAGES } from '../shared/site-languages.js'
import {
  DEFAULT_INDEXNOW_KEY,
  buildIndexNowPayload,
  gameChangeUrls,
  gameDetailUrls,
  normalizeIndexNowUrls,
  postChangeUrls,
  postDetailUrls,
  submitIndexNowUrls,
} from '../server/src/indexnow.js'
import {
  buildGameSitemap,
  buildPostSitemap,
  buildSitemapIndex,
  buildTaxonomySitemap,
  pickTaxonomyRows,
} from '../server/src/routes/sitemaps.js'
import { ENABLED_PLATFORM_IDS, GENRE_IDS } from '../shared/site-taxonomy.js'
import { assetPublicUrl } from '../server/src/site-urls.js'

let passed = 0
async function check(name, fn) {
  await fn()
  passed++
  console.log(`  ✓ ${name}`)
}

await check('每款游戏生成全部语言 URL，默认语言使用裸路径', async () => {
  const urls = gameDetailUrls('theme hospital', 'https://8bitgo.com')
  assert.equal(urls.length, SITE_LANGUAGES.length)
  assert.equal(urls[0], 'https://8bitgo.com/games/theme%20hospital')
  assert.ok(urls.includes('https://8bitgo.com/en/games/theme%20hospital'))
})

await check('游戏变更同时覆盖详情、游戏列表、平台与类型页', async () => {
  const urls = gameChangeUrls(
    { slug: 'doom', platform: 'dos', genres: ['action', 'shooting'] },
    'https://8bitgo.com',
  )
  assert.equal(urls.length, 5 * SITE_LANGUAGES.length)
  assert.ok(urls.includes('https://8bitgo.com/games/doom'))
  assert.ok(urls.includes('https://8bitgo.com/ja/platforms/dos'))
  assert.ok(urls.includes('https://8bitgo.com/de/genres/shooting'))
})

await check('只保留本站 URL，并去重和去掉 hash', async () => {
  const urls = normalizeIndexNowUrls([
    'https://8bitgo.com/games/doom#player',
    'https://8bitgo.com/games/doom',
    'https://example.com/games/doom',
    'not-a-url',
  ], 'https://8bitgo.com')
  assert.deepEqual(urls, ['https://8bitgo.com/games/doom'])
})

await check('IndexNow payload 包含根目录 keyLocation', async () => {
  const payload = buildIndexNowPayload(['https://8bitgo.com/games/doom'], {
    siteUrl: 'https://8bitgo.com',
  })
  assert.equal(payload.host, '8bitgo.com')
  assert.equal(payload.key, DEFAULT_INDEXNOW_KEY)
  assert.equal(payload.keyLocation, `https://8bitgo.com/${DEFAULT_INDEXNOW_KEY}.txt`)
})

await check('提交使用批量 JSON，200/202 都视为搜索引擎已接收', async () => {
  let sent
  const result = await submitIndexNowUrls([
    'https://8bitgo.com/games/doom',
    'https://8bitgo.com/games/doom',
  ], {
    enabled: true,
    siteUrl: 'https://8bitgo.com',
    fetchImpl: async (endpoint, options) => {
      sent = { endpoint, options, body: JSON.parse(options.body) }
      return { status: 202, text: async () => '' }
    },
  })
  assert.equal(result.submitted, 1)
  assert.equal(result.batches, 1)
  assert.equal(sent.options.method, 'POST')
  assert.equal(sent.body.urlList[0], 'https://8bitgo.com/games/doom')
})

await check('动态游戏 sitemap 使用数据库更新时间和指定语言路径', async () => {
  const xml = buildGameSitemap(
    [{ slug: 'theme-hospital', updated_at: new Date('2026-08-31T12:00:00Z') }],
    'en',
    'https://8bitgo.com',
  )
  assert.match(xml, /<loc>https:\/\/8bitgo\.com\/en\/games\/theme-hospital<\/loc>/)
  assert.match(xml, /<lastmod>2026-08-31<\/lastmod>/)
})

await check('文章生成全部语言 URL，默认语言使用裸路径', async () => {
  const urls = postDetailUrls('why emulation matters', 'https://8bitgo.com')
  assert.equal(urls.length, SITE_LANGUAGES.length)
  assert.equal(urls[0], 'https://8bitgo.com/blog/why%20emulation%20matters')
  assert.ok(urls.includes('https://8bitgo.com/ja/blog/why%20emulation%20matters'))
})

await check('文章变更同时覆盖详情页与博客列表', async () => {
  const urls = postChangeUrls({ slug: 'nes-history' }, 'https://8bitgo.com')
  assert.equal(urls.length, 2 * SITE_LANGUAGES.length)
  assert.ok(urls.includes('https://8bitgo.com/blog/nes-history'))
  assert.ok(urls.includes('https://8bitgo.com/en/blog'))
})

await check('动态文章 sitemap 使用数据库更新时间和指定语言路径', async () => {
  const xml = buildPostSitemap(
    [{ slug: 'nes-history', updated_at: new Date('2026-09-02T08:00:00Z') }],
    'de',
    'https://8bitgo.com',
  )
  assert.match(xml, /<loc>https:\/\/8bitgo\.com\/de\/blog\/nes-history<\/loc>/)
  assert.match(xml, /<lastmod>2026-09-02<\/lastmod>/)
})

await check('三个时间列都为空时不写 lastmod，而不是退回 1970-01-01', async () => {
  const xml = buildPostSitemap([{ slug: 'draft-less', updated_at: null, created_at: null, date: null }], 'en')
  assert.ok(!xml.includes('<lastmod>'), '不该出现 lastmod')
  assert.ok(!xml.includes('1970'))
})

await check('sitemap 索引列出全部三类，各自的 lastmod 互不影响', async () => {
  const xml = buildSitemapIndex({
    siteUrl: 'https://8bitgo.com',
    staticLastmod: '2026-08-20',
    gamesLastmod: '2026-09-01',
    postsLastmod: '2026-09-02',
    taxonomyLastmod: '2026-09-01',
  })
  for (const { code } of SITE_LANGUAGES) {
    assert.ok(xml.includes(`https://8bitgo.com/sitemaps/games-${code}.xml`), `缺游戏 ${code}`)
    assert.ok(xml.includes(`https://8bitgo.com/sitemaps/posts-${code}.xml`), `缺文章 ${code}`)
    assert.ok(xml.includes(`https://8bitgo.com/sitemaps/taxonomy-${code}.xml`), `缺平台类型 ${code}`)
  }
  // 索引里一共 1 + 8×3 条
  assert.equal(xml.match(/<sitemap>/g).length, 1 + SITE_LANGUAGES.length * 3)
  assert.match(xml, /posts-en\.xml<\/loc>\n    <lastmod>2026-09-02</)
  assert.match(xml, /games-en\.xml<\/loc>\n    <lastmod>2026-09-01</)
})

await check('某一类没有内容时，只有它的条目不带 lastmod', async () => {
  const xml = buildSitemapIndex({
    siteUrl: 'https://8bitgo.com',
    staticLastmod: '2026-08-20',
    gamesLastmod: '2026-09-01',
    postsLastmod: '',
  })
  const entry = (name) => xml.split('<sitemap>').find((chunk) => chunk.includes(name))
  assert.ok(!entry('posts-en.xml').includes('<lastmod>'), '没文章时不该有 lastmod')
  assert.ok(entry('games-en.xml').includes('<lastmod>2026-09-01</lastmod>'), '游戏的 lastmod 不该被带走')
})

await check('平台页与类型页按名单顺序输出，lastmod 取该页最新的游戏', async () => {
  const xml = buildTaxonomySitemap([
    { kind: 'platforms', id: 'nes', latest: new Date('2026-09-01T00:00:00Z') },
    { kind: 'genres', id: 'action', latest: new Date('2026-08-15T00:00:00Z') },
  ], 'en', 'https://8bitgo.com')
  assert.match(xml, /<loc>https:\/\/8bitgo\.com\/en\/platforms\/nes<\/loc>/)
  assert.match(xml, /<loc>https:\/\/8bitgo\.com\/en\/genres\/action<\/loc>/)
  assert.match(xml, /<lastmod>2026-09-01<\/lastmod>/)
  assert.match(xml, /<lastmod>2026-08-15<\/lastmod>/)
  // 平台/类型页没有封面，不该带图片扩展
  assert.ok(!xml.includes('image:'))
})

await check('空页面、白名单外的平台、已下线的类型都不进 sitemap', async () => {
  const d = new Date('2026-09-01T00:00:00Z')
  const rows = pickTaxonomyRows(
    [
      { id: 'nes', latest: d },
      // snes 不在 ENABLED_PLATFORM_IDS 里（前台不展示），不该出现
      { id: 'snes', latest: d },
    ],
    [
      { id: 'action', latest: d },
      // 库里残留的、已经不在 GENRE_IDS 里的类型：前台是 404
      { id: 'retired-genre', latest: d },
    ],
  )
  const paths = rows.map((r) => `/${r.kind}/${r.id}`)
  assert.deepEqual(paths, ['/platforms/nes', '/genres/action'])
})

await check('平台与类型都按名单顺序排，不跟数据库返回顺序', async () => {
  const d = new Date('2026-09-01T00:00:00Z')
  // 故意用和名单相反的顺序喂进去
  const rows = pickTaxonomyRows(
    [{ id: 'dos', latest: d }, { id: 'nes', latest: d }],
    [{ id: 'rpg', latest: d }, { id: 'action', latest: d }],
  )
  const ids = rows.map((r) => r.id)
  // ENABLED_PLATFORM_IDS 里 nes 在 dos 之前；GENRE_IDS 里 action 在 rpg 之前
  assert.ok(ids.indexOf('nes') < ids.indexOf('dos'))
  assert.ok(ids.indexOf('action') < ids.indexOf('rpg'))
  // 平台整体排在类型之前
  assert.ok(ids.indexOf('dos') < ids.indexOf('action'))
})

await check('一款游戏都没有时返回空数组，而不是一堆空页面', async () => {
  assert.deepEqual(pickTaxonomyRows([], []), [])
  assert.deepEqual(pickTaxonomyRows(), [])
})

await check('默认语言的平台页用裸路径，不带 /zh-Hans 前缀', async () => {
  const xml = buildTaxonomySitemap([{ kind: 'platforms', id: 'gbc', latest: new Date() }], 'zh-Hans', 'https://8bitgo.com')
  assert.match(xml, /<loc>https:\/\/8bitgo\.com\/platforms\/gbc<\/loc>/)
  assert.ok(!xml.includes('/zh-Hans/'))
})

await check('shared 的类型 id 名单与前台 src/data/genres.ts 一致', async () => {
  // 名单分家的症状是「sitemap 里有一个前台 404 的类型页」，只有逐条点开才看得出来。
  // 这里直接对 genres.ts 做文本提取，避免依赖只有 macOS 侧才装了二进制的 esbuild。
  const { readFileSync } = await import('node:fs')
  const src = readFileSync(new URL('../src/data/genres.ts', import.meta.url), 'utf8')
  const fromUi = [...src.matchAll(/^\s*\{\s*id:\s*'([a-z0-9-]+)'/gm)].map((m) => m[1])
  assert.deepEqual(fromUi, [...GENRE_IDS])
})

await check('shared 的平台白名单与前台 src/config/platforms.ts 是同一份', async () => {
  const { readFileSync } = await import('node:fs')
  const src = readFileSync(new URL('../src/config/platforms.ts', import.meta.url), 'utf8')
  // 前台必须是 re-export，不能自己再写一遍数组字面量
  assert.ok(src.includes("from '../../shared/site-taxonomy.js'"), 'platforms.ts 应从 shared 导入')
  assert.ok(!/ENABLED_PLATFORMS\s*:\s*PlatformId\[\]\s*=\s*\[['"]/.test(src), 'platforms.ts 不该重新写死数组')
  assert.ok(ENABLED_PLATFORM_IDS.includes('nes') && ENABLED_PLATFORM_IDS.includes('dos'))
})

await check('封面 key 换算成对象存储上的绝对地址，逐段编码', async () => {
  assert.equal(
    assetPublicUrl('covers/contra 2.jpg', 'https://8bitgo.com', 'https://assets.8bitgo.com'),
    'https://assets.8bitgo.com/covers/contra%202.jpg',
  )
  // 站内路径拼站点域名，完整 URL 原样返回
  assert.equal(assetPublicUrl('/og-default.png', 'https://8bitgo.com'), 'https://8bitgo.com/og-default.png')
  assert.equal(assetPublicUrl('https://cdn.example.com/a.png', 'https://8bitgo.com'), 'https://cdn.example.com/a.png')
  // 拼不出来时给空串，不能输出一个必然 404 的地址
  assert.equal(assetPublicUrl('covers/a.jpg', 'https://8bitgo.com', ''), '')
  assert.equal(assetPublicUrl(null, 'https://8bitgo.com'), '')
})

await check('游戏 sitemap 带图片扩展，没封面的条目跳过', async () => {
  const xml = buildGameSitemap([
    { slug: 'contra', cover: 'covers/contra.jpg', updated_at: new Date('2026-09-01T00:00:00Z') },
    { slug: 'bare', cover: null, updated_at: new Date('2026-09-01T00:00:00Z') },
  ], 'en', 'https://8bitgo.com')
  assert.match(xml, /xmlns:image="http:\/\/www\.google\.com\/schemas\/sitemap-image\/1\.1"/)
  assert.match(xml, /<image:loc>https:\/\/assets\.8bitgo\.com\/covers\/contra\.jpg<\/image:loc>/)
  // 两条 URL，但只有一条带图
  assert.equal(xml.match(/<loc>/g).length, 2)
  assert.equal(xml.match(/<image:image>/g).length, 1)
})

await check('一张封面都没有时不声明 image 命名空间', async () => {
  const xml = buildGameSitemap([{ slug: 'bare', cover: null, updated_at: new Date() }], 'ja', 'https://8bitgo.com')
  assert.ok(!xml.includes('xmlns:image'))
  assert.ok(!xml.includes('image:'))
})

await check('不输出 Google 已停止支持的 image 子标签', async () => {
  const xml = buildGameSitemap(
    [{ slug: 'contra', cover: 'covers/contra.jpg', updated_at: new Date() }],
    'zh-Hans',
    'https://8bitgo.com',
  )
  // 这四个在 2022 年那次 sitemap 扩展清理里被废弃，写了也没人读，只会让文件变大
  for (const tag of ['image:title', 'image:caption', 'image:license', 'image:geo_location']) {
    assert.ok(!xml.includes(tag), `${tag} 已废弃，不该出现`)
  }
})

await check('文章 sitemap 不带图片扩展（文章配图是 emoji 图标）', async () => {
  const xml = buildPostSitemap([{ slug: 'nes-history', updated_at: new Date() }], 'en', 'https://8bitgo.com')
  assert.ok(!xml.includes('image:'))
})

console.log(`✅ IndexNow / sitemap：${passed} 项检查通过`)
