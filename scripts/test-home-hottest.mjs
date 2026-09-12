/**
 * 首页「最热门的游戏」那一栏的回归测试。跑：npm run test:home-hottest
 *
 * ## 这一栏为什么存在
 *
 * 首页第一栏（PopularSection）**不一定是榜**：后台一旦在游戏里填了「首页排序」，
 * 它整栏会变成「站长精选」—— 人排的顺序，连 #1 #2 的角标都摘掉（那是有意的，
 * 界面不能把人排的顺序陈述成热度榜）。于是开了精选之后，
 * 「按游玩次数排出来的那份真榜」在首页上就**看不到了**。这一栏补的正是它。
 *
 * ## 所以要守三件事
 *
 *   1. **它始终是真榜** —— 不能哪天被人改成「复用 popular」，那样精选一开它就跟着变成精选。
 *   2. **不为它多跑一次 SQL** —— 那份查询首页本来就跑了，切一下就有。
 *      首页是全站访问量最大的一页，多一次全库排序的查询是实打实的成本。
 *   3. **显示的数字和排序依据是同一个量** —— 按游玩次数排的榜，卡上就显示游玩次数。
 *      挂个评分上去，读者只会觉得这个榜排错了。
 *
 * .tsx 里的 JSX 这套 node 测试加载不了（见 scripts/helpers/ts-loader.mjs），
 * 组件那半只能扫结构 —— 扫的是「接上了没有」，不是「长什么样」。
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)))
const read = (rel) => readFileSync(path.join(root, rel), 'utf8')
/** 去注释再扫：本文件和被扫的源码都在注释里引用了同样的标识符 */
const strip = (t) => t.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')

const content = strip(read('server/src/content.js'))
const sections = strip(read('src/components/home/sections.tsx'))
const card = strip(read('src/components/game/GameRankCard.tsx'))
const home = strip(read('src/pages/HomePage.tsx'))

let pass = 0
const fails = []
/** 全部跑完再汇总，不在第一条就退出（理由见 run-tests.mjs 的文件头） */
const check = (name, fn) => {
  try {
    fn()
    pass++
    console.log('  ✓ ' + name)
  } catch (e) {
    fails.push({ name, e })
    console.log('  ✗ ' + name + ' —— ' + (e?.message ?? e))
  }
}

console.log('\n── 服务端：真榜，而且不多跑查询 ──')

check('首页数据里有 hottest，切自那份按游玩次数排的结果', () => {
  assert.match(content, /hottest: popular\.items\.slice\(0, HOT_SIZE\)/)
})

check('⚠️ hottest 不是从 popular 那个字段来的（精选一开就会跟着变精选）', () => {
  assert.doesNotMatch(content, /hottest: curated \?/, 'hottest 被挂到了精选的三元上')
  assert.doesNotMatch(content, /hottest: picks/, 'hottest 直接取了精选')
})

check('⚠️ 没有为这一栏新增一次全库排序查询', () => {
  const calls = content.match(/listGames\(\{ sort: 'popular', pageSize: HOME_SIZE \}\)/g) ?? []
  assert.equal(calls.length, 1, `按热度排的整库查询跑了 ${calls.length} 次 —— 首页是访问量最大的一页，切一下就够了`)
})

check('⚠️ HOT_SIZE 不能大于 HOME_SIZE（大了 slice 会静默少给）', () => {
  const home_ = Number(content.match(/const HOME_SIZE = (\d+)/)?.[1])
  const hot = Number(content.match(/const HOT_SIZE = (\d+)/)?.[1])
  assert.ok(Number.isFinite(home_) && Number.isFinite(hot), '两个常量至少有一个读不出来了')
  assert.ok(hot <= home_, `HOT_SIZE=${hot} 超过了 HOME_SIZE=${home_}，那一栏会静默少几张卡`)
  // 5 列 × 整行：摆不满一行的尾巴看着像少了几款
  assert.equal(hot % 5, 0, `HOT_SIZE=${hot} 不是 5 的整数倍，最后一行会缺口`)
})

console.log('\n── 前端接线 ──')

check('首页渲染了这一栏，数据取的是 hottest', () => {
  assert.match(home, /<HottestSection games=\{data\?\.hottest \?\? \[\]\} \/>/)
})

check('⚠️ 没数据时整块不画（老服务端没有这个字段）', () => {
  const i = sections.indexOf('export function HottestSection')
  assert.ok(i > 0, '找不到 HottestSection')
  assert.match(sections.slice(i, i + 260), /if \(!games\.length\) return null/)
})

check('⚠️ 卡上显示的量就是排序依据（游玩次数），不是评分', () => {
  const i = sections.indexOf('export function HottestSection')
  const body = sections.slice(i, i + 1400)
  assert.match(body, /metric=\{g\.plays > 0 \?/, '这一栏按游玩次数排，卡上却没显示游玩次数')
  assert.doesNotMatch(body, /g\.rating\b/, '按游玩次数排的榜却在卡上标评分')
})

check('⚠️ 0 次时不画那个数字（「🔥 0」会被读成「没人玩」）', () => {
  const i = sections.indexOf('export function HottestSection')
  assert.match(sections.slice(i, i + 1400), /g\.plays > 0 \? <>🔥 \{formatCount\(g\.plays\)\}<\/> : undefined/)
})

console.log('\n── 排版：像参考图那样 ──')

check('宽屏 5 列，窄屏不掉到 1 列', () => {
  const i = sections.indexOf('export function HottestSection')
  const body = sections.slice(i, i + 1400)
  const grid = body.match(/className="grid[^"]*"/)?.[0] ?? ''
  assert.match(grid, /xl:grid-cols-5/, '宽屏不是 5 列')
  assert.match(grid, /grid-cols-2/, '窄屏没兜住')
  assert.doesNotMatch(grid, /grid-cols-1\b/, '掉到 1 列了：这张卡很窄，一列会横着拉得很长')
})

check('卡片四件套都在：名次 / 平台 / 封面 / 简介', () => {
  assert.match(card, /\{rank\}/, '没画名次')
  assert.match(card, /platform\.shortName/, '没画平台角标')
  assert.match(card, /<GameCover game=\{game\} ratio="square"/, '封面不是方形小图')
  assert.match(card, /gameDescription\(game, lang\)/, '没画简介')
})

check('⚠️ 名次用 tabular-nums（个位数和两位数要对齐）', () => {
  const i = card.indexOf('{rank}')
  assert.match(card.slice(Math.max(0, i - 300), i), /tabular-nums/)
})

check('⚠️ 简介占住固定高度，否则同一行的卡高矮不齐', () => {
  assert.match(card, /line-clamp-2 min-h-8/)
})

check('标题和简介走多语言函数，不是直接读字段', () => {
  assert.match(card, /gameTitle\(game, lang\)/)
  assert.doesNotMatch(card, /\{game\.title\}/, '直接渲染了 game.title —— 中文界面会显示原名')
})

console.log('\n── 八种语言的文案 ──')

const LANGS = ['zh-Hans', 'zh-Hant', 'en', 'ja', 'de', 'fr', 'es', 'it']
const valueOf = (src, key) => {
  const m = src.match(new RegExp(`\\n\\s*${key}: (['"])((?:\\\\.|(?!\\1).)*)\\1,`))
  return m ? m[2] : null
}
for (const lang of LANGS) {
  const src = read(`src/locales/${lang}.ts`)
  check(`${lang}：标题和副标题都在且非空`, () => {
    for (const k of ['hottestTitle', 'hottestSubtitle']) {
      const v = valueOf(src, k)
      assert.ok(v !== null, `缺 ${k}`)
      assert.ok(v.trim().length > 0, `${k} 是空的`)
    }
  })
}

check('组件引用的 hottest* 文案键在基准语言里都存在', () => {
  const zh = read('src/locales/zh-Hans.ts')
  const used = [...new Set([...sections.matchAll(/t\.sections\.(hottest[A-Za-z]*)/g)].map((m) => m[1]))]
  assert.ok(used.length >= 2, `只扫到 ${used.length} 个引用，正则可能失效了`)
  const missing = used.filter((k) => valueOf(zh, k) === null)
  assert.deepEqual(missing, [], `zh-Hans 里没有：${missing.join(', ')}`)
})

console.log('')
if (fails.length) {
  for (const f of fails) console.error('✗ ' + f.name + '\n' + (f.e?.stack ?? f.e))
  console.error(`\n❌ ${fails.length} 条失败 / 共 ${pass + fails.length} 条`)
  process.exit(1)
}
console.log(`✅ 首页最热门：${pass} 条全过`)
