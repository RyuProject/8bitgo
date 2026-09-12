/**
 * 「看别人玩 ≠ 自己玩过」的回归测试。跑：npm run test:watch-scope
 *
 * ## 起因
 *
 * 直播间的观众**一帧都没跑过**：画面是主播推过来的视频流，本机既没有 ROM 也没有引擎。
 * 可 liveview 适配器照样会报 `onReady`（它指的是「流接上了」），而播放器拿 onReady
 * 当「游戏跑起来了」。于是在加这道门之前：
 *
 *   · 每进一次直播间 → 给那款游戏 +1 次游玩数（`POST /api/games/<slug>/play`）
 *   · 每进一次直播间 → 那款游戏进侧边栏的「曾经玩过」
 *
 * 玩家的侧边栏里因此堆满了自己根本没玩过的游戏，而游玩数也被看播的人抬着走。
 * 两条都是**静默**的：界面上没有任何异常，只有数字慢慢不对。
 *
 * 同一批还修了另一件事：观众端的工具栏上画着「ROM 语言」下拉框。切一下会把会话拆掉、
 * 按新语言的 ROM 自己开一局 —— 观众当场从直播间掉出去，而他以为自己只是换了个语言。
 *
 * ## 结构
 *
 * 判据那两个函数（playedScope.ts）是纯的，真的 import 进来跑。
 * 两个调用点在 .tsx 里，这套 node 测试加载不了 JSX（见 scripts/helpers/ts-loader.mjs），
 * 只能扫源码 —— 扫的是「接上了没有」，不是「长什么样」。
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { sessionCountsAsPlayed, visitCountsAsPlayed } from '@/emulator/playedScope'

const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)))
const read = (rel) => readFileSync(path.join(root, rel), 'utf8')
/** 去注释再扫：本文件和被扫的源码都在注释里引用了同样的标识符 */
const strip = (t) => t.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')

const player = strip(read('src/emulator/EmulatorPlayer.tsx'))
const detail = strip(read('src/pages/GameDetailPage.tsx'))

let pass = 0
const fails = []
/** 全部跑完再汇总 —— 第一条炸了就退出的话，后面的条目等于没写（见 run-tests.mjs 的文件头） */
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

console.log('\n── 判据：谁算「玩过」 ──')

check('看直播的会话不算玩过', () => assert.equal(sessionCountsAsPlayed({ live: { roomId: 'r1' } }), false))
check('自己玩算', () => assert.equal(sessionCountsAsPlayed({ id: 1 }), true))

/*
  ⚠️ 这两条是产品定的规矩：联机（P2P / 云游戏）**算**玩过。
  游戏确实跑在房主或服务器上，但访客真的在操作这一局。
  哪天有人想「统一一下，反正都不是本机在跑」，得先过这两条。
*/
check('联机（P2P）算玩过', () => assert.equal(sessionCountsAsPlayed({ netplay: { room: 'a' } }), true))
check('云游戏算玩过', () => assert.equal(sessionCountsAsPlayed({ cloud: { id: 'x' } }), true))

check('没有会话时不算（还没开始玩）', () => {
  assert.equal(sessionCountsAsPlayed(null), false)
  assert.equal(sessionCountsAsPlayed(undefined), false)
})

/*
  live: undefined 不算「在看直播」。
  begin() 是 `{ ...extra }` 展开的，没给 live 时这个键压根不存在；
  但只要有人改成显式传 `live: undefined`，一个写成 `'live' in s` 的实现
  就会把**所有**本地会话都判成看直播 —— 全站的游玩数从此不再增长，而且不报错。
*/
check('live: undefined / null 不算看直播', () => {
  assert.equal(sessionCountsAsPlayed({ live: undefined }), true)
  assert.equal(sessionCountsAsPlayed({ live: null }), true)
})

console.log('\n── 详情页那一侧（判据是 URL） ──')

check('带 ?live= 进来的不记「曾经玩过」', () => {
  assert.equal(visitCountsAsPlayed('room-123'), false)
})
check('没有 ?live= 就照记', () => {
  assert.equal(visitCountsAsPlayed(undefined), true)
  assert.equal(visitCountsAsPlayed(null), true)
  assert.equal(visitCountsAsPlayed(''), true)
})

console.log('\n── 接线：播放器 ──')

check('上报游玩次数过 sessionCountsAsPlayed，没有另写一份判断', () => {
  const i = player.indexOf('recordPlay(gameSlugRef.current)')
  assert.ok(i > 0, '找不到 recordPlay 的调用点')
  const seg = player.slice(Math.max(0, i - 300), i)
  assert.match(seg, /sessionCountsAsPlayed\(session\)/)
  assert.doesNotMatch(seg, /!session\.live/, '播放器里还留着手写的判断 —— 两份迟早分叉')
})

check('看完直播自己又开一局时，把「曾经玩过」补记上', () => {
  /*
    详情页那边因为 URL 上有 ?live= 没记。他退出直播自己开了一局 —— 那就是真的玩了。
    少了这一句，这种人玩完之后侧边栏里找不到这款游戏，只能重新搜。
  */
  const i = player.indexOf('recordPlay(gameSlugRef.current)')
  const seg = player.slice(i, i + 300)
  assert.match(seg, /liveInviteRef\.current/)
  assert.match(seg, /recordRecent\(gameSlugRef\.current\)/)
})

check('liveInviteRef 每次渲染都跟着刷新（不能闭包捕获成挂载那一刻的值）', () => {
  assert.match(player, /const liveInviteRef = useRef\(liveInvite\)\s*\n\s*liveInviteRef\.current = liveInvite/)
})

console.log('\n── 接线：详情页 ──')

check('「曾经玩过」过 visitCountsAsPlayed', () => {
  assert.match(detail, /if \(game && visitCountsAsPlayed\(liveInvite\)\) void recordRecent\(game\.slug\)/)
})

check('⚠️ 联机的两个邀请参数没被顺手一起拦掉', () => {
  /*
    产品规矩是「只有看直播不算」。把 ?p2p= / ?room= 也写进这道门的话，
    联机玩完之后侧边栏里同样找不到这款游戏 —— 而这是两种完全不同的场景。
  */
  const i = detail.indexOf('visitCountsAsPlayed(liveInvite)')
  assert.ok(i > 0)
  const seg = detail.slice(i - 120, i + 200)
  assert.doesNotMatch(seg, /\binvite\b(?!=)/, '联机邀请参数被写进了这道门')
  assert.doesNotMatch(seg, /cloudInvite/, '云游戏邀请参数被写进了这道门')
})

check('依赖列表带上 liveInvite（否则换 URL 不重算）', () => {
  const i = detail.indexOf('visitCountsAsPlayed(liveInvite)')
  assert.match(detail.slice(i, i + 200), /\[game\?\.slug, liveInvite\]/)
})

console.log('\n── 接线：观众端不画 ROM 语言切换 ──')

check('语言选择器对看直播的人不画', () => {
  const i = player.indexOf('onRomLangChange && ')
  assert.ok(i > 0, '找不到语言选择器的显示条件')
  const seg = player.slice(i, i + 160)
  assert.match(seg, /!session\?\.live/, '观众端仍然画着语言切换 —— 切一下会把他从直播间踢出去')
  // 联机那道门也不能顺手删掉：房主和访客必须跑同一份 ROM
  assert.match(seg, /!inRoom/)
})

check('inRoom 本身没被改成把直播也算进去（那会连观众席徽章一起变形）', () => {
  const m = player.match(/const inRoom = [^\n]*/)
  assert.ok(m, '找不到 inRoom')
  assert.doesNotMatch(m[0], /live/, 'inRoom 里混进了 live —— 它还管着房间徽章和「离开房间」')
})

console.log('')
if (fails.length) {
  for (const f of fails) console.error('✗ ' + f.name + '\n' + (f.e?.stack ?? f.e))
  console.error(`\n❌ ${fails.length} 条失败 / 共 ${pass + fails.length} 条`)
  process.exit(1)
}
console.log(`✅ 看播不算玩过：${pass} 条全过`)
