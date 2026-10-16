#!/usr/bin/env node
/** jsnes 信令服务：来源限制、真实加入、房内信令与清理。 */
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import express from 'express'
import { WebSocket } from 'ws'
import { attachJsnesNetplay } from '../src/jsnes-netplay.js'

const app = express()
const server = createServer(app)
attachJsnesNetplay(server, app, ['https://8bitgo.com'])
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const port = server.address().port
const base = `ws://127.0.0.1:${port}/jsnes-netplay`

const connect = (origin = 'https://8bitgo.com') => new Promise((resolve, reject) => {
  const ws = new WebSocket(base, { origin })
  ws.once('open', () => resolve(ws))
  ws.once('error', reject)
})
const next = (ws) => new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error('message timeout')), 2000)
  ws.once('message', (raw) => {
    clearTimeout(timer)
    resolve(JSON.parse(raw.toString()))
  })
})
const send = (ws, value) => ws.send(JSON.stringify(value))

await assert.rejects(connect('https://evil.example'), /403/)

const host = await connect()
send(host, { type: 'host' })
const opened = await next(host)
assert.equal(opened.type, 'room')
assert.match(opened.roomId, /^[a-f0-9]{6}$/)

const guest = await connect()
const hostNotice = next(host)
const joinedNotice = next(guest)
send(guest, { type: 'join', roomId: opened.roomId.toUpperCase() })
const [peerJoined, joined] = await Promise.all([hostNotice, joinedNotice])
assert.equal(peerJoined.type, 'peer-joined')
assert.equal(joined.type, 'joined')
assert.equal(joined.roomId, opened.roomId)

const relayed = next(guest)
send(host, { type: 'signal', to: joined.you, data: { sdp: { type: 'offer', sdp: 'ok' } } })
assert.deepEqual(await relayed, {
  type: 'signal',
  from: opened.you,
  data: { sdp: { type: 'offer', sdp: 'ok' } },
})

const outsider = await connect()
send(outsider, { type: 'host' })
await next(outsider)
let injected = false
guest.once('message', () => { injected = true })
send(outsider, { type: 'signal', to: joined.you, data: { candidate: { candidate: 'cross-room' } } })
await new Promise((resolve) => setTimeout(resolve, 80))
assert.equal(injected, false)

const list = await fetch(`http://127.0.0.1:${port}/api/jsnes-netplay/rooms`).then((res) => res.json())
assert.equal(list.find((room) => room.roomId === opened.roomId)?.players, 2)

let peerLeftCount = 0
guest.on('message', (raw) => {
  if (JSON.parse(raw.toString()).type === 'peer-left') peerLeftCount++
})
host.close()
await new Promise((resolve) => host.once('close', resolve))
await new Promise((resolve) => setTimeout(resolve, 80))
assert.equal(peerLeftCount, 1, '房主退出只能通知访客一次')
guest.close()
outsider.close()
await Promise.all([
  new Promise((resolve) => guest.once('close', resolve)),
  new Promise((resolve) => outsider.once('close', resolve)),
])
await new Promise((resolve) => setTimeout(resolve, 30))
const after = await fetch(`http://127.0.0.1:${port}/api/jsnes-netplay/rooms`).then((res) => res.json())
assert.equal(after.length, 0)

await new Promise((resolve) => server.close(resolve))
console.log('jsnes 信令自测通过：来源限制、加入、同房转发、跨房拦截与房间回收')
