#!/usr/bin/env node

import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { buildSync } from 'esbuild'

const temp = mkdtempSync(join(tmpdir(), '8bitgo-cs16-net-'))
const outfile = join(temp, 'cs16-net.mjs')
try {
  // 引擎发布物里仍有无扩展名的目录导入，和浏览器正式产物一样先经 esbuild 才能在 Node 验证。
  buildSync({
    entryPoints: [join(process.cwd(), 'public/web/cs16/cs16-net.js')],
    outfile,
    bundle: true,
    format: 'esm',
    platform: 'node',
    target: 'node22',
    logLevel: 'silent',
  })
  const { createCs16RelayNet, createCs16RoomNet, roomConnectTimeoutMs, validRoomDescriptor } = await import(pathToFileURL(outfile).href)

  class MockWebSocket {
    static CONNECTING = 0
    static OPEN = 1
    static CLOSED = 3
    static last = null

    constructor(url) {
      this.url = url
      this.readyState = MockWebSocket.CONNECTING
      this.bufferedAmount = 0
      this.listeners = new Map()
      this.sent = []
      MockWebSocket.last = this
    }

    addEventListener(type, listener) {
      const list = this.listeners.get(type) || []
      list.push(listener)
      this.listeners.set(type, list)
    }

    emit(type, event = {}) {
      for (const listener of this.listeners.get(type) || []) listener(event)
    }

    send(data) { this.sent.push(new Uint8Array(data)) }

    close(code = 1000, reason = '') {
      this.readyState = MockWebSocket.CLOSED
      this.emit('close', { code, reason })
    }
  }

  let disconnected = ''
  const relay = createCs16RelayNet(
    { id: 'arena', name: 'Arena', netId: 0x1234, port: 27015 },
    {
      WebSocketImpl: MockWebSocket,
      locationObject: { origin: 'https://8bitgo.com' },
      onDisconnect: (message) => { disconnected = message },
    },
  )
  const connecting = relay.connect()
  const ws = MockWebSocket.last
  assert.equal(ws.url, 'wss://8bitgo.com/api/cs16/relay?server=arena')
  ws.readyState = MockWebSocket.OPEN
  ws.emit('message', { data: JSON.stringify({ type: 'ready', server: 'arena' }) })
  await connecting

  const HEAPU8 = new Uint8Array(256)
  const errnoWrites = []
  const em = {
    HEAPU8,
    HEAP8: new Int8Array(HEAPU8.buffer),
    HEAP16: new Int16Array(HEAPU8.buffer),
    HEAP32: new Int32Array(HEAPU8.buffer),
    Module: { ccall: () => 200 },
    setValue: (ptr, value, type) => errnoWrites.push({ ptr, value, type }),
  }
  relay.net.init(em)
  const sockaddr = 16
  HEAPU8[sockaddr + 2] = 0x69
  HEAPU8[sockaddr + 3] = 0x87 // 27015
  HEAPU8.set(relay.virtualIp, sockaddr + 4)
  HEAPU8.set([0xde, 0xad, 0xbe, 0xef], 64)
  assert.equal(relay.net.sendto(1000, 64, 4, 0, sockaddr, 16), 4)
  assert.deepEqual(ws.sent[0], new Uint8Array([0xde, 0xad, 0xbe, 0xef]))
  // WASM 原缓冲随后变化也不能污染已经交给 WebSocket 的数据。
  HEAPU8.fill(0, 64, 68)
  assert.deepEqual(ws.sent[0], new Uint8Array([0xde, 0xad, 0xbe, 0xef]))

  ws.emit('message', { data: new Uint8Array([1, 2, 3]).buffer })
  assert.equal(relay.net.recvfrom(1000, 96, 16, 0, 112, 144), 3)
  assert.deepEqual(HEAPU8.slice(96, 99), new Uint8Array([1, 2, 3]))
  assert.deepEqual(HEAPU8.slice(116, 120), new Uint8Array([101, 101, 0x34, 0x12]))
  assert.equal(relay.net.recvfrom(1000, 96, 16, 0, 112, 144), -1)
  assert.deepEqual(errnoWrites.at(-1), { ptr: 200, value: 73, type: 'i32' }, '空轮询必须写真实 errno 指针，不能写 WASM 地址 0')
  em.Module = {}
  assert.equal(relay.net.recvfrom(1000, 96, 16, 0, 112, 144), -1, '引擎未导出 ccall 时也不能把空轮询变成 TypeError')
  assert.equal(typeof relay.net.sendto_batch, 'function', 'Emscripten 的 snake_case 批量发送导入必须存在')

  relay.close()
  assert.equal(disconnected, '', '页面主动关闭不能误报服务器掉线')

  const room = {
    code: 'ABC234',
    map: 'de_dust2',
    hostToken: 'abcdefghijklmnopqrstuvwx',
    server: { netId: 0xcafe, port: 27015 },
  }
  assert.equal(validRoomDescriptor(room), true)
  assert.equal(roomConnectTimeoutMs({ hostWaitMsRemaining: 15 * 60_000 }, 'guest'), 15 * 60_000 + 15_000)
  assert.equal(roomConnectTimeoutMs({}, 'guest'), 16 * 60_000, '旧后端兼容路径也不能只等房主两分钟')
  assert.equal(roomConnectTimeoutMs(room, 'host'), 15_000, '房主网关握手失败应快速报错')
  const hostRelay = createCs16RoomNet(room, 'host', {
    WebSocketImpl: MockWebSocket,
    locationObject: { origin: 'https://8bitgo.com' },
  })
  const hostConnecting = hostRelay.connect()
  const hostWs = MockWebSocket.last
  assert.equal(hostWs.url, 'wss://8bitgo.com/api/cs16/room?room=ABC234&role=host&token=abcdefghijklmnopqrstuvwx')
  hostWs.readyState = MockWebSocket.OPEN
  hostWs.emit('message', { data: JSON.stringify({ type: 'room-ready', code: room.code, role: 'host' }) })
  await hostConnecting
  hostRelay.net.init(em)

  HEAPU8[sockaddr + 2] = 0x75
  HEAPU8[sockaddr + 3] = 0x36 // 虚拟访客 7 的固定源端口 30006
  HEAPU8.set([101, 102, 7, 0], sockaddr + 4)
  HEAPU8.set([9, 8, 7], 64)
  hostRelay.net.sendto(1000, 64, 3, 0, sockaddr, 16)
  assert.deepEqual(hostWs.sent.at(-1), new Uint8Array([0, 7, 9, 8, 7]), '房主发包必须带目标 peerId')

  hostWs.emit('message', { data: new Uint8Array([0, 7, 6, 5, 4]).buffer })
  assert.equal(hostRelay.net.recvfrom(1000, 96, 16, 0, 112, 144), 3)
  assert.deepEqual(HEAPU8.slice(96, 99), new Uint8Array([6, 5, 4]))
  assert.deepEqual(HEAPU8.slice(116, 120), new Uint8Array([101, 102, 7, 0]))

  const guestRelay = createCs16RoomNet(room, 'guest', {
    WebSocketImpl: MockWebSocket,
    locationObject: { origin: 'https://8bitgo.com' },
  })
  const guestConnecting = guestRelay.connect()
  const guestWs = MockWebSocket.last
  guestWs.readyState = MockWebSocket.OPEN
  guestWs.emit('message', { data: JSON.stringify({ type: 'room-ready', code: room.code, role: 'guest', peerId: 7 }) })
  await guestConnecting
  guestRelay.net.init(em)
  HEAPU8[sockaddr + 2] = 0x69
  HEAPU8[sockaddr + 3] = 0x87
  HEAPU8.set([101, 101, 0xfe, 0xca], sockaddr + 4)
  HEAPU8.set([3, 2, 1], 64)
  guestRelay.net.sendto(1000, 64, 3, 0, sockaddr, 16)
  assert.deepEqual(guestWs.sent.at(-1), new Uint8Array([3, 2, 1]), '访客到房主不需要暴露或携带公网地址')
  guestWs.emit('message', { data: new Uint8Array([4, 5, 6]).buffer })
  assert.equal(guestRelay.net.recvfrom(1000, 96, 16, 0, 112, 144), 3)
  assert.deepEqual(HEAPU8.slice(116, 120), new Uint8Array([101, 101, 0xfe, 0xca]))
  hostRelay.close()
  guestRelay.close()

  console.log('CS16 浏览器网络自测通过：公网中继、房间 peer 路由、虚拟 IP、errno 与 sendto_batch')
} finally {
  rmSync(temp, { recursive: true, force: true })
}
