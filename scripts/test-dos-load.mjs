/**
 * DOS「读档」按钮的回归测试。跑：npm run test:dos-load
 *
 * ## 这一份在守什么
 *
 * DOS 没有「把一份快照灌回正在跑的机器」这种操作。js-dos 存的是**盘上被改过的文件**，
 * 而它只在**开机时**调一次 fsChanges.pull —— 所以读档只能是
 * 「重开这一局，让引擎开机时把存档装回盘上」。这条物理约束决定了整个实现的形状，
 * 下面查的每一条都是它的直接推论：
 *
 *   1. 重开必须是**原地**的（换一个 session 号重挂引擎），不是 window.location.reload()。
 *      整页刷新也能读上档，但 React、引擎壳、系统镜像、ROM 全部重走一遍 ——
 *      Windows 客体那种要几十秒，而玩家刚被怪打死、只想回到五分钟前。
 *   2. 联机 / 云游戏 / 看直播**不能**重开：那三种的游戏状态不在本机这一份引擎里，
 *      重开只会把房间拆掉或者断掉那一路。玩家点的是「读档」，绝不会预期这个结果。
 *      ⚠️ 这是最容易被新功能悄悄破坏的一条：以后再加一种「游戏不在本机跑」的会话，
 *      漏掉它不会报错，只会在联机时炸。所以判断被拎进 sessionRestart.ts 单独测。
 *   3. 读档面板必须有**自己**的 <input type=file>。两个面板互斥渲染，
 *      panel === 'fsLoad' 时 💾 面板整块不在 DOM 里，共用 ref 的结果是点了没反应。
 *   4. 八种语言的文案都要有，而且占位符要齐 —— 少一个 {when}，
 *      那一门语言的玩家就永远看不到「存档是什么时候的」，而这正是他决定要不要点的依据。
 *
 * ## 为什么一半是扫源码
 *
 * .tsx 里的 JSX 这套 node 测试加载不了（--experimental-strip-types 只脱类型、不转 JSX，
 * 见 scripts/helpers/ts-loader.mjs）。所以纯逻辑那一半（canRestartInPlace）
 * 真的 import 进来跑，接线那一半只能扫结构 —— 扫的是「接上了没有」，不是「长什么样」。
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { canRestartInPlace } from '@/emulator/sessionRestart'

const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)))
const read = (rel) => readFileSync(path.join(root, rel), 'utf8')

/**
 * 去注释再扫。
 * 本文件和被扫的源码里都有大段解释「reload」「netplay」的注释，
 * 不去掉的话下面那些「不许出现 X」会被注释文字命中（test-toolbar-line.mjs 踩过）。
 * `(^|[^:])` 那道前置是为了别把 https:// 当成行注释。
 */
const strip = (t) => t.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')

const tools = strip(read('src/emulator/EmulatorTools.tsx'))
const player = strip(read('src/emulator/EmulatorPlayer.tsx'))

/**
 * 全部跑完再汇总，不在第一条就退出。
 * run-tests.mjs 的文件头写着为什么：test:indexnow 红了三天，而它的 check()
 * 第一条炸了就整个退出，28 条里只跑到第 6 条 —— 后面 22 条一条都没执行。
 */
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

console.log('\n── canRestartInPlace：哪些会话能原地重开 ──')

check('没有会话 → 不能重开（null）', () => assert.equal(canRestartInPlace(null), false))
check('没有会话 → 不能重开（undefined）', () => assert.equal(canRestartInPlace(undefined), false))
check('本地这一局 → 能重开', () => assert.equal(canRestartInPlace({}), true))
check('带无关字段的本地会话 → 能重开', () =>
  assert.equal(canRestartInPlace({ id: 7, game: 'zeek.zip', platform: 'dos' }), true))

check('联机（netplay）→ 不能重开', () => assert.equal(canRestartInPlace({ netplay: { room: 'a' } }), false))
check('云游戏（cloud）→ 不能重开', () => assert.equal(canRestartInPlace({ cloud: { id: 'x' } }), false))
check('看直播（live）→ 不能重开', () => assert.equal(canRestartInPlace({ live: { host: 'b' } }), false))
check('同时联机 + 云游戏 → 不能重开', () =>
  assert.equal(canRestartInPlace({ netplay: {}, cloud: {} }), false))

/*
  ⚠️ 标记为 undefined 不算「有」。
  begin() 是 `{ ...extra }` 展开的，extra 里没给 netplay 时这个键压根不存在；
  但只要有人改成显式传 `netplay: undefined`，一个写成 `'netplay' in s` 的实现
  就会把所有本地会话都判成不能重开 —— 读档按钮全站消失，而且没有任何报错。
*/
check('netplay: undefined 不算联机 → 仍能重开', () =>
  assert.equal(canRestartInPlace({ netplay: undefined, cloud: undefined, live: undefined }), true))

check('netplay: null 不算联机 → 仍能重开', () => assert.equal(canRestartInPlace({ netplay: null }), true))

console.log('\n── 播放器：把重开能力交给工具栏 ──')

check('EmulatorTools 收到 onRestart={restartSession}', () =>
  assert.match(player, /onRestart=\{restartSession\}/))

check('restartSession 走 canRestartInPlace 判定，没有另写一份', () => {
  const i = player.indexOf('const restartSession =')
  assert.ok(i > 0, '找不到 restartSession')
  assert.match(player.slice(i, i + 300), /canRestartInPlace\(session\)/)
})

/*
  「哪些会话不能重挂引擎」这个判断，播放器里有**两处**要用：读档，和加载失败后的自动重试
  （onError 里那段 —— 它同样是 begin() 原地重挂）。两处必须是同一份。

  以前自动重试那儿手写着 `!session.netplay && !session.cloud && !session.live`。
  留着它才是真正的风险：以后新增一种「游戏不在本机跑」的会话，
  sessionRestart.ts 那份改了、这份没改，两份判断分叉 ——
  而分叉的表现只在联机时出现，还不报错。
*/
check('自动重试和读档共用同一份会话判断，没有第二份手写的', () => {
  const hits = player.match(/canRestartInPlace\(session\)/g) ?? []
  assert.equal(hits.length, 2, `canRestartInPlace(session) 用了 ${hits.length} 处，应该是读档 + 自动重试两处`)
  assert.match(player, /if \(!ready && canRestartInPlace\(session\) && attempt < AUTO_RETRY_LIMIT\)/)
  assert.doesNotMatch(
    player,
    /!session\.netplay && !session\.cloud && !session\.live/,
    '播放器里还留着手写的那一份会话种类判断',
  )
})

check('重开用的是同一局的 ROM / 平台 / 运行时（是重开，不是重新挑）', () =>
  assert.match(player, /begin\(session\.game,\s*session\.platform,\s*session\.runtime\)/))

console.log('\n── 工具栏：📂 读档 ──')

check("panel 状态里有 'fsLoad'", () => assert.match(tools, /'fsSave'\s*\|\s*'fsLoad'/))

check('📂 按钮按 fsFile 能力显示（只有 js-dos 会报这个能力）', () => {
  const i = tools.indexOf('📂')
  assert.ok(i > 0, '找不到 📂 按钮')
  // 按钮那一段（往前 700 字符）里必须有 caps.has('fsFile') 这道门
  assert.match(tools.slice(Math.max(0, i - 700), i), /caps\.has\('fsFile'\)/)
})

check('点 📂 开面板，不是点一下就重开', () => {
  const i = tools.indexOf('📂')
  const seg = tools.slice(Math.max(0, i - 700), i)
  assert.match(seg, /setPanel\(panel === 'fsLoad' \? null : 'fsLoad'\)/)
  assert.doesNotMatch(seg, /onClick=\{restartNow\}/, '📂 按钮直接重开了，没有先给警告面板')
})

const panel = (() => {
  const i = tools.indexOf("{panel === 'fsLoad' && (")
  assert.ok(i > 0, "找不到 panel === 'fsLoad' 面板")
  return tools.slice(i)
})()

check('读档面板把「会丢掉没存的进度」说出来了', () => assert.match(panel, /tt\.fsLoadWarn/))

check('读档面板会说现在有没有存档、存在哪儿、什么时候存的', () => {
  assert.match(panel, /tt\.fsLoadHave/)
  assert.match(panel, /tt\.fsLoadNone/)
  assert.match(panel, /timeAgo\(archived\.updatedAt/)
})

check('「读档并重开」调 restartNow', () => assert.match(panel, /onClick=\{restartNow\}/))

check('读档面板用自己的 fsLoadFileRef，不蹭 💾 面板那个（蹭了会点了没反应）', () => {
  assert.match(panel, /ref=\{fsLoadFileRef\}/)
  assert.match(panel, /fsLoadFileRef\.current\?\.click\(\)/)
  assert.doesNotMatch(panel, /fsFileRef/, '读档面板里出现了 💾 面板那个 ref')
})

check('fsLoadFileRef 真的被声明了（不是拼错的新标识符）', () =>
  assert.match(tools, /const fsLoadFileRef = useRef<HTMLInputElement \| null>\(null\)/))

check('「从文件读档」是导入 + 重开一次做完', () =>
  assert.match(panel, /doFsImport\(e\.target\.files\?\.\[0\], true\)/))

check('doFsImport 的 andRestart 分支真的会重开', () => {
  const i = tools.indexOf('const doFsImport =')
  assert.ok(i > 0)
  const body = tools.slice(i, i + 1400)
  assert.match(body, /if \(andRestart\)/)
  assert.match(body, /restartNow\(\)/)
})

check('整页刷新只剩 restartNow 里那一处兜底', () => {
  const hits = tools.match(/window\.location\.reload\(\)/g) ?? []
  assert.equal(hits.length, 1, `window.location.reload() 出现了 ${hits.length} 次，应该只有 restartNow 里那一处`)
  const i = tools.indexOf('const restartNow =')
  assert.ok(i > 0, '找不到 restartNow')
  assert.ok(
    tools.indexOf('window.location.reload()') > i && tools.indexOf('window.location.reload()') < i + 400,
    'reload 不在 restartNow 里 —— 某个按钮又在直接刷整页了',
  )
})

check('restartNow 有 onRestart 就原地重开，没有才刷整页', () => {
  const i = tools.indexOf('const restartNow =')
  const body = tools.slice(i, i + 400)
  assert.match(body, /if \(onRestart\) onRestart\(\)/)
  assert.match(body, /else window\.location\.reload\(\)/)
})

check('💾 面板里那颗「↻ 重开这一局」也改走 restartNow 了', () => {
  const i = tools.indexOf('tt.fsImportReload')
  assert.ok(i > 0)
  assert.match(tools.slice(Math.max(0, i - 400), i), /onClick=\{restartNow\}/)
})

console.log('\n── 八种语言的文案 ──')

const LANGS = ['zh-Hans', 'zh-Hant', 'en', 'ja', 'de', 'fr', 'es', 'it']
const KEYS = ['fsLoad', 'fsLoadWhy', 'fsLoadWarn', 'fsLoadHave', 'fsLoadNone', 'fsLoadConfirm', 'fsLoadFile']
/** 取某个键的字面量值。单引号和双引号两种写法都要认（带撇号的语言用双引号） */
const valueOf = (src, key) => {
  const m = src.match(new RegExp(`\\n\\s*${key}: (['"])((?:\\\\.|(?!\\1).)*)\\1,`))
  return m ? m[2] : null
}

for (const lang of LANGS) {
  const src = read(`src/locales/${lang}.ts`)
  check(`${lang}：七个键都在`, () => {
    const missing = KEYS.filter((k) => valueOf(src, k) === null)
    assert.deepEqual(missing, [], `缺：${missing.join(', ')}`)
  })
  /*
    占位符缺一个不会报错，只会**静默少一段信息**。
    fsLoadHave 少了 {when}，那门语言的玩家永远看不到存档是什么时候的 ——
    而这正是他判断「要不要点下去」的唯一依据。
  */
  check(`${lang}：fsLoadHave 的 {where} 和 {when} 都在`, () => {
    const v = valueOf(src, 'fsLoadHave') ?? ''
    assert.ok(v.includes('{where}'), '少了 {where}')
    assert.ok(v.includes('{when}'), '少了 {when}')
  })
  check(`${lang}：读档文案不是照抄基准语言以外的空串`, () => {
    for (const k of KEYS) assert.ok((valueOf(src, k) ?? '').trim().length > 0, `${k} 是空的`)
  })
}

/*
  组件里引用到的每个 tt.fsLoadX，基准语言（zh-Hans，Translation 类型的来源）里都得有。
  tsc 也拦得住这件事，但 npm test 不跑 tsc —— 而这一句是本地改文案时最容易漏的一步。
*/
check('组件引用的 fsLoad* 文案键在基准语言里都存在', () => {
  const zh = read('src/locales/zh-Hans.ts')
  const used = [...new Set([...tools.matchAll(/tt\.(fsLoad[A-Za-z]*)/g)].map((m) => m[1]))]
  assert.ok(used.length >= 6, `只扫到 ${used.length} 个 fsLoad* 引用，正则可能失效了`)
  const missing = used.filter((k) => valueOf(zh, k) === null)
  assert.deepEqual(missing, [], `zh-Hans 里没有：${missing.join(', ')}`)
})

console.log('')
if (fails.length) {
  for (const f of fails) console.error('✗ ' + f.name + '\n' + (f.e?.stack ?? f.e))
  console.error(`\n❌ ${fails.length} 条失败 / 共 ${pass + fails.length} 条`)
  process.exit(1)
}
console.log(`✅ DOS 读档：${pass} 条全过`)
