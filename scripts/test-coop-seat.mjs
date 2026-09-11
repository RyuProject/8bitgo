/**
 * 「上场当 2P」协议与闸的回归测试。跑：npm run test:coop-seat
 *
 * 这一块的错误后果都很重，而且**在界面上一点痕迹都没有**：
 *   1. 身份取自消息内容而不是通道 → 任何观众都能替 1P 按键（netplayGuard 那次事故的翻版）
 *   2. 漏松键 → 游戏里的角色一直朝墙里跑，玩家只会以为「卡了」，不会想到是刚才那人下场了
 *   3. 不限流 → 一条脚本就能把房主的游戏灌死
 *
 * 纯 node，不需要浏览器。
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const { createSeatGate, parse, encode, MAX_MSG_LEN, KEYS_PER_SEC, WANTS_PER_SEC, COOP_CHANNEL } = await import(
  '../src/emulator/coopSeat.ts'
)

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
const k = (b, d) => encode({ t: 'k', b, d })

/* ---------------- 一、解析：拿不准的一律 null ---------------- */

check('认得四种消息', () => {
  assert.deepEqual(parse('{"t":"want"}'), { t: 'want' })
  assert.deepEqual(parse(k('left', true)), { t: 'k', b: 'left', d: true })
  assert.deepEqual(parse('{"t":"hello","coop":true,"buttons":["up","a"]}'), {
    t: 'hello',
    coop: true,
    buttons: ['up', 'a'],
  })
  assert.deepEqual(parse('{"t":"seat","on":false}'), { t: 'seat', on: false })
  assert.deepEqual(parse('{"t":"leave"}'), { t: 'leave' })
})

check('⚠️ 脏输入一个都不许放过', () => {
  const bad = [
    null, undefined, 0, 1, {}, [], true,
    '', 'nope', '{', '[]', '"str"', 'null',
    '{"t":"k"}',                          // 缺 b/d
    '{"t":"k","b":"left"}',               // 缺 d
    '{"t":"k","b":"left","d":"yes"}',     // d 不是布尔
    '{"t":"k","b":"jump","d":true}',      // 不存在的按钮
    '{"t":"k","b":"UP","d":true}',        // 大小写不算
    '{"t":"hello"}',                      // 缺 coop
    '{"t":"seat"}',                       // 缺 on
    '{"t":"whatever"}',
    JSON.stringify({ t: 'k', b: 'left', d: true, extra: 'x'.repeat(MAX_MSG_LEN) }), // 超长
  ]
  for (const raw of bad) assert.equal(parse(raw), null, `应当拒绝：${String(raw).slice(0, 40)}`)
})

check('只收字符串 —— 二进制帧不认（省掉一整类解码歧义）', () => {
  assert.equal(parse(new ArrayBuffer(8)), null)
  assert.equal(parse(new Uint8Array([1, 2, 3])), null)
})

check('按钮清单里认不出的成员剔掉，一个不剩就当没给', () => {
  assert.deepEqual(parse('{"t":"seat","on":true,"buttons":["up","zzz"]}'), { t: 'seat', on: true, buttons: ['up'] })
  assert.deepEqual(parse('{"t":"seat","on":true,"buttons":["zzz"]}'), { t: 'seat', on: true })
  assert.deepEqual(parse('{"t":"seat","on":true,"buttons":"up"}'), { t: 'seat', on: true })
})

/* ---------------- 二、闸：身份只认通道 ---------------- */

check('⚠️ 没人持座时，谁的按键都不放行', () => {
  const g = createSeatGate()
  assert.equal(g.seated(), null)
  assert.equal(g.admit('viewer-1', k('left', true)), null)
})

check('⚠️ 只有持座那一位的按键放行，别人的静默丢', () => {
  const g = createSeatGate()
  g.grant('viewer-1')
  assert.deepEqual(g.admit('viewer-1', k('left', true)), { t: 'k', b: 'left', d: true })
  assert.equal(g.admit('viewer-2', k('right', true)), null, '另一个观众不许按')
  assert.equal(g.admit('viewer-2', k('a', true)), null)
  // 被收回座位的人立刻失效
  g.revoke()
  assert.equal(g.admit('viewer-1', k('left', true)), null, '收回之后原持座人也不许再按')
})

check('「我想上场」谁都能发（这才是入口），但单独限流', () => {
  const g = createSeatGate()
  let now = 1000
  assert.deepEqual(g.admit('anyone', '{"t":"want"}', now), { t: 'want' })
  for (let i = 0; i < WANTS_PER_SEC; i++) assert.equal(g.admit('anyone', '{"t":"want"}', now), null, '同一秒内不许再来')
  now += 1000
  assert.deepEqual(g.admit('anyone', '{"t":"want"}', now), { t: 'want' }, '下一秒又可以')
})

check('⚠️ 按键限流：超过上限静默丢，下一秒恢复', () => {
  const g = createSeatGate()
  g.grant('v')
  let now = 5000
  let ok = 0
  for (let i = 0; i < KEYS_PER_SEC + 50; i++) if (g.admit('v', k('left', i % 2 === 0), now)) ok++
  assert.equal(ok, KEYS_PER_SEC, `一秒内只该放行 ${KEYS_PER_SEC} 条`)
  assert.ok(g.admit('v', k('left', true), now + 1000), '下一个窗口恢复')
})

check('房主发的那两种消息，房主自己收到时必须丢（只可能是对面在乱发）', () => {
  const g = createSeatGate()
  g.grant('v')
  assert.equal(g.admit('v', '{"t":"seat","on":true}'), null)
  assert.equal(g.admit('v', '{"t":"hello","coop":true}'), null)
})

/* ---------------- 三、松键：这个功能最要紧的性质 ---------------- */

check('⚠️ 收回座位时，把还按着的键全部交出来', () => {
  const g = createSeatGate()
  g.grant('v')
  g.admit('v', k('left', true))
  g.admit('v', k('a', true))
  g.admit('v', k('right', true))
  g.admit('v', k('right', false)) // 松过的不算
  assert.deepEqual([...g.held()].sort(), ['a', 'left'])
  assert.deepEqual([...g.revoke()].sort(), ['a', 'left'], '收座必须报出要松的键')
  assert.deepEqual(g.held(), [], '交出去之后自己清空，别松第二遍')
  assert.deepEqual(g.revoke(), [])
})

check('⚠️ 观众断线（forget）同样要松键', () => {
  const g = createSeatGate()
  g.grant('v')
  g.admit('v', k('up', true))
  assert.deepEqual(g.forget('v'), ['up'])
  assert.equal(g.seated(), null)
})

check('⚠️ 换人时把上一位按着的键松掉', () => {
  const g = createSeatGate()
  g.grant('a')
  g.admit('a', k('down', true))
  assert.deepEqual(g.grant('b'), ['down'], '换人 = 上一位的键必须松')
  assert.equal(g.seated(), 'b')
  assert.deepEqual(g.held(), [])
})

check('别人断线不影响持座那位按着的键', () => {
  const g = createSeatGate()
  g.grant('a')
  g.admit('a', k('left', true))
  assert.deepEqual(g.forget('someone-else'), [])
  assert.deepEqual(g.held(), ['left'], '不该把持座人的键误松')
  assert.equal(g.seated(), 'a')
})

check('重复 grant 同一个人不清键（重连对照名单时会走到）', () => {
  const g = createSeatGate()
  g.grant('a')
  g.admit('a', k('left', true))
  assert.deepEqual(g.grant('a'), [])
  assert.deepEqual(g.held(), ['left'])
})

check('⚠️ 「我下场」只有持座那位说了算', () => {
  const g = createSeatGate()
  g.grant('a')
  assert.equal(g.admit('b', '{"t":"leave"}'), null, '别人不能替持座人下场')
  assert.deepEqual(g.admit('a', '{"t":"leave"}'), { t: 'leave' })
})

/* ---------------- 三点五、观众换 socket.id（viewer-rebound） ---------------- */

check('⚠️ 同一个人换 id 后，座位跟着走、按着的键不清', () => {
  const g = createSeatGate()
  g.grant('old-id')
  g.admit('old-id', k('left', true))
  g.rename('old-id', 'new-id')
  assert.equal(g.seated(), 'new-id', '座位必须跟着改名 —— 不然他从此一个键都送不进来')
  assert.deepEqual(g.held(), ['left'], '人没变、手还按着，别清')
  assert.ok(g.admit('new-id', k('right', true)), '新 id 应当能继续按')
  assert.equal(g.admit('old-id', k('right', true)), null, '旧 id 不再作数')
})

check('改名只搬持座那位；别人改名不该把座位抢过去', () => {
  const g = createSeatGate()
  g.grant('a')
  g.rename('b', 'c')
  assert.equal(g.seated(), 'a')
  g.rename('a', 'a')
  assert.equal(g.seated(), 'a')
})

check('限流计数跟着改名搬走（否则重连一次就能重置配额）', () => {
  const g = createSeatGate()
  const now = 1000
  assert.ok(g.admit('a', '{"t":"want"}', now))
  assert.equal(g.admit('a', '{"t":"want"}', now), null)
  g.rename('a', 'b')
  assert.equal(g.admit('b', '{"t":"want"}', now), null, '换个名字不该刷新配额')
})

/* ---------------- 四、按钮白名单（第二道闸） ---------------- */

check('给了 2P 的键集就只放行那几颗', () => {
  let list = ['up', 'left', 'right']
  const g = createSeatGate(() => list)
  g.grant('v')
  assert.ok(g.admit('v', k('left', true)))
  assert.equal(g.admit('v', k('a', true)), null, 'a 不在这一局的 2P 键里')
  // 这一局没有 2P 位 → 一个键都不该进
  list = []
  assert.equal(g.admit('v', k('left', true)), null)
})

/* ---------------- 五、源码守卫 ---------------- */

check('⚠️ 协议里不许出现自报的座位号 / 玩家号字段', () => {
  const src = readFileSync(path.join(ROOT, 'src/emulator/coopSeat.ts'), 'utf8')
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
  for (const bad of ['m.player', 'm.seat', 'msg.player', "'player'"]) {
    assert.ok(!code.includes(bad), `协议里出现了 ${bad} —— 身份只能来自通道，见文件头`)
  }
  assert.match(code, /from !== seat/, 'admit 必须比对发送方和持座人')
})

check('通道名两边共用一个常量', () => {
  assert.equal(COOP_CHANNEL, 'coop')
})

const read = (rel) => readFileSync(path.join(ROOT, rel), 'utf8')
/** 剥注释再断言 —— 这几个文件里的注释本身就在讲这些规则，不剥会对着注释判通过 */
const code = (rel) => read(rel).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')

check('⚠️ 输入通道必须在 createOffer **之前**建', () => {
  const src = code('src/emulator/broadcast.ts')
  const open = src.indexOf('openInput(entry)')
  const offer = src.indexOf('pc.createOffer()')
  assert.ok(open > 0, '找不到 openInput 调用')
  assert.ok(offer > 0, '找不到 createOffer')
  assert.ok(
    open < offer,
    '通道要进 SDP 才不用重新协商。放到 createOffer 之后 = 观众永远收不到通道，' +
      '而且**没有任何报错**：直播照常、只是「上场」那颗按钮永远不出现',
  )
})

check('⚠️ 访客的按键必须送到座位 1，不是 0', () => {
  const src = code('src/emulator/LiveControls.tsx')
  // ⚠️ 必须**逐个**看：只 match 一次的话，两条路里有一条写错了照样是绿的（变异验过）
  const calls = src.match(/sendButton\?\.\(button, down, (\d+)\)/g) || []
  assert.equal(calls.length, 2, '自动开播和分享标签页两条路都要接上访客的按键')
  for (const c of calls) {
    assert.ok(
      c.endsWith(', 1)'),
      `${c} —— 座位写成 0 就是让访客替 1P 按键，房主自己那个角色会被别人操作`,
    )
  }
  assert.equal((src.match(/onGuestInput:/g) || []).length, 2)
})

check('⚠️ 两条开播路径的回调集合必须一致（漏接一个是静默的）', () => {
  /*
    LiveControls 有两处 startBroadcast：自动开播、以及抓不到画布时的「分享标签页」。
    往其中一处加回调、忘了另一处 —— 这类漏接**完全静默**，而且只在那条冷路径上现形。

    2026-09-10 就靠这一条查出来：分享标签页那一路**没接 onChat**，走这条路开播的主播
    看不到任何弹幕（连自己发的都看不到，因为服务端不做本地回显），而观众那边一切正常，
    主播只会以为「没人说话」。跨源 HTML5 那些抓不到画布的游戏走的正是这条路。
  */
  const src = code('src/emulator/LiveControls.tsx')
  const callbacks = (anchor) => {
    const i = src.indexOf(anchor)
    assert.ok(i > 0, `找不到开播路径：${anchor}`)
    const seg = src.slice(i, i + 2600)
    return [...new Set([...seg.matchAll(/\b(on[A-Z]\w+):/g)].map((m) => m[1]))].sort()
  }
  const auto = callbacks('sources: () => handle.captureSources')
  const manual = callbacks('sources: { stream }')
  assert.deepEqual(manual, auto, '两条路径接的回调不一样 —— 少的那一路会静默地缺一块功能')
  // 这几个是这个功能和弹幕赖以工作的，单独点名，别哪天两边一起被删掉还判「一致」
  for (const must of ['onChat', 'onGuestInput', 'onSeatRequest', 'onSeatChange']) {
    assert.ok(auto.includes(must), `两条路径都缺 ${must}`)
  }
})

check('⚠️ 访客侧不许自己建通道（只能等 ondatachannel）', () => {
  const src = code('src/emulator/adapters/liveview.ts')
  assert.ok(
    !src.includes('createDataChannel'),
    '通道由房主建。访客再建一条 = 两条通道，房主那边收不到、访客却以为发出去了',
  )
  assert.match(src, /ondatachannel/, '访客靠 ondatachannel 接房主建的那条')
})

check('⚠️ 「有人想上场」必须画进画面内浮层，全屏 / 沉浸式也看得见能点', () => {
  const ep = code('src/emulator/EmulatorPlayer.tsx')
  for (const bit of ['coop?.pending', 'coop.accept', 'coop.dismiss']) {
    assert.ok(ep.includes(bit), `画面内那张卡少了 ${bit}`)
  }
  /*
    弹幕框那一行（👥 按钮的家）带着 `!fullscreen && !playMode`，而这两种布局
    恰恰是玩同屏双打最常见的姿势。卡片必须画在**画面内那一段**（文件里在弹幕框之前），
    跟着那一行一起画的话，观众的请求在全屏下会一声不响地掉在地上。
  */
  const card = ep.indexOf('coop?.pending')
  const bar = ep.indexOf('chatBarOn &&')
  assert.ok(card > 0 && bar > 0, '找不到卡片或弹幕框那一段')
  assert.ok(card < bar, '卡片跑到弹幕框那一段里去了 —— 全屏时会跟着一起被藏掉')
})

check('⚠️ 座位请求要会过期（房主没看见 / 那人早走了）', () => {
  const lc = code('src/emulator/LiveControls.tsx')
  assert.match(lc, /SEAT_WANT_TTL_MS/, '请求要有过期时间，否则一张挂十分钟的卡片只会误导')
  assert.match(lc, /setSeatWant\(null\), SEAT_WANT_TTL_MS/)
})

check('⚠️ 座位一变就要重报能力，否则屏幕手柄不出现 / 不消失', () => {
  const src = code('src/emulator/adapters/liveview.ts')
  const i = src.indexOf('const setSeated')
  assert.ok(i > 0, '找不到 setSeated')
  const body = src.slice(i, src.indexOf('\n  const ', i + 10))
  assert.match(body, /caps\.add\('touchpad'\)/, '有座才画屏幕手柄')
  assert.match(body, /caps\.delete\('touchpad'\)/, '没座就得撤掉')
  assert.match(body, /onCaps\?\.\(caps\)/, '改了能力必须报一次 —— 不报界面不会跟着变')
  assert.match(body, /releaseCoopKeys\(\)/, '丢座位时先把按着的键松开')
})

console.log(failed ? `\n${failed} 项失败` : '\n全部通过')
process.exit(failed ? 1 : 0)
