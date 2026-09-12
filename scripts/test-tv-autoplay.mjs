/**
 * TV 端「回车即播」这条链的回归测试。跑：npm run test:tv-autoplay
 *
 * ## 这条链长什么样
 *
 *   TV 列表上回车 → FocusScope 派发 el.click()
 *     → <Link> 的 onClick 里 enterFullscreen()（整页进全屏）
 *     → 前端路由跳 /games/<slug>?autoplay=1
 *       → 详情页把 autoStart 传给播放器 → 播放器自己开一局
 *
 * ## 两条硬约束（错了都不报错，只是「什么都没发生」）
 *
 *   1. **全屏必须在用户手势的同步调用栈里要**。挪进 useEffect / setTimeout / await 之后，
 *      浏览器直接拒绝，控制台只有一句 Permissions check failed。
 *   2. **跳转必须是同文档的前端路由**（`<Link>`）。整页重载会把全屏状态丢掉，
 *      而详情页那边没有手势可用，补不回来 —— 换成 `<a>` 就等于全屏白进了。
 *
 * 再加一条播放器侧的：**自动开局只能开一次**。不然玩家自己停掉这一局就会被立刻拉回去。
 *
 * .tsx 里的 JSX 这套 node 测试加载不了（见 scripts/helpers/ts-loader.mjs），
 * 接线那半只能扫结构；lib/fullscreen.ts 没有 JSX，是真的跑起来测的。
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)))
const read = (rel) => readFileSync(path.join(root, rel), 'utf8')
const strip = (t) => t.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')

let pass = 0
const fails = []
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

const { enterFullscreen } = await import('../src/lib/fullscreen.ts')

/** 造一个假 document，记录 requestFullscreen 被怎么调的 */
function fakeDoc({ fullscreenElement = null, fullscreenEnabled = true, impl } = {}) {
  const calls = []
  const el = {
    requestFullscreen:
      impl === null
        ? undefined
        : (opts) => {
            calls.push(opts)
            return impl ? impl() : Promise.resolve()
          },
  }
  return { doc: { fullscreenElement, fullscreenEnabled, documentElement: el }, calls, el }
}

const withDoc = (doc, fn) => {
  const prev = globalThis.document
  globalThis.document = doc
  try {
    return fn()
  } finally {
    if (prev === undefined) delete globalThis.document
    else globalThis.document = prev
  }
}

console.log('\n── enterFullscreen ──')

check('正常情况下会要全屏，并且带上 navigationUI: hide', () => {
  const { doc, calls } = fakeDoc()
  withDoc(doc, () => enterFullscreen())
  assert.equal(calls.length, 1, '没有请求全屏')
  assert.equal(calls[0]?.navigationUI, 'hide')
})

check('⚠️ 已经在全屏里就不再请求（玩家自己按过 F11 / 播放器的全屏键）', () => {
  const { doc, calls } = fakeDoc({ fullscreenElement: {} })
  withDoc(doc, () => enterFullscreen())
  assert.equal(calls.length, 0)
})

check('⚠️ fullscreenEnabled 为 false 时不请求（iPhone Safari、企业策略）', () => {
  const { doc, calls } = fakeDoc({ fullscreenEnabled: false })
  withDoc(doc, () => enterFullscreen())
  assert.equal(calls.length, 0)
})

check('浏览器没有 requestFullscreen 也不能抛', () => {
  const { doc } = fakeDoc({ impl: null })
  withDoc(doc, () => enterFullscreen())
})

check('⚠️ 被拒绝（reject）要吞掉 —— 全屏进不去不该挡住开始玩', async () => {
  const { doc } = fakeDoc({ impl: () => Promise.reject(new Error('Permissions check failed')) })
  withDoc(doc, () => enterFullscreen())
})

check('⚠️ 同步抛也要吞掉', () => {
  const { doc } = fakeDoc({
    impl: () => {
      throw new Error('boom')
    },
  })
  withDoc(doc, () => enterFullscreen())
})

console.log('\n── TV 侧接线：回车 = 播放器占满窗口 ──')

const tv = strip(read('src/pages/TvPage.tsx'))
const tvPlay = strip(read('src/components/tv/TvPlay.tsx'))

/*
  ⚠️ 2026-09-12 改了路子，**别把下面这些改回去**。

  上一版是「跳详情页 ?autoplay=1 + enterFullscreen() 把整页切全屏」。两个毛病：
    · 落点是详情页 —— 整页全屏之后播放器还是待在自己那个比例框里，
      下面照样跟着评论、键位表、相关推荐，并没有「占满」；
    · 车机和不少电视浏览器没有 Fullscreen API（fullscreenEnabled === false），
      失败被吞掉之后那些设备上就只是个普通详情页。

  现在是「本页 ?play=<slug> → TvPlay 用 fill + h-dvh 吃满视口」，不需要任何全屏权限。
*/

check('⭐ 列表项指向本页的 ?play=，不是详情页', () => {
  assert.match(tv, /to=\{`\?play=\$\{encodeURIComponent\(game\.slug\)\}`\}/, '列表项没指向 ?play=')
  assert.doesNotMatch(tv, /autoplay=1/, 'TV 又回到「跳详情页带 ?autoplay=1」那条路了')
  assert.doesNotMatch(tv, /to=\{`\/games\//, 'TV 的列表项又跳详情页了')
})

check('⭐ 满窗口不能**依赖**全屏（车机 / 电视浏览器多半没有 Fullscreen API）', () => {
  /*
    全屏是锦上添花不是地基：窗口占满靠 TvPlay 的 fill + h-dvh，那个不需要任何权限；
    全屏只多去掉浏览器自己的地址栏，要不到就算了（enterFullscreen 内部全吞）。
    所以这里断言的是「TvPlay 那一屏和全屏无关」，不是「全站不许调全屏」。
  */
  assert.doesNotMatch(tvPlay, /enterFullscreen|requestFullscreen/, 'TvPlay 的满窗口布局挂到全屏上去了')
})

check('⚠️ 全屏挂在 onClick 上（回车是 el.click() 派发的，这样才在手势里）', () => {
  assert.match(tv, /onClick=\{\(\) => enterFullscreen\(\)\}/, 'onClick 上没有 enterFullscreen')
})

check('⚠️ 全屏不许在 effect / 定时器里要（那里没有用户手势，浏览器静默拒绝）', () => {
  const calls = [...tv.matchAll(/enterFullscreen\(/g)].length
  const inHandler = [...tv.matchAll(/onClick=\{\(\) => enterFullscreen\(\)\}/g)].length
  /*
    ⚠️ 不要为 import 那一行做 -1 的修正（我加过，是错的）：正则要求 enterFullscreen 后面
    紧跟一个 `(`，而 import 那行后面是 ` }`，本来就不匹配。注释也已经被 strip 掉了。
    所以两边应当**严格相等** —— 每一次调用都必须落在某个 onClick 里。
  */
  assert.ok(inHandler > 0, '一处手势里的调用都没有')
  assert.equal(calls, inHandler, '除了 onClick，还有别处在调 enterFullscreen')
  assert.doesNotMatch(tv, /useEffect\([\s\S]{0,400}?enterFullscreen\(/, 'effect 里调了全屏')
  assert.doesNotMatch(tv, /setTimeout\([\s\S]{0,200}?enterFullscreen\(/, '定时器里调了全屏')
})

check('⚠️ 退出时把全屏一起退掉（否则列表停在全屏里，人以为卡住了）', () => {
  assert.match(tvPlay, /document\.exitFullscreen\(\)/, '退出没退全屏')
})

check('⭐ ?play= 时渲染 TvPlay，并且是提前返回（浏览列表整块不画）', () => {
  assert.match(tv, /if \(playSlug\) return <TvPlay slug=\{playSlug\} onExit=\{exitPlay\}/, '没切到 TvPlay')
})

check('⭐ TvPlay 真的占满整个窗口：h-dvh 容器 + 播放器 fill', () => {
  /*
    fill 是开关、h-full 是高度链，**缺一个都不占满**（见 EmulatorPlayer 里 embedFill 那段）。
    所以这两条一起断言，不能只查其中一个。
  */
  assert.match(tvPlay, /className="[^"]*\bh-dvh\b/, 'TvPlay 的外层不是 h-dvh')
  const mount = tvPlay.match(/<EmulatorPlayer[\s\S]*?\/>/)?.[0] ?? ''
  assert.match(mount, /^\s*fill\s*$/m, '播放器没开 fill')
  assert.match(mount, /className="h-full"/, '缺 h-full 高度链 —— fill 单独给是不生效的')
})

check('⭐ 回车进来直接开一局（autoStart），不用再按一次「开始游戏」', () => {
  const mount = tvPlay.match(/<EmulatorPlayer[\s\S]*?\/>/)?.[0] ?? ''
  assert.match(mount, /^\s*autoStart\s*$/m, 'TvPlay 没传 autoStart')
})

check('⚠️ 退出用 replace —— 否则从列表按「返回」又掉回播放器里出不去', () => {
  assert.match(tv, /setParams\(next, \{ replace: true \}\)/, 'exitPlay 没用 replace')
})

check('⭐ TvPlay 和 EmbedPage 的播放器 props 不许漂移', () => {
  /*
    这两处挂播放器用的是**同一套** props。本该抽成公共组件，但 EmbedPage 是第三方网站
    嵌着在用的，抽的时候必须能真的跑起来验，不能靠读代码。所以暂时两份，由这条钉住：
    哪天有人给播放器加了 prop 只改了一边，这里会红。
    **抽成一份之后请把这条连同 TvPlay 里那段注释一起删掉。**
  */
  const propsOf = (src) => {
    const block = src.match(/<EmulatorPlayer[\s\S]*?\n\s*\/>/)?.[0] ?? ''
    return new Set([...block.matchAll(/^\s{8,}([a-zA-Z][\w]*)(?:=|\s*$)/gm)].map((m) => m[1]))
  }
  const embed = propsOf(strip(read('src/pages/EmbedPage.tsx')))
  const play = propsOf(tvPlay)
  assert.ok(embed.size > 15, `只从 EmbedPage 解析出 ${embed.size} 个 prop —— 正则失效了`)

  // 有意不同的那几个，每一个都要说得出理由
  const ONLY_EMBED = new Set([
    'maxPlayers', // 嵌入页压成 1（跨站 iframe 里联机指望不上，信令要登录态）
  ])
  const ONLY_PLAY = new Set([
    'maxPlayers', // TV 上照游戏本身的人数来
    'autoStart', // 回车即开玩；嵌入页要让访客自己点一下
  ])
  const missing = [...embed].filter((k) => !play.has(k) && !ONLY_EMBED.has(k))
  const extra = [...play].filter((k) => !embed.has(k) && !ONLY_PLAY.has(k))
  assert.deepEqual(missing, [], `EmbedPage 有而 TvPlay 没有的 prop：${missing.join(', ')}`)
  assert.deepEqual(extra, [], `TvPlay 有而 EmbedPage 没有的 prop：${extra.join(', ')}`)
})

console.log('\n── 详情页与播放器 ──')

const detail = strip(read('src/pages/GameDetailPage.tsx'))
const player = strip(read('src/emulator/EmulatorPlayer.tsx'))

check('详情页读 ?autoplay=1 并把 autoStart 传下去', () => {
  assert.match(detail, /searchParams\.get\('autoplay'\) === '1'/, '没读 autoplay 参数')
  assert.match(detail, /autoStart=\{autoStart\}/, '没把 autoStart 传给播放器')
})

check('播放器认 autoStart 这个 prop', () => {
  assert.match(player, /\n  autoStart\?: boolean/, 'Props 上没有 autoStart')
  assert.match(player, /\n  autoStart,/, '没从 props 里解构出来')
})

check('⚠️ 自动开局只开一次（否则玩家停掉这一局会被立刻拉回去）', () => {
  const i = player.indexOf('autoStartedRef')
  assert.ok(i > 0, '没有「只开一次」的 ref 守卫')
  const body = player.slice(i, i + 600)
  assert.match(body, /if \(!autoStart \|\| autoStartedRef\.current\) return/, '进入条件里没有检查这个标记')
  assert.match(body, /autoStartedRef\.current = true/, '开完没把标记落下')
})

check('⚠️ 没有云端 ROM / 没有运行时时不能把标记消耗掉（romUrl 是异步探的）', () => {
  const i = player.indexOf('autoStartedRef')
  const body = player.slice(i, i + 600)
  const guard = body.indexOf('if (!romUrl || !pageRuntime) return')
  const mark = body.indexOf('autoStartedRef.current = true')
  assert.ok(guard > 0, '没有 romUrl / pageRuntime 的前置判断')
  assert.ok(guard < mark, '标记被放在了前置判断之前 —— 地址还没探到就把这一次自动开局用掉了')
})

console.log('')
if (fails.length) {
  for (const f of fails) console.error('✗ ' + f.name + '\n' + (f.e?.stack ?? f.e))
  console.error(`\n❌ ${fails.length} 条失败 / 共 ${pass + fails.length} 条`)
  process.exit(1)
}
console.log(`✅ TV 回车即播：${pass} 条全过`)
