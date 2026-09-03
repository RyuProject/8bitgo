/**
 * 房主名片（设备 / 地区 / 网络）的回归测试。不需要浏览器、不需要数据库。
 *
 *   cd server && npm run test:presence
 *
 * 分两半：
 *   1. 纯函数 —— UA 判设备、X-Forwarded-For 挖真实 IP、IP 查国家、RTT 分档
 *   2. 端到端 —— 起真的 socket.io，看直播 / 联机房间的输出里名片对不对，
 *      并且**确认 presence 没有跟着 users-updated 广播出去**（它是个函数，
 *      漏出去会变成一个空对象白占带宽，见 netplay.js 的 strip）
 *
 * 端到端那半把 SOCKET_PING_INTERVAL_MS 调到 150ms，好在一秒内量到 RTT；
 * 线上是 10 秒。
 */
process.env.SOCKET_PING_INTERVAL_MS = '150'

import express from 'express'
import { createServer } from 'node:http'
import { io as client } from 'socket.io-client'
import { Server } from 'socket.io'
import { attachLive, liveRooms } from '../src/live.js'
import { attachNetplay } from '../src/netplay.js'
import { deviceFromUa, clientIpFrom, countryFromIp, netFromRtt, presenceFromRequest } from '../src/presence.js'

let failed = 0
const ok = (name, cond, extra = '') => {
  if (!cond) failed++
  console.log(`${cond ? '✅' : '❌'} ${name}${extra ? ` — ${extra}` : ''}`)
}
const section = (t) => console.log(`\n── ${t} ──`)
const wait = (ms) => new Promise((r) => setTimeout(r, ms))

/* ─────────── 1. 设备 ─────────── */
section('设备')
const UA_IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1'
const UA_ANDROID = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36'
const UA_PAD = 'Mozilla/5.0 (Linux; Android 13; SM-X700) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'
const UA_WIN = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'
const UA_MAC = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15'
ok('iPhone 是手机', deviceFromUa(UA_IPHONE) === 'mobile')
ok('安卓手机是手机', deviceFromUa(UA_ANDROID) === 'mobile')
ok('安卓平板按手机算', deviceFromUa(UA_PAD) === 'mobile')
ok('Windows 是电脑', deviceFromUa(UA_WIN) === 'desktop')
ok('Mac 是电脑', deviceFromUa(UA_MAC) === 'desktop')
ok('没有 UA 就是未知', deviceFromUa('') === 'unknown' && deviceFromUa(undefined) === 'unknown')

/* ─────────── 2. 真实 IP ─────────── */
section('真实 IP')
ok(
  '反代后取 XFF 最后一段（前面几段是客户端伪造的）',
  clientIpFrom('::ffff:127.0.0.1', { 'x-forwarded-for': '1.1.1.1, 203.0.113.9, 114.114.114.114' }) === '114.114.114.114',
)
ok('直连公网时不信 XFF', clientIpFrom('114.114.114.114', { 'x-forwarded-for': '1.1.1.1' }) === '114.114.114.114')
ok('没有 XFF 时退回 X-Real-IP', clientIpFrom('::1', { 'x-real-ip': '8.8.8.8' }) === '8.8.8.8')
ok('v4-mapped 前缀被削掉', clientIpFrom('::ffff:203.0.113.7', {}) === '203.0.113.7')
ok('方括号 + 端口', clientIpFrom('[::1]:443', { 'x-forwarded-for': '2408:8000::1' }) === '2408:8000::1')
ok('v4 带端口', clientIpFrom('1.2.3.4:5678', {}) === '1.2.3.4')
ok('纯 v6 不能被当成带端口切开', clientIpFrom('2001:4860:4860::8888', {}) === '2001:4860:4860::8888')
ok('XFF 全是内网时退回直连地址', clientIpFrom('127.0.0.1', { 'x-forwarded-for': '10.0.0.5, 192.168.1.2' }) === '127.0.0.1')

/* ─────────── 3. 国家 ─────────── */
section('国家')
ok('114.114.114.114 -> CN', countryFromIp('114.114.114.114') === 'CN', String(countryFromIp('114.114.114.114')))
ok('8.8.8.8 -> US', countryFromIp('8.8.8.8') === 'US', String(countryFromIp('8.8.8.8')))
ok('133.242.0.1 -> JP', countryFromIp('133.242.0.1') === 'JP', String(countryFromIp('133.242.0.1')))
ok('IPv6 也能查（2408:8000:: -> CN）', countryFromIp('2408:8000::1') === 'CN', String(countryFromIp('2408:8000::1')))
ok('内网地址查不出来', countryFromIp('192.168.1.5') === null && countryFromIp('127.0.0.1') === null)
ok('乱七八糟的输入不抛异常', countryFromIp('不是个 IP') === null && countryFromIp('') === null)

/* ─────────── 4. 网络分档 ─────────── */
section('网络分档')
ok('30ms 是好', netFromRtt(30) === 'good')
ok('边界 120ms 还算好', netFromRtt(120) === 'good')
ok('121ms 掉到中', netFromRtt(121) === 'fair')
ok('300ms 还是中', netFromRtt(300) === 'fair')
ok('301ms 是差', netFromRtt(301) === 'poor')
ok('没量到就是未知', netFromRtt(null) === 'unknown' && netFromRtt(undefined) === 'unknown' && netFromRtt(NaN) === 'unknown')

/* ─────────── 5. 云端房间：客户端报的 RTT 要钳住 ─────────── */
section('云端房间（HTTP 心跳）')
const fakeReq = (rtt) => ({ headers: { 'user-agent': UA_IPHONE, 'x-forwarded-for': '114.114.114.114' }, ip: '114.114.114.114', socket: {} })
ok('设备和国家由服务端看，不听客户端的', (() => {
  const p = presenceFromRequest(fakeReq(), 42)
  return p.device === 'mobile' && p.country === 'CN' && p.net === 'good' && p.rtt === 42
})())
ok('负数 RTT 被丢掉', presenceFromRequest(fakeReq(), -5).rtt === null)
ok('离谱的大 RTT 被丢掉', presenceFromRequest(fakeReq(), 999999).rtt === null)
ok('非数字被丢掉', presenceFromRequest(fakeReq(), 'fast').rtt === null)
ok('不报也不炸', presenceFromRequest(fakeReq(), undefined).net === 'unknown')

/* ─────────── 6. 直播房间端到端 ─────────── */
section('直播房间')
const liveHttp = createServer()
const liveIo = new Server(liveHttp, { cors: { origin: true }, pingInterval: 150 })
attachLive(liveIo)
await new Promise((r) => liveHttp.listen(0, r))
const liveUrl = `http://127.0.0.1:${liveHttp.address().port}/live`

const host = client(liveUrl, {
  transports: ['polling'], // extraHeaders 在 Node 里只有 polling 一定带得上
  forceNew: true,
  extraHeaders: { 'user-agent': UA_IPHONE, 'x-forwarded-for': '133.242.0.1' },
})
await new Promise((r) => host.on('connect', r))
await new Promise((res) => host.emit('go-live', { gameSlug: 'zelda-gba', gameName: 'Zelda', hostName: 'Ryu' }, () => res()))

const room0 = liveRooms({ gameSlug: 'zelda-gba' })[0]
ok('直播房间带名片', Boolean(room0?.presence), JSON.stringify(room0?.presence))
ok('设备来自 UA', room0.presence.device === 'mobile')
ok('国家来自 XFF（133.242.0.1 是日本）', room0.presence.country === 'JP', String(room0.presence.country))
ok('刚开播还没量到延迟，是未知', room0.presence.net === 'unknown' && room0.presence.rtt === null)

// 等两三个心跳，RTT 应该出来了
await wait(600)
const room1 = liveRooms({ gameSlug: 'zelda-gba' })[0]
ok('几个心跳之后量到了 RTT', typeof room1.presence.rtt === 'number', `${room1.presence.rtt}ms`)
ok('本机回环的 RTT 应该判成好', room1.presence.net === 'good', room1.presence.net)
host.close()
liveHttp.close()

/* ─────────── 7. 联机房间端到端 ─────────── */
section('联机房间')
const app = express()
const npHttp = createServer(app)
attachNetplay(npHttp, app, ['*'])
await new Promise((r) => npHttp.listen(0, r))
const port = npHttp.address().port
const npUrl = `http://127.0.0.1:${port}/netplay`

const conn = async (headers) => {
  const s = client(npUrl, { transports: ['polling'], forceNew: true, extraHeaders: headers })
  await new Promise((r) => s.on('connect', r))
  return s
}
const extra = (sessionid, userid, name) => ({
  sessionid,
  userid,
  player_name: name,
  game_id: 4242,
  domain: 'test',
  room_name: 'Test Room',
})

const owner = await conn({ 'user-agent': UA_WIN, 'x-forwarded-for': '114.114.114.114' })
await new Promise((r) => owner.emit('open-room', { extra: extra('presence-room', 'u-owner', 'Owner'), maxPlayers: 2 }, r))
const guest = await conn({ 'user-agent': UA_ANDROID, 'x-forwarded-for': '8.8.8.8' })
// 顺手验一下「客户端自己在 extra 里塞 presence」没用
const guestExtra = { ...extra('presence-room', 'u-guest', 'Guest'), presence: { device: 'desktop', country: 'FR', net: 'good', rtt: 1 } }
await new Promise((r) => guest.emit('join-room', { extra: guestExtra }, r))

const listRes = await fetch(`http://127.0.0.1:${port}/api/netplay/rooms`)
const list = await listRes.json()
const room = list.find((r) => r.roomId === 'presence-room')
ok('联机房间带房主名片', Boolean(room?.presence), JSON.stringify(room?.presence))
ok('房主设备来自 UA', room.presence.device === 'desktop')
ok('房主国家 CN', room.presence.country === 'CN', String(room.presence.country))
const guestRow = room.members.find((m) => m.nickname === 'Guest')
ok('每个成员都有自己的名片', Boolean(guestRow?.presence), JSON.stringify(guestRow?.presence))
ok('访客设备是手机', guestRow.presence.device === 'mobile')
ok('访客国家 US（extra 里自称的 FR 不算数）', guestRow.presence.country === 'US', String(guestRow.presence.country))

// users-updated 广播里不能有 presence（它是个函数，序列化出去是个空对象）
const broadcast = await new Promise((res) => {
  const third = client(npUrl, { transports: ['polling'], forceNew: true })
  third.on('connect', () => {
    third.once('users-updated', (users) => {
      third.close()
      res(users)
    })
    third.emit('join-room', { extra: extra('presence-room', 'u-third', 'Third') }, () => {})
  })
})
ok(
  'presence 没有跟着 users-updated 广播出去',
  Object.values(broadcast).every((u) => !('presence' in u)),
  JSON.stringify(Object.values(broadcast)[0] ?? {}),
)
ok('令牌也还是没有广播出去', Object.values(broadcast).every((u) => !('token' in u)))

owner.close()
guest.close()
npHttp.close()

console.log(failed ? `\n❌ 有 ${failed} 项没过` : '\n全部通过 ✅')
process.exit(failed ? 1 : 0)
