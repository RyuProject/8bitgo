/**
 * 「房主掉线，游戏不能结束」这条主线的测试。
 *
 *   node server/scripts/test-host-failover.mjs
 *
 * 覆盖三种情况：
 *   A. 第一顺位接班人没反应 → 自动顺延给下一位（以前会白白等死）
 *   B. 玩家优先于观众接手
 *   C. 所有人都不接 → 到宽限期才解散
 */
import express from 'express'
import { createServer } from 'node:http'
import { io as client } from 'socket.io-client'

process.env.NETPLAY_HOST_GRACE_MS = '3000'
process.env.NETPLAY_CLAIM_MS = '700'
const { attachNetplay } = await import('../src/netplay.js')

let failed = 0
const wait = (ms) => new Promise((r) => setTimeout(r, ms))
const ok = (n, c) => { if (!c) failed++; console.log(`${c ? '✅' : '❌'} ${n}`) }

const app = express()
const http = createServer(app)
attachNetplay(http, app, ['*'])
await new Promise((r) => http.listen(9931, r))
const API = 'http://127.0.0.1:9931'
const connect = async () => { const s = client(`${API}/netplay`); await new Promise((r) => s.on('connect', r)); return s }
const extra = (userid, sessionid, name) => ({ domain: 'localhost', game_id: 7, room_name: 'T', player_name: name, userid, sessionid })
const open = (s, e, max = 4) => new Promise((r) => s.emit('open-room', { extra: e, maxPlayers: max, password: '' }, r))
const join = (s, e) => new Promise((r) => s.emit('join-room', { extra: e, password: '' }, (err, u) => r([err, u])))
const room = async (id) => { const r = await fetch(`${API}/api/netplay/rooms/${id}`); return r.ok ? r.json() : null }

console.log('── A. 第一顺位不接手，自动换下一位 ──')
{
  const host = await connect(), a = await connect(), b = await connect()
  await open(host, extra('u-h', 'F1', '房主'))
  await join(a, extra('u-a', 'F1', 'A'))
  await join(b, extra('u-b', 'F1', 'B'))

  const offers = []
  b.on('data-message', (m) => { if (m['host-migrating']) offers.push(m['host-migrating'].nextHost) })

  host.close()
  await wait(250)
  ok('先问第一顺位 A', offers[0] === 'u-a')
  ok('房间没解散', (await room('F1'))?.awaitingHost === true)

  // A 装作没反应（不调 migrate），等超时
  await wait(900)
  ok('A 超时后自动改问 B', offers.includes('u-b'))
  ok('这期间房间一直活着', (await room('F1')) !== null)

  // B 接手
  const nb = await connect()
  await open(nb, extra('u-b', 'F1b', 'B'))
  const r = await fetch(`${API}/api/netplay/rooms/F1/migrate`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ newRoomId: 'F1b', userId: 'u-b' }),
  })
  ok('B 接手成功，这局继续', r.ok)
  ok('老邀请链接跟到新房间', (await room('F1'))?.migratedTo === 'F1b')

  a.close(); b.close(); nb.close(); await wait(200)
}

console.log('\n── B. 玩家优先于观众 ──')
{
  const host = await connect(), p1 = await connect(), sp = await connect()
  await open(host, extra('u-h2', 'F2', '房主'), 2)   // 2 个手柄位
  await join(sp, extra('u-sp', 'F2', '围观'))         // 第 2 位 → 玩家
  const [, u3] = await join(p1, extra('u-p1', 'F2', '第三人')) // 位满 → 观众
  ok('第三人进来是观众', u3?.['u-p1']?.role === 'spectator')

  const seen = []
  sp.on('data-message', (m) => { if (m['host-migrating']) seen.push(m['host-migrating'].nextHost) })
  host.close()
  await wait(250)
  ok('先问玩家（u-sp）而不是观众', seen[0] === 'u-sp')
  p1.close(); sp.close(); await wait(200)
}

console.log('\n── C. 都不接 → 到宽限期才解散 ──')
{
  const host = await connect(), a = await connect()
  await open(host, extra('u-h3', 'F3', '房主'))
  await join(a, extra('u-a3', 'F3', 'A'))
  let hostLeft = false
  a.on('data-message', (m) => { if (m['host-left']) hostLeft = true })
  host.close()
  await wait(1500)
  ok('宽限期内房间还在（没有一超时就散）', (await room('F3')) !== null)
  await wait(2200)
  ok('超过宽限期才广播 host-left', hostLeft)
  ok('房间解散', (await room('F3')) === null)
  a.close()
}

console.log(failed ? `\n有 ${failed} 项失败 ❌` : '\n全部通过 ✅')
process.exit(failed ? 1 : 0)
