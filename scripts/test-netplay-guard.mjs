/**
 * 房主端联机输入通道守门的回归测试（src/emulator/netplayGuard.ts）。
 *
 * 盯的坑：访客的按键走 WebRTC DataChannel，服务器看不见；EmulatorJS 房主那端照单全收 ——
 * `simulateInput(e.player, …)` 信对方自填的手柄号，`{type:'host-left'}` 一句话就能把房主踢出自己的房间。
 * 这里用假的 DataChannel（EventTarget）和假的 netplay 实例，验守门逻辑本身。
 *
 * 跑：npm run test:netplay-guard
 */
import assert from 'node:assert/strict'
import { guardInputChannel, sanitizeGuestInput, seatOfPeer, INPUT_MSGS_PER_SEC } from '../src/emulator/netplayGuard.ts'

let n = 0
const ok = (cond, msg) => { assert.ok(cond, msg); n++; console.log('✅ ' + msg) }

/* ---- 浏览器环境的最小桩 ---- */
class FakeChannel extends EventTarget {}
globalThis.MessageEvent = class MessageEvent extends Event {
  constructor(type, init) { super(type); this.data = init?.data }
}
const pcP2 = {}, pcSpec = {}, pcStranger = {}
const np = {
  owner: true,
  peerConnections: { 'sock-p2': { pc: pcP2 }, 'sock-sp': { pc: pcSpec } },
  // 服务端 usersPayload 的顺序：玩家在前（房主、2P），观众在后
  players: {
    'host-id': { socketId: 'sock-host', role: 'player' },
    'p2-id': { socketId: 'sock-p2', role: 'player' },
    'sp-id': { socketId: 'sock-sp', role: 'spectator' },
  },
}
const got = []
const mk = (pc) => {
  const ch = new FakeChannel()
  guardInputChannel(() => np, ch, pc)
  ch.onmessage = (ev) => got.push(JSON.parse(ev.data)) // 引擎的写法
  return ch
}
const send = (ch, data) => ch.dispatchEvent(Object.assign(new Event('message'), { data }))
const input = (player, index = 8, value = 1) => JSON.stringify({ player, index, value })

console.log('── 手柄位 ──')
ok(seatOfPeer(np, pcP2) === 1, '2P 的连接算出来是 1 号手柄')
ok(seatOfPeer(np, pcSpec) === -1, '观众的连接是 -1')
ok(seatOfPeer(np, pcStranger) === -1, '不在 peerConnections 里的连接是 -1')

console.log('\n── 冒充与踢人 ──')
const p2 = mk(pcP2)
send(p2, input(0))
ok(got.length === 1 && got[0].player === 1, `2P 冒充 1P 的按键被改写到自己的手柄位（player=${got[0]?.player}）`)
got.length = 0
send(p2, input(1))
ok(got.length === 1 && got[0].player === 1 && got[0].index === 8 && got[0].value === 1, '2P 正常按键原样放行')
got.length = 0
send(p2, JSON.stringify({ type: 'host-left' }))
ok(got.length === 0, '访客发的 host-left 被丢掉（踢不掉房主）')
send(p2, JSON.stringify({ type: 'anything', player: 1, index: 8, value: 1 }))
ok(got.length === 0, '带 type 的消息一律不放行')

console.log('\n── 畸形输入 ──')
for (const bad of ['not json', 'null', '[1]', '"str"', JSON.stringify({ player: 1, index: 'x', value: 1 }), JSON.stringify({ player: 1, index: 8, value: 1e9 }), JSON.stringify({ player: 1, index: -1, value: 1 }), JSON.stringify({ player: 1, index: 999, value: 1 }), 'x'.repeat(300)]) send(p2, bad)
ok(got.length === 0, '畸形 / 越界 / 超长的输入全部丢掉')
ok(sanitizeGuestInput(np, pcP2, JSON.stringify({ player: '1', index: '8', value: '1' })) === input(1), '字串形式的数字被规范化成数字')

console.log('\n── 观众与陌生连接 ──')
const sp = mk(pcSpec)
send(sp, input(0)); send(sp, input(2))
ok(got.length === 0, '观众的按键一条都不放行')
const stranger = mk(pcStranger)
send(stranger, input(0))
ok(got.length === 0, '认不出来的连接不放行')
np.owner = false
send(p2, input(1))
ok(got.length === 0, '自己不是房主时不放行')
np.owner = true

console.log('\n── 观众上场后手柄号跟着 players 表变 ──')
np.players = {
  'host-id': { socketId: 'sock-host', role: 'player' },
  'p2-id': { socketId: 'sock-p2', role: 'player' },
  'sp-id': { socketId: 'sock-sp', role: 'player' }, // 服务端 /role 把他排到玩家组末尾
}
send(sp, input(0))
ok(got.length === 1 && got[0].player === 2, `上场后的观众按键落到 3 号手柄（player=${got[0]?.player}）`)
got.length = 0

console.log('\n── 限流 ──')
const flood = mk(pcP2)
for (let i = 0; i < INPUT_MSGS_PER_SEC + 200; i++) send(flood, input(1, 8, i % 2))
ok(got.length === INPUT_MSGS_PER_SEC, `每秒最多 ${INPUT_MSGS_PER_SEC} 条（放行 ${got.length}）`)
got.length = 0

console.log('\n── onmessage 语义 ──')
ok(typeof p2.onmessage === 'function', 'onmessage 读回来是引擎赋的 handler')
p2.onmessage = null
send(p2, input(1))
ok(got.length === 0, 'handler 置空后不再投递')
const throwing = mk(pcP2)
throwing.onmessage = () => { throw new Error('engine bug') }
send(throwing, input(1))
ok(true, '引擎 handler 抛异常不影响守门')

console.log(`\n全部通过 ✅（${n} 项）`)
