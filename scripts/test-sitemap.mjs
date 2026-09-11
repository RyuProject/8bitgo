/**
 * 动态 sitemap 的语言门控测试。跑：npm run test:sitemap
 *
 * 存在的理由（2026-09-08 的 GSC 报告）：
 * 站点 8 种语言 × 210 款游戏 = 1,680 条 URL 全交给 Google，而译文是按需生成的 ——
 * 没生成的语言，页面正文会回退到英文简介（繁体回退到简体）。实测 /de、/es、/fr、
 * /it、/ja 五份 1942 页面的 meta description **是同一段英文**。Google 抓上几条就
 * 判定「这站不值得抓」，1,952 条里 929 条落进「已发现 - 尚未编入索引」。
 *
 * 所以 sitemap 只承诺「正文确实是这门语言」的 URL。这一块的两类错误都是静默的：
 *   1. 漏掉门控 → 继续提交上千条重复页，抓取预算被自家页面吃掉（现状）
 *   2. 门控过头 → 7 种语言的 sitemap **全空**，XML 合法、HTTP 200、日志安静，
 *      而搜索引擎那边等于整站下线。第 2 类比第 1 类严重得多，下面用最多的断言守它。
 *
 * 纯 node，不连数据库（builder 是纯函数）。
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { buildGameSitemap, buildPostSitemap, buildSitemapIndex, hasLocalizedBody } from '../server/src/routes/sitemaps.js'

let failed = 0
const check = (name, fn) => {
  try {
    fn()
    console.log(`  ✅ ${name}`)
  } catch (e) {
    failed++
    console.error(`  ❌ ${name}\n     ${e.message}`)
  }
}

const SITE = 'https://8bitgo.com'
/** 一款只有简体简介的游戏（站上绝大多数是这样） */
const bare = { slug: 'battle-city', description: '坦克大战…', updated_at: '2026-09-01' }
/** 有英文简介、没有别的译文 —— /en 该留，/de 不该留 */
const withEn = { slug: '1942', description: '《1942》…', description_en: '1942 is a shooter…', updated_at: '2026-09-01' }
/** 德语译文已生成 */
const withDe = { slug: 'doom', description_en: 'Doom is…', description_i18n: { de: 'Doom ist…' }, updated_at: '2026-09-01' }
const locs = (xml) => [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1])

check('基准语言（zh-Hans）无条件保留 —— 连简介都没有的游戏也得有一条 canonical', () => {
  assert.equal(hasLocalizedBody({}, 'zh-Hans', { i18n: 'description_i18n' }), true)
  assert.equal(locs(buildGameSitemap([bare, withEn, withDe], 'zh-Hans', SITE)).length, 3)
})

check('没有译文的语言不进 sitemap（正文会回退成英文/简体 = 重复页）', () => {
  for (const lang of ['de', 'es', 'fr', 'it', 'ja']) {
    assert.equal(hasLocalizedBody(withEn, lang, { i18n: 'description_i18n', en: 'description_en' }), false, lang)
  }
  assert.deepEqual(locs(buildGameSitemap([bare, withEn, withDe], 'de', SITE)), [`${SITE}/de/games/doom`])
})

check('繁体也一样：回退到简体的不算翻译过', () => {
  assert.equal(hasLocalizedBody(withEn, 'zh-Hant', { i18n: 'description_i18n', en: 'description_en' }), false)
  assert.equal(
    hasLocalizedBody({ description_i18n: { 'zh-Hant': '《1942》…' } }, 'zh-Hant', { i18n: 'description_i18n' }),
    true,
  )
})

check('英文认独立的 description_en 列（游戏的英文简介不在 description_i18n 里）', () => {
  assert.equal(hasLocalizedBody(withEn, 'en', { i18n: 'description_i18n', en: 'description_en' }), true)
  assert.equal(hasLocalizedBody(bare, 'en', { i18n: 'description_i18n', en: 'description_en' }), false)
  // i18n 里若真有 en 也认
  assert.equal(hasLocalizedBody({ description_i18n: { en: 'x' } }, 'en', { i18n: 'description_i18n' }), true)
})

check('文章没有独立英文列，所以 en 也必须看 content_i18n', () => {
  const post = { slug: 'p1', content: '中文正文', updated_at: '2026-09-01' }
  assert.deepEqual(locs(buildPostSitemap([post], 'en', SITE)), [])
  assert.deepEqual(locs(buildPostSitemap([{ ...post, content_i18n: { en: 'English body' } }], 'en', SITE)), [
    `${SITE}/en/blog/p1`,
  ])
  // 基准语言照旧
  assert.deepEqual(locs(buildPostSitemap([post], 'zh-Hans', SITE)), [`${SITE}/blog/p1`])
})

check('⚠️ 没有译文列时必须整个关掉门控，否则 7 种语言的 sitemap 全空', () => {
  // sitemapRows 退回旧查询时行里根本没有 description_i18n 这一列
  const plain = [{ slug: 'a', updated_at: '2026-09-01' }, { slug: 'b', updated_at: '2026-09-01' }]
  assert.equal(locs(buildGameSitemap(plain, 'de', SITE, { gate: false })).length, 2, 'gate=false 要展开全部语言')
  assert.equal(locs(buildPostSitemap(plain, 'de', SITE, { gate: false })).length, 2)
  // 门控开着时同样的行是空的 —— 正是上面那条要防的塌陷
  assert.equal(locs(buildGameSitemap(plain, 'de', SITE)).length, 0)
})

check('⚠️ 游戏那句 SQL 必须把门控要读的列查出来（漏一列 = 全空）', () => {
  const src = readFileSync(new URL('../server/src/routes/sitemaps.js', import.meta.url), 'utf8')
  const sql = src.match(/SELECT[^']*FROM games WHERE hidden = 0[^']*/g) || []
  assert.ok(sql.length >= 2, '应当有「带译文列」和「退回」两句')
  const rich = sql.find((q) => q.includes('description_i18n'))
  assert.ok(rich, 'games 的主查询必须 SELECT description_i18n，否则每一行都判成没翻译')
  assert.ok(rich.includes('description_en'), 'en 那一档靠 description_en，也必须查出来')
  const posts = src.match(/SELECT[^']*FROM posts WHERE published = 1[^']*/g) || []
  assert.ok(
    posts.some((q) => q.includes('content_i18n')),
    'posts 的主查询必须 SELECT content_i18n',
  )
})

check('JSON 列是字符串形状也认（驱动版本 / 列被存成 TEXT）', () => {
  const row = { description_i18n: JSON.stringify({ de: 'Doom ist…' }) }
  assert.equal(hasLocalizedBody(row, 'de', { i18n: 'description_i18n' }), true)
  assert.equal(hasLocalizedBody(row, 'fr', { i18n: 'description_i18n' }), false)
})

check('空串 / 全空白的译文当没翻译（被删过的译文不该把 URL 带进来）', () => {
  assert.equal(hasLocalizedBody({ description_i18n: { de: '   ' } }, 'de', { i18n: 'description_i18n' }), false)
  assert.equal(hasLocalizedBody({ description_en: '  ' }, 'en', { i18n: 'description_i18n', en: 'description_en' }), false)
})

check('脏输入不炸', () => {
  for (const bad of [null, undefined, 0, '', 'nope', [], [1], { de: 1 }, '{坏 JSON']) {
    assert.equal(hasLocalizedBody({ description_i18n: bad }, 'de', { i18n: 'description_i18n' }), false)
  }
  assert.equal(hasLocalizedBody(null, 'de', { i18n: 'description_i18n' }), false)
  assert.equal(hasLocalizedBody(undefined, 'zh-Hans', {}), true)
})

check('过滤之后 loc 前缀、lastmod、图片这些老行为不变', () => {
  const xml = buildGameSitemap([withDe], 'de', SITE)
  assert.match(xml, /<loc>https:\/\/8bitgo\.com\/de\/games\/doom<\/loc>/)
  assert.match(xml, /<lastmod>2026-09-01<\/lastmod>/)
  assert.match(xml, /<urlset[^>]*>/)
})

/* ---------------- 索引不列空的语言 sitemap ---------------- */

console.log('\n── 索引：没内容的语言别列进去 ──')
{
  /*
    病例（2026-09-11）：GSC 报 games-es.xml「XML 标记缺失：父标记 urlset，标记 url」——
    那是它对「<urlset> 里一个 <url> 都没有」的说法。es / fr 还没生成译文，语言门控
    正确地把所有游戏都滤掉了，于是产出一份合法但空的 sitemap。
    **空 sitemap 在 GSC 里是一条永久错误**，会一直响，还会盖住别的 sitemap 的真问题。
    所以索引里干脆别列它。
  */
  const locs = (xml) => [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1])

  const all = locs(buildSitemapIndex({ siteUrl: 'https://x.test' }))
  check('不传参数时照旧全列（默认行为不变）', () => {
    assert.ok(all.some((u) => u.endsWith('/sitemaps/games-es.xml')))
    assert.ok(all.some((u) => u.endsWith('/sitemaps/posts-fr.xml')))
  })

  const trimmed = locs(
    buildSitemapIndex({ siteUrl: 'https://x.test', gamesLangs: new Set(['zh-Hans', 'en']) }),
  )
  check('⭐ 没内容的语言的 games sitemap 不进索引', () => {
    assert.ok(!trimmed.some((u) => u.endsWith('/sitemaps/games-es.xml')), 'es 还在索引里')
    assert.ok(!trimmed.some((u) => u.endsWith('/sitemaps/games-fr.xml')), 'fr 还在索引里')
    assert.ok(trimmed.some((u) => u.endsWith('/sitemaps/games-en.xml')), 'en 不该被摘掉')
    assert.ok(trimmed.some((u) => u.endsWith('/sitemaps/games-zh-Hans.xml')), '基准语言不该被摘掉')
  })
  check('摘 games 不影响 posts 和 taxonomy', () => {
    assert.ok(trimmed.some((u) => u.endsWith('/sitemaps/posts-es.xml')))
    assert.ok(trimmed.some((u) => u.endsWith('/sitemaps/taxonomy-es.xml')))
    assert.ok(trimmed.some((u) => u.endsWith('/sitemap-static.xml')))
  })

  check('⭐ 传 null 一律全列 —— 这是拿不准时唯一安全的方向', () => {
    const n = locs(buildSitemapIndex({ siteUrl: 'https://x.test', gamesLangs: null, postsLangs: null }))
    assert.deepEqual(n, all, '传 null 应该和不传完全一样')
  })

  // 源码守卫：算不出来的时候必须回 null，不能回空集合
  const src = readFileSync(new URL('../server/src/routes/sitemaps.js', import.meta.url), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^[ \t]*\/\/.*$/gm, '')
  check('⭐ 译文列不存在（gate=false）时回 null，不是空集合', () => {
    assert.match(src, /if \(!gate\) return null/)
  })
  check('⭐ 查询抛了也回 null（全列），不能让索引塌成空的', () => {
    assert.match(src, /gamesLangs: null, postsLangs: null/)
  })
}

console.log(failed ? `\n${failed} 项失败` : '\n全部通过')
process.exit(failed ? 1 : 0)
