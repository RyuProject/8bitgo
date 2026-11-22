/**
 * 成人游戏的 P2P 联机房：可见性与准入（§2.23，与直播同一条年龄规则）。
 * 不连数据库：游戏策略与查用户都注入。HTTP 列表带 JWT 时要走 optionalUser（查库），
 * 这里只验证「匿名一律看不到」那一侧；带 JWT 的放行由 test-live 的 adultLiveAccessError 用例覆盖。
 * 用法： node server/scripts/test-netplay-adult.mjs
 */
import { createServer } from 'node:http'
import express from 'express'
import { io as ioc } from 'socket.io-client'
import { normalizeGamePlayers } from '../../shared/netplay-players.js'

process.env.JWT_SECRET = 'netplay-adult-access-test-secret-2026'
process.env.NETPLAY_MAX_ROOMS_PER_IP = '20'
const { attachNetplay, netplayAdultRooms } = await import('../src/netplay.js')
const { signToken } = await import('../src/auth.js')

let pass = 0
let fail = 0
const ok = (c, m) => { c ? (pass++, console.log('✅ ' + m)) : (fail++, console.log('❌ ' + m)) }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const policy = ({ gameId, gameSlug, requestedMax } = {}) => ({
  gameSlug: gameSlug || 'test-game',
  gameId: gameId ?? null,
  maxPlayers: Math.max(2, normalizeGamePlayers(requestedMax)),
  adult: gameSlug === 'adult-game',
})
const users = {
  u_adult: { id: 'u_adult', status: 'active', birth_date: '1990-01-01', token_version: 0 },
  u_child: { id: 'u_child', status: 'active', birth_date: new Date().getFullYear() - 10 + '-01-01', token_version: 0 },
  u_nobirth: { id: 'u_nobirth', status: 'active', birth_date: null, token_version: 0 },
  u_rotated: { id: 'u_rotated', status: 'active', birth_date: '1990-01-01', token_version: 3 },
}
const findUser = async (_sql, [id]) => users[id] ?? null

const app = express()
const httpServer = createServer(app)
attachNetplay(httpServer, app, ['*'], { resolveGamePolicy: policy, findUser })
await new Promise((r) => httpServer.listen(0, '127.0.0.1', r))
const base = `http://127.0.0.1:${httpServer.address().port}`

const connect = (token) => {
  const s = ioc(`${base}/netplay`, { transports: ['websocket'], forceNew: true, ...(token ? { auth: { token } } : {}) })
  return new Promise((res) => s.on('connect', () => res(s)))
}
const extra = (sessionid, userid, slug = 'adult-game') => ({
  sessionid, userid, game_id: 7, game_slug: slug, domain: 'test', room_name: 'R', player_name: userid,
})
const emit = (s, ev, payload) => new Promise((r) => s.emit(ev, payload, (e) => r(e)))

console.log('── 开房 ──')
const anonHost = await connect()
ok((await emit(anonHost, 'open-room', { extra: extra('a-anon', 'h0'), maxPlayers: 2 })) === 'adult login required', '未登录不能开成人房')
const childHost = await connect(signToken('u_child', 0))
ok((await emit(childHost, 'open-room', { extra: extra('a-child', 'h1'), maxPlayers: 2 })) === 'adult age restricted', '未满 18 岁不能开成人房')
const host = await connect(signToken('u_adult', 0))
ok((await emit(host, 'open-room', { extra: extra('a-room', 'h2'), maxPlayers: 4 })) === null, '通过年龄门的登录用户能开成人房')
const normalHost = await connect()
ok((await emit(normalHost, 'open-room', { extra: extra('n-room', 'h3', 'normal-game'), maxPlayers: 2 })) === null, '普通游戏匿名照常开房')
await sleep(150)

console.log('\n── 列表与详情（匿名） ──')
const list = await (await fetch(`${base}/api/netplay/rooms`)).json()
ok(list.some((r) => r.roomId === 'n-room') && !list.some((r) => r.roomId === 'a-room'), '/api/netplay/rooms 匿名不含成人房')
ok(!JSON.stringify(list).includes('adult'), '列表输出不带 adult 权限位')
ok((await fetch(`${base}/api/netplay/rooms/a-room`)).status === 404, '单个成人房对匿名回 404（不暴露存在）')
const anonAdultOnly = await (await fetch(`${base}/api/netplay/rooms?scope=adult`)).json()
ok(Array.isArray(anonAdultOnly) && anonAdultOnly.length === 0, '?scope=adult 匿名回空数组')
const childAdultOnly = await (await fetch(`${base}/api/netplay/rooms?scope=adult`, { headers: { Authorization: `Bearer ${signToken('u_child', 0)}` } })).json()
ok(Array.isArray(childAdultOnly) && childAdultOnly.length === 0, '?scope=adult 未满 18 岁回空数组')
const adultOnly = netplayAdultRooms()
ok(adultOnly.some((r) => r.roomId === 'a-room') && !adultOnly.some((r) => r.roomId === 'n-room'), 'netplayAdultRooms 只含成人房（?scope=adult 过了年龄门才返回它）')
const engineList = await (await fetch(`${base}/netplay/list?game_id=7`)).json()
ok(engineList['n-room'] && !engineList['a-room'], '/netplay/list 不列成人房')

const sse = await new Promise((resolve) => {
  const ac = new AbortController()
  let buf = ''
  fetch(`${base}/api/netplay/events?watch=a-room`, { signal: ac.signal, headers: { 'user-agent': 'Mozilla/5.0 Chrome/120' } })
    .then(async (res) => {
      const reader = res.body.getReader()
      const timer = setTimeout(() => { ac.abort(); resolve(buf) }, 600)
      try {
        for (;;) {
          const { value, done } = await reader.read()
          if (done) break
          buf += new TextDecoder().decode(value)
        }
      } catch { /* aborted */ }
      clearTimeout(timer)
      resolve(buf)
    })
    .catch(() => resolve(buf))
})
const roomsFrame = /event: rooms\ndata: (.*)\n/.exec(sse)?.[1] ?? 'null'
const sseRooms = JSON.parse(roomsFrame) ?? []
ok(sseRooms.some((r) => r.roomId === 'n-room') && !sseRooms.some((r) => r.roomId === 'a-room'), 'SSE 房间列表不含成人房')
ok(/event: room-restricted/.test(sse) && !/event: room-gone/.test(sse), '订阅成人房详情：发 room-restricted，不发 gone、不发详情')

console.log('\n── 进房（玩家 / 观众） ──')
const anon = await connect()
ok((await emit(anon, 'join-room', { extra: extra('a-room', 'g0') })) === 'adult login required', '未登录不能进成人房')
const anonSpec = await connect()
ok((await emit(anonSpec, 'join-room', { extra: { ...extra('a-room', 'g1'), role: 'spectator' } })) === 'adult login required', '未登录也不能以观众身份进')
const noBirth = await connect(signToken('u_nobirth', 0))
ok((await emit(noBirth, 'join-room', { extra: extra('a-room', 'g2') })) === 'adult birth date required', '没填生日不能进')
const child = await connect(signToken('u_child', 0))
ok((await emit(child, 'join-room', { extra: extra('a-room', 'g3') })) === 'adult age restricted', '未满 18 岁不能进')
const rotated = await connect(signToken('u_rotated', 0))
ok((await emit(rotated, 'join-room', { extra: extra('a-room', 'g4') })) === 'adult login required', '已作废的旧令牌（token_version 对不上）不能进')
const viaExtra = await connect()
ok((await emit(viaExtra, 'join-room', { extra: { ...extra('a-room', 'g5'), auth_token: signToken('u_adult', 0) } })) === null, 'extra.auth_token 带合格令牌能进')
const adultGuest = await connect(signToken('u_adult', 0))
ok((await emit(adultGuest, 'join-room', { extra: { ...extra('a-room', 'g6'), role: 'spectator' } })) === null, '握手 auth.token 合格的观众能进')
const normalGuest = await connect()
ok((await emit(normalGuest, 'join-room', { extra: extra('n-room', 'g7', 'normal-game') })) === null, '普通房匿名照常能进')

for (const s of [anonHost, childHost, host, normalHost, anon, anonSpec, noBirth, child, rotated, viaExtra, adultGuest, normalGuest]) s.close()
httpServer.close()
console.log(`\n${fail ? '有失败 ❌' : '全部通过 ✅'}  通过 ${pass}，失败 ${fail}`)
process.exit(fail ? 1 : 0)
