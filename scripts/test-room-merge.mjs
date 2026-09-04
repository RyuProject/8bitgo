/**
 * 大厅合卡的自检（src/services/roomMerge.ts）。
 *
 * 主播点「联机」之后，同一局同时在联机列表和直播列表里 —— 直播不停，观众才不会掉。
 * 合并错了的症状是**房间在大厅里凭空消失**，靠肉眼盯不出来，所以拿测试兜着。
 *
 * 用法：npm run test:room-merge
 */
import assert from 'node:assert/strict'
import { mergeLiveIntoP2p } from '../src/services/roomMerge.ts'

let n = 0
const ok = (cond, msg) => { assert.ok(cond, msg); n++; console.log('✅ ' + msg) }

const p2pRoom = (roomId, extra = {}) => ({
  roomId, gameSlug: 'kof97', players: 1, max: 2, spectators: 0,
  host: { nickname: '房主' }, members: [], createdAt: 1, kind: 'p2p', wave: true, ...extra,
})
const liveView = (roomId) => ({
  roomId, gameSlug: 'kof97', players: 1, max: 1, spectators: 3,
  host: { nickname: '房主' }, members: [], createdAt: 2, kind: 'live',
})

console.log('── 配对上了就合成一张 ──')
{
  const out = mergeLiveIntoP2p(
    [p2pRoom('NP-1')],
    [{ netplayRoomId: 'NP-1', viewers: 3, view: liveView('LIVE-1') }],
  )
  ok(out.length === 1, `只剩一张卡（实际 ${out.length}）`)
  ok(out[0].kind === 'p2p', '留下的是联机那张（它才有手柄位可以坐下）')
  ok(out[0].spectators === 3, `直播的观众并进了观战席（实际 ${out[0].spectators}）`)
  ok(out[0].wave === true, '手柄位还空着，举手还在')
}

console.log('\n── 联机列表还没跟上时不能让房间消失 ──')
{
  // 两份数据是分别取的：/api/netplay/rooms 走 SSE、/api/live/rooms 是轮询，慢一拍是常事
  const out = mergeLiveIntoP2p([], [{ netplayRoomId: 'NP-1', viewers: 3, view: liveView('LIVE-1') }])
  ok(out.length === 1 && out[0].kind === 'live', '联机房还没到，直播卡照常摆出来')
}

console.log('\n── 纯直播、纯联机各走各的 ──')
{
  const out = mergeLiveIntoP2p(
    [p2pRoom('NP-1'), p2pRoom('NP-2', { players: 2, wave: false })],
    [{ viewers: 5, view: liveView('LIVE-A') }, { netplayRoomId: 'NP-1', viewers: 2, view: liveView('LIVE-1') }],
  )
  ok(out.length === 3, `两张联机 + 一张纯直播 = 3 张（实际 ${out.length}）`)
  ok(out.find((r) => r.roomId === 'NP-1').spectators === 2, '只有配对的那张加了观众')
  ok(out.find((r) => r.roomId === 'NP-2').spectators === 0, '没配对的联机房观众数不动')
  ok(out.find((r) => r.roomId === 'NP-2').wave === false, '满员的房间不举手')
  ok(out.some((r) => r.roomId === 'LIVE-A'), '纯直播照常摆出来')
}

console.log('\n── 不改原数组 ──')
{
  const p2p = [p2pRoom('NP-1')]
  const before = JSON.stringify(p2p)
  mergeLiveIntoP2p(p2p, [{ netplayRoomId: 'NP-1', viewers: 9, view: liveView('L') }])
  ok(JSON.stringify(p2p) === before, '传进来的列表没被就地改掉（React 的 memo 靠引用比对）')
}

console.log('\n── 边界 ──')
{
  ok(mergeLiveIntoP2p([], []).length === 0, '两边都空 → 空列表')
  const out = mergeLiveIntoP2p([p2pRoom('NP-1')], [{ netplayRoomId: 'NP-1', view: liveView('L') }])
  ok(out[0].spectators === 0, 'viewers 没给时当 0，不会变 NaN')
}

console.log(`\n全部通过 ✅  共 ${n} 项`)
