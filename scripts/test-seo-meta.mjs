#!/usr/bin/env node
/**
 * meta description 与 robots 的回归测试。跑：npm run test:seo-meta
 *
 * 病史（2026-09-11，Bing Webmaster Tools 报的三条「中度严重」里的两条）：
 *
 *   1. Meta descriptions on many of your pages are too short.
 *      线上实测 `/collections` 的描述只有 **11 个字**（「玩家自己整理的游戏清单」）——
 *      那句本来是页面上的小标题，被顺手拿来当 SEO 描述了。更糟的是合集**详情页**
 *      在「这个合集没写简介」时也回退到同一句，而大多数合集都没写简介 ——
 *      于是几乎每个合集页都挂着同一句过短的描述。
 *      顺带查出简体/繁体的 seo 文案整体比其他六种语言短一半（31~49 字），
 *      那几句是早期写的，后来其他语言重写过而中文没跟上。
 *
 *   2. Important pages using meta robots tag that need review.
 *      站内有几页是 noindex 而且挂在**全站导航**上（/rooms、/apps、/submit、/open）。
 *      noindex 是对的（实时房间列表 / 占位页 / 表单 / 控制台都不该收录），
 *      但当时一并给了 `nofollow` —— 那会把这些页面上的内链权重整个掐断，
 *      而 /rooms 整页都是通往游戏详情页的链接。
 *
 * ⚠️ 这两类问题都**不会报错**：页面照常渲染、测试照常绿，只有搜索引擎知道。
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const read = (rel) => readFileSync(path.join(ROOT, rel), 'utf8')
const code = (rel) => read(rel).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')

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

const LANGS = ['zh-Hans', 'zh-Hant', 'en', 'ja', 'es', 'fr', 'de', 'it']

/**
 * `seo` 块里真正会被当成 meta description 用的那些 key。
 * 其余的（platformH1 / genreH1 / platformArticle / platformIntro）不是描述，不查。
 */
const DESC_KEYS = [
  'home', 'games', 'platforms', 'genres', 'developers', 'blog', 'playLocal',
  'collections', 'gameDesc', 'platformDesc', 'genreDesc', 'collectionDesc',
]

/**
 * 描述的最短长度。
 *
 * 50 是 Bing 判「too short」的那条线。按**码点**数，不是字节 ——
 * 中文一个字就是一个码点，50 个中文字已经是相当完整的一句；
 * 英文 50 个字符偏短，所以其他语言实际都在 100 以上，这条线只是兜底。
 */
const MIN_DESC = 50

function seoBlock(lang) {
  const src = read(`src/locales/${lang}.ts`)
  const i = src.indexOf('\n  seo: {')
  assert.ok(i > 0, `${lang} 找不到 seo 块`)
  const j = src.indexOf('\n  },', i)
  return src.slice(i, j)
}

function valueOf(block, key) {
  const single = block.match(new RegExp(`^\\s*${key}: '((?:[^'\\\\]|\\\\.)*)',$`, 'm'))
  if (single) return single[1]
  const dbl = block.match(new RegExp(`^\\s*${key}: "((?:[^"\\\\]|\\\\.)*)",$`, 'm'))
  return dbl ? dbl[1] : null
}

console.log('一、每种语言的每条描述都不能太短')

for (const lang of LANGS) {
  check(`${lang}：${DESC_KEYS.length} 条描述都 ≥ ${MIN_DESC} 码点`, () => {
    const block = seoBlock(lang)
    const short = []
    for (const key of DESC_KEYS) {
      const v = valueOf(block, key)
      assert.ok(v !== null, `${lang} 缺 seo.${key}`)
      const n = [...v].length
      if (n < MIN_DESC) short.push(`${key}=${n}`)
    }
    assert.equal(short.length, 0, `太短：${short.join(', ')}`)
  })
}

console.log('二、界面文案不能拿来当描述')

check('⚠️ 合集两个页面都不再用 collections.subtitle 当描述', () => {
  /*
    `t.collections.subtitle` 是页面上那行小标题（简体中文 11 个字）。
    它和 SEO 描述是两件事：小标题要短才好看，描述要够长才有用。
  */
  for (const rel of ['src/pages/CollectionsPage.tsx', 'src/pages/CollectionDetailPage.tsx']) {
    const src = code(rel)
    const i = src.indexOf('description:')
    assert.ok(i > 0, `${rel} 找不到 description`)
    const seg = src.slice(i, i + 200)
    assert.ok(!seg.includes('collections.subtitle'), `${rel} 还在拿小标题当描述`)
  }
})

check('合集详情页在没有简介时按标题和数量拼一句', () => {
  const src = code('src/pages/CollectionDetailPage.tsx')
  assert.match(src, /fmt\(t\.seo\.collectionDesc, \{ title: c\.title, n: c\.gameCount \}\)/, '回退的那句不是拼出来的')
})

console.log('三、noindex 的页面要 follow，不能 nofollow')

check('⚠️ noindex 配的是 follow', () => {
  /*
    nofollow 会把这一页上的链接整个掐断。/rooms 整页都是通往游戏详情页的链接，
    搜索结果页（/games?q=）同理 —— 那些链接正是我们希望爬虫顺着走的。
  */
  const src = code('src/services/seo.ts')
  assert.match(src, /noindex \? 'noindex,follow'/, "noindex 的 robots 不是 'noindex,follow'")
  assert.ok(!src.includes('noindex,nofollow'), '还有 noindex,nofollow 残留')
})

check('可收录的页面照旧 index,follow + 大图预览', () => {
  const src = code('src/services/seo.ts')
  assert.match(src, /'index,follow,max-image-preview:large'/, '正常页面的 robots 被动了')
})

check('⚠️ noindex 的页面不写 canonical', () => {
  // 给一个不该被收录的页面写 canonical 等于自相矛盾，搜索引擎两条信号打架
  const src = code('src/services/seo.ts')
  assert.match(src, /if \(!noindex\) collected\.tags\.push\(`<link rel="canonical"/, 'noindex 页面又开始写 canonical 了')
})

console.log(failed ? `\n${failed} 项未通过` : '\n全部通过 ✅')
process.exit(failed ? 1 : 0)
