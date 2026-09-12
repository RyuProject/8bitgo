/**
 * 首页「站长精选」和「最多人玩」两栏的回归测试。跑：npm run test:home-sections
 *
 * ## 这两栏的分工（2026-09-12 定下来的）
 *
 * 在此之前它们是**同一栏在变身**：后台一旦有游戏填了「首页排序」，第一栏就整个
 * 变成「站长精选」，「最多人玩的模拟器游戏」这个标题再也不出现。于是每隔一阵就有人
 * 来问「我的最多人玩模块怎么没了」—— 界面没说谎，但它把两件事塞进了一个位置。
 *
 * 现在是并排的两栏，各说各的：
 *   1. PickedSection    「站长精选」  人挑的，后台没钦点过就**整栏不画**，不挂名次角标
 *   2. MostPlayedSection「最多人玩…」 机器排的真榜，**始终在**，带 #1 名次和游玩次数
 *
 * ## 所以要守五件事
 *
 *   1. **真榜始终是真榜** —— 不能哪天被改成「复用 popular」，那样精选一开它就跟着变精选。
 *   2. **不为它多跑一次 SQL** —— 那份查询首页本来就跑了，切一下就有。
 *      首页是全站访问量最大的一页，多一次全库排序的查询是实打实的成本。
 *   3. **显示的数字和排序依据是同一个量** —— 按游玩次数排的榜，卡上就显示游玩次数。
 *   4. **精选那一栏没数据时整个不画** —— 否则没钦点的站会看到两栏一模一样的数据。
 *   5. **首页七栏的顺序**就是用户要的那个顺序，别被谁顺手调了。
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

/** 取某个组件函数体（到下一个 export function 为止） */
const bodyOf = (name) => {
  const i = sections.indexOf(`export function ${name}`)
  assert.ok(i > 0, `找不到 ${name}`)
  const j = sections.indexOf('export function ', i + 10)
  return sections.slice(i, j === -1 ? sections.length : j)
}

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

check('⚠️ 字段名还叫 hottest（改名 = 所有没更新的前端整栏消失）', () => {
  assert.match(content, /\bhottest:/, '后端不再返回 hottest 了')
  assert.match(home, /data\?\.hottest/, '前端不再读 hottest 了')
})

console.log('\n── 首页接线与顺序 ──')

check('两栏都接上了，各取各的数据', () => {
  assert.match(home, /<PickedSection games=\{data\?\.popular \?\? \[\]\} curated=\{data\?\.popularCurated \?\? false\} \/>/)
  assert.match(home, /<MostPlayedSection games=\{data\?\.hottest \?\? \[\]\} \/>/)
})

check('⚠️ 首页七栏就是这个顺序：精选 → 平台 → 最新 → 一起玩 → 最多人玩 → 合集 → 分类', () => {
  const ORDER = [
    'PickedSection',
    'PlatformsSection',
    'LatestSection',
    'TogetherSection',
    'MostPlayedSection',
    'CollectionsSection',
    'GenreGridSection',
  ]
  const at = ORDER.map((n) => ({ n, i: home.indexOf(`<${n} `) }))
  const missing = at.filter((x) => x.i < 0).map((x) => x.n)
  assert.deepEqual(missing, [], `首页上找不到：${missing.join(', ')}`)
  const sorted = [...at].sort((a, b) => a.i - b.i).map((x) => x.n)
  assert.deepEqual(sorted, ORDER, `顺序被调过了，现在是：${sorted.join(' → ')}`)
})

console.log('\n── 站长精选：人挑的，可以没有 ──')

check('⚠️ 没钦点（或没数据）时整栏不画，否则和下面那栏一模一样', () => {
  assert.match(bodyOf('PickedSection'), /if \(!curated \|\| !games\.length\) return null/)
})

check('⚠️ 不挂 #1 #2 排名角标（人排的顺序不是热度榜）', () => {
  assert.doesNotMatch(bodyOf('PickedSection'), /rank=/, '精选那一栏给卡片传了名次')
})

check('用的是精选文案，不是榜的文案', () => {
  const body = bodyOf('PickedSection')
  assert.match(body, /t\.sections\.pickedTitle/)
  assert.doesNotMatch(body, /t\.sections\.popularTitle/, '精选栏顶着真榜的标题')
})

console.log('\n── 最多人玩：始终是真榜 ──')

check('用的是真榜文案', () => {
  const body = bodyOf('MostPlayedSection')
  assert.match(body, /t\.sections\.popularTitle/)
  assert.match(body, /t\.sections\.popularSubtitle/)
})

check('⚠️ 没数据时整块不画（老服务端没有这个字段）', () => {
  assert.match(bodyOf('MostPlayedSection').slice(0, 400), /if \(!games\.length\) return null/)
})

check('⚠️ 卡上显示的量就是排序依据（游玩次数），不是评分', () => {
  const body = bodyOf('MostPlayedSection')
  assert.match(body, /metric=\{g\.plays > 0 \?/, '这一栏按游玩次数排，卡上却没显示游玩次数')
  assert.doesNotMatch(body, /g\.rating\b/, '按游玩次数排的榜却在卡上标评分')
})

check('⚠️ 0 次时不画那个数字（「🔥 0」会被读成「没人玩」）', () => {
  assert.match(bodyOf('MostPlayedSection'), /g\.plays > 0 \? <>🔥 \{formatCount\(g\.plays\)\}<\/> : undefined/)
})

check('带名次角标（这一栏是榜，名次要看得见）', () => {
  assert.match(bodyOf('MostPlayedSection'), /rank=\{i \+ 1\}/)
})

console.log('\n── 排版 ──')

check('⚠️ 宽屏两列而且是竖着排的（左 1–5、右 6–10），窄屏单列', () => {
  const grid = bodyOf('MostPlayedSection').match(/className="grid[^"]*"/)?.[0] ?? ''
  assert.match(grid, /grid-cols-1/, '窄屏不是单列')
  assert.match(grid, /md:grid-flow-col/, '宽屏按行填充了 —— 会变成「1 2 / 3 4」，眼睛得横着跳才读得出名次')
  assert.match(grid, /md:grid-rows-5/, '没固定五行，列数会跟着条数跑')
  assert.match(grid, /md:auto-cols-fr/, 'flow-col 下列宽默认是 max-content，不给 fr 会被最长的标题撑歪')
})

check('一行四件套都在：名次 / 封面 / 标题 / 平台角标', () => {
  assert.match(card, /\{rank\}/, '没画名次')
  assert.match(card, /<GameCover game=\{game\} ratio="square"/, '封面不是方形小图')
  assert.match(card, /gameTitle\(game, lang\)/, '没画标题')
  assert.match(card, /platform\.shortName/, '没画平台角标')
})

check('⚠️ 名次用 tabular-nums（个位数和两位数要对齐）', () => {
  const i = card.indexOf('{rank}')
  assert.match(card.slice(Math.max(0, i - 300), i), /tabular-nums/)
})

check('⚠️ 金银铜是角标的底色，不是文字色（浅色主题的 surface 是纯白，亮色当文字读不出来）', () => {
  const block = card.match(/const MEDAL_TONES[\s\S]*?\n\}/)?.[0]
  assert.ok(block, '找不到 MEDAL_TONES —— 改了名字的话这条断言也要跟着改')
  const tones = [...block.matchAll(/'([^']+)'/g)].map((m) => m[1])
  assert.ok(tones.length >= 3, `只读到 ${tones.length} 档配色，前三名没配齐`)
  for (const tone of tones) assert.match(tone, /(^|\s)bg-/, `「${tone}」没有底色`)
})

check('⚠️ 不许拿 bg-white/x 当底色（深色主题看着好好的，浅色主题是纯白配纯白）', () => {
  assert.doesNotMatch(card, /bg-white\//, '又用回 bg-white/x 了 —— 2026-09-12 平台角标就是这么隐形的')
})

check('标题走多语言函数，不是直接读字段', () => {
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
  check(`${lang}：两栏的标题和副标题都在且非空`, () => {
    for (const k of ['popularTitle', 'popularSubtitle', 'pickedTitle', 'pickedSubtitle']) {
      const v = valueOf(src, k)
      assert.ok(v !== null, `缺 ${k}`)
      assert.ok(v.trim().length > 0, `${k} 是空的`)
    }
  })
  check(`${lang}：⚠️ 没有回流的 hottest* 死键`, () => {
    assert.ok(!/\bhottest(Title|Subtitle)\b/.test(src), '「最热门的游戏」那套文案已经并进 popularTitle 了，别再加回来')
  })
}

check('组件引用的文案键在基准语言里都存在', () => {
  const zh = read('src/locales/zh-Hans.ts')
  const used = [...new Set([...sections.matchAll(/t\.sections\.([A-Za-z]+)/g)].map((m) => m[1]))]
  assert.ok(used.length >= 8, `只扫到 ${used.length} 个引用，正则可能失效了`)
  const missing = used.filter((k) => valueOf(zh, k) === null)
  assert.deepEqual(missing, [], `zh-Hans 里没有：${missing.join(', ')}`)
})

console.log('\n── 后台说明必须和实际行为一致 ──')

/*
  这一节是被一次真实的困惑逼出来的：后台「首页排序」的说明原本写着
  「标题也会从『最多人玩』变成『最热门的游戏』」—— 而代码里换上的是 pickedTitle。
  后台的文字没人会去核对，错了能挂很久，所以让测试替人核对。

  2026-09-12 之后连「变身」这件事本身都不存在了（精选是独立一栏），
  所以除了对名字，还要盯住说明里不能再出现「标题会从…变成…」这种说法。
*/
const zh = read('src/locales/zh-Hans.ts')
const pickedTitle = valueOf(zh, 'pickedTitle')
const popularTitle = valueOf(zh, 'popularTitle')
const form = read('src/admin/GameForm.tsx')
const types = read('src/types.ts')
/** 注释里这句话会跨行，前缀是 " * "，先抹平再匹配 */
const flatten = (t) => t.replace(/\n\s*\*\s*/g, '').replace(/\n\s*/g, '')

check('基准文案读得出来（下面几条都靠它）', () => {
  assert.ok(pickedTitle && popularTitle, 'pickedTitle / popularTitle 读不出来了')
})

check('⚠️ 后台「首页排序」的说明点名了这两栏各自的真实标题', () => {
  assert.ok(form.includes(pickedTitle), `说明里没提「${pickedTitle}」—— 填了排序的人不知道自己填进了哪一栏`)
  assert.ok(form.includes(popularTitle), `说明里没提「${popularTitle}」—— 开了精选的人会以为按游玩次数排的榜没了`)
})

check('⚠️ 说明里不能再有「标题会从…变成…」（现在是两栏，标题不变身了）', () => {
  assert.doesNotMatch(
    flatten(form),
    /标题[^。]*?从「[^」]+」(?:变成|换成)「[^」]+」/,
    'GameForm 的说明还在讲「标题变身」，那是 2026-09-12 之前的行为',
  )
})

check('⚠️ types.ts 上 homeRank 的注释也是同一套说法', () => {
  const i = types.indexOf('homeRank?: number')
  assert.ok(i > 0, '找不到 homeRank 了')
  const doc = flatten(types.slice(Math.max(0, i - 1200), i))
  assert.ok(doc.includes(pickedTitle), `注释里没提「${pickedTitle}」`)
  assert.ok(doc.includes(popularTitle), `注释里没提「${popularTitle}」`)
})

console.log('')
if (fails.length) {
  for (const f of fails) console.error('✗ ' + f.name + '\n' + (f.e?.stack ?? f.e))
  console.error(`\n❌ ${fails.length} 条失败 / 共 ${pass + fails.length} 条`)
  process.exit(1)
}
console.log(`✅ 首页两栏：${pass} 条全过`)
