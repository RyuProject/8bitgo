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

console.log('\n── TV 侧接线 ──')

const tv = strip(read('src/pages/TvPage.tsx'))

check('列表项跳的是详情页并带 ?autoplay=1', () => {
  assert.match(tv, /to=\{`\/games\/\$\{game\.slug\}\?autoplay=1`\}/, '列表项没带 autoplay 参数')
})

check('⚠️ 全屏挂在 onClick 上（回车是 el.click() 派发的，这样才在手势里）', () => {
  assert.match(tv, /onClick=\{\(\) => enterFullscreen\(\)\}/, 'onClick 上没有 enterFullscreen')
})

check('⚠️ 全屏不许在 effect / 定时器里要（那里没有用户手势，浏览器静默拒绝）', () => {
  const calls = [...tv.matchAll(/enterFullscreen\(/g)].length
  const inHandler = [...tv.matchAll(/onClick=\{\(\) => enterFullscreen\(\)\}/g)].length
  assert.equal(calls, inHandler, '除了 onClick，还有别处在调 enterFullscreen —— 确认它仍在手势里')
  assert.doesNotMatch(tv, /useEffect\([\s\S]{0,400}?enterFullscreen\(/, 'effect 里调了全屏')
  assert.doesNotMatch(tv, /setTimeout\([\s\S]{0,200}?enterFullscreen\(/, '定时器里调了全屏')
})

check('⚠️ 跳转必须是 <Link>（整页重载会把刚进的全屏丢掉）', () => {
  const i = tv.indexOf('function ListRow')
  const body = tv.slice(i, tv.indexOf('function ', i + 20))
  assert.match(body, /<Link\b/, 'ListRow 里没有 <Link>')
  assert.doesNotMatch(body, /<a\s[^>]*href=/, 'ListRow 用上了 <a href> —— 整页重载，全屏会没')
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
