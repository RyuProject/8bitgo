#!/usr/bin/env node
/** 联机玩家弹幕：验证纯联机房与同步直播的收发、身份闸和观众人数。 */
import assert from 'node:assert/strict'
import express from 'express'
import { createServer } from 'node:http'
import { io as client } from 'socket.io-client'

process.env.NETPLAY_MAX_ROOMS_PER_IP = '0'
process.env.NETPLAY_MAX_MEMBERS_PER_IP = '0'
const { attachNetplay } = await import('../src/netplay.js')
const { attachLive, liveRoom } = await import('../src/live.js')

const app = express()
const http = createServer(app)
const io = attachNetplay(http, app, ['*'])
attachLive(io)
await new Promise((resolve) => http.listen(0, '127.0.0.1', resolve))
const base = `http://127.0.0.1:${http.address().port}`
const sockets = []
const wait = (ms = 40) => new Promise((resolve) => setTimeout(resolve, ms))
const connect = async (space) => {
  const socket = client(`${base}/${space}`, { transports: ['websocket'], forceNew: true })
  sockets.push(socket)
  await new Promise((resolve, reject) => {
    socket.once('connect', resolve)
    socket.once('connect_error', reject)
  })
  return socket
}
const call = (socket, event, payload) => new Promise((resolve) => {
  socket.emit(event, payload, (err, data) => resolve({ err, data }))
})
const next = (socket, event) => new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error(`${event} 超时`)), 1500)
  socket.once(event, (data) => { clearTimeout(timer); resolve(data) })
})
const extra = (id, roomId) => ({ domain: 'localhost', game_id: 42, room_name: '测试', player_name: id, userid: id, sessionid: roomId })
const netplay = async (roomId) => {
  const host = await connect('netplay')
  const hostToken = next(host, 'room-token')
  assert.equal((await call(host, 'open-room', { extra: extra(`host-${roomId}`, roomId), maxPlayers: 2 })).err, null)
  const guest = await connect('netplay')
  const guestToken = next(guest, 'room-token')
  assert.equal((await call(guest, 'join-room', { extra: extra(`guest-${roomId}`, roomId) })).err, null)
  return { host, guest, hostToken: (await hostToken).token, guestToken: (await guestToken).token }
}

try {
  const plain = await netplay('plain')
  const hostChat = await connect('live')
  const guestChat = await connect('live')
  assert.equal((await call(hostChat, 'join-match-chat', { netplayRoomId: 'plain', token: plain.hostToken })).err, null)
  assert.equal((await call(guestChat, 'join-match-chat', { netplayRoomId: 'plain', token: plain.guestToken })).err, null)
  const plainReceived = next(guestChat, 'chat')
  assert.equal((await call(hostChat, 'chat', { text: '纯联机也能聊' })).err, null)
  assert.equal((await plainReceived).text, '纯联机也能聊')
  const lateChat = await connect('live')
  const lateJoined = await call(lateChat, 'join-match-chat', {
    netplayRoomId: 'plain', token: plain.guestToken,
  })
  assert.equal(lateJoined.data.chat[0].text, '纯联机也能聊', '后进来的玩家要拿到本局弹幕记录')
  assert.equal((await call(guestChat, 'join-match-chat', { netplayRoomId: 'plain', token: 'bad' })).err, 'not a player')

  const paired = await netplay('paired')
  const broadcaster = await connect('live')
  const live = await call(broadcaster, 'go-live', { gameSlug: 'test', gameName: '测试', hostName: '主播' })
  assert.equal(live.err, null)
  broadcaster.emit('link-netplay', { roomId: 'paired' })
  await wait()
  const viewer = await connect('live')
  assert.equal((await call(viewer, 'watch', { roomId: live.data.roomId })).err, null)
  const playerChat = await connect('live')
  const joined = await call(playerChat, 'join-match-chat', { netplayRoomId: 'paired', token: paired.guestToken })
  assert.equal(joined.err, null)
  assert.equal(joined.data.live, true)
  assert.equal(liveRoom(live.data.roomId).viewers, 1, '联机玩家不能占观众人数')
  const hostReceived = next(broadcaster, 'chat')
  const viewerReceived = next(viewer, 'chat')
  const playerReceived = next(playerChat, 'chat')
  assert.equal((await call(playerChat, 'chat', { text: '给直播间发弹幕' })).err, null)
  assert.equal((await hostReceived).text, '给直播间发弹幕')
  assert.equal((await viewerReceived).text, '给直播间发弹幕')
  assert.equal((await playerReceived).text, '给直播间发弹幕')
  const back = next(playerChat, 'chat')
  assert.equal((await call(viewer, 'chat', { text: '观众回复' })).err, null)
  assert.equal((await back).text, '观众回复')
  let forgedSignal = false
  broadcaster.once('signal', () => { forgedSignal = true })
  playerChat.emit('signal', { target: broadcaster.id, data: { sdp: '假信令' } })
  await wait()
  assert.equal(forgedSignal, false, '只进弹幕的玩家不能走视频信令')

  const moved = next(playerChat, 'match-chat-moved')
  broadcaster.emit('link-netplay', { roomId: '' })
  await moved
  assert.equal((await call(playerChat, 'join-match-chat', {
    netplayRoomId: 'paired', token: paired.guestToken,
  })).data.live, false, '解除配对后要退回纯联机弹幕房')
  const pairedHostChat = await connect('live')
  assert.equal((await call(pairedHostChat, 'join-match-chat', {
    netplayRoomId: 'paired', token: paired.hostToken,
  })).err, null)
  const afterMove = next(pairedHostChat, 'chat')
  assert.equal((await call(playerChat, 'chat', { text: '联机继续聊' })).err, null)
  assert.equal((await afterMove).text, '联机继续聊')

  const spectator = await connect('netplay')
  const spectatorToken = next(spectator, 'room-token')
  assert.equal((await call(spectator, 'join-room', { extra: extra('spectator-paired', 'paired') })).err, null)
  assert.equal((await call(await connect('live'), 'join-match-chat', {
    netplayRoomId: 'paired', token: (await spectatorToken).token,
  })).err, 'not a player', '联机观众仍走原来的观看通道')
  console.log('联机玩家弹幕：纯联机、直播共流、切换、身份验证和人数均通过 ✅')
} finally {
  for (const socket of sockets) socket.close()
  await new Promise((resolve) => io.close(resolve))
  await new Promise((resolve) => http.close(resolve))
}
