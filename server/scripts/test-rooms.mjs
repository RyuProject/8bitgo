/**
 * cloud-game 房间注册表（/api/rooms）的鉴权测试。
 *
 * 这套接口目前**没上线**（VITE_CLOUDGAME_URL 在两个 .env 里都是注释掉的，
 * 前端根本不发心跳），但它是公开挂在 /api 上的，所以该有的边界得先立好。
 * 用法：cd server && npm run test:rooms
 */
import { createServer } from 'node:http'
import express from 'express'
import { roomsRouter } from '../src/routes/rooms.js'

let pass = 0, fail = 0
const ok = (c, m) => { c ? (pass++, console.log('✅ ' + m)) : (fail++, console.log('❌ ' + m)) }

const app = express()
app.use(express.json())
app.use('/api/rooms', roomsRouter)
const httpServer = createServer(app)
await new Promise((r) => httpServer.listen(0, r))
const base = `http://127.0.0.1:${httpServer.address().port}`

const beat = (body) =>
  fetch(`${base}/api/rooms/heartbeat`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  })
const leave = (roomId, memberId, token) =>
  fetch(`${base}/api/rooms/${roomId}/members/${memberId}`, {
    method: 'DELETE', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token }),
  })
const room = async (id) => { const r = await fetch(`${base}/api/rooms/${id}`); return r.ok ? r.json() : null }

console.log('── 成员令牌 ──')
const r1 = await (await beat({ roomId: 'c1', gameSlug: 'sf2', memberId: 'm-host', nickname: '房主', playerIndex: 0, host: true })).json()
ok(typeof r1.memberToken === 'string' && r1.memberToken.length > 20, '第一次心跳拿到成员令牌')
ok(r1.members[0]?.host === true, '开房的人是 host')

const list = await (await fetch(`${base}/api/rooms`)).json()
ok(!JSON.stringify(list).includes(r1.memberToken), '列表接口不含任何人的令牌')

console.log('\n── 不能冒用别人的 memberId ──')
// roomId 在列表里是公开的，memberId 只要泄露一次就够
const hijack = await beat({ roomId: 'c1', gameSlug: 'sf2', memberId: 'm-host', nickname: '我是房主', playerIndex: 0 })
ok(hijack.status === 403, '不带令牌顶替已有成员被拒')
const hijack2 = await beat({ roomId: 'c1', gameSlug: 'sf2', memberId: 'm-host', nickname: '我是房主', playerIndex: 0, token: 'wrong' })
ok(hijack2.status === 403, '拿错令牌顶替被拒')
ok((await room('c1')).members[0]?.nickname === '房主', '昵称没有被改掉')

const renew = await (await beat({ roomId: 'c1', gameSlug: 'sf2', memberId: 'm-host', nickname: '房主', playerIndex: 0, token: r1.memberToken })).json()
ok(renew.roomId === 'c1', '带对令牌能继续心跳')

console.log('\n── 后来者抢不到 host ──')
const r2 = await (await beat({ roomId: 'c1', gameSlug: 'sf2', memberId: 'm-2', nickname: '第二人', playerIndex: 1, host: true })).json()
ok(r2.members.filter((m) => m.host).length === 1 && r2.members.find((m) => m.host).nickname === '房主', '自称 host 的后来者不算 host')

console.log('\n── 离开房间要带令牌 ──')
const noTok = await leave('c1', 'm-host', '')
ok(noTok.status === 403, '不带令牌踢人被拒')
ok((await room('c1')).members.length === 2, '人还在房间里')
const bad = await leave('c1', 'm-host', 'wrong')
ok(bad.status === 403, '拿错令牌踢人被拒')
const mine = await leave('c1', 'm-host', r1.memberToken)
ok(mine.ok, '带对令牌能让自己离开')
ok((await room('c1')).members.length === 1, '离开后列表里少一个人')
ok((await leave('c1', 'm-host', r1.memberToken)).ok, '重复离开不报错')

console.log('\n── 房间成员数上限 ──')
let full = null
for (let i = 0; i < 12; i++) {
  const res = await beat({ roomId: 'c1', gameSlug: 'sf2', memberId: `m-f${i}`, nickname: `f${i}`, playerIndex: 0 })
  if (!res.ok) { full = res.status; break }
}
ok(full === 409, '塞满之后新成员被拒（挡住往别人房间里灌人）')

console.log(`\n${fail ? '❌' : '全部通过 ✅'}  通过 ${pass}，失败 ${fail}`)
httpServer.close()
process.exit(fail ? 1 : 0)
