#!/usr/bin/env node
/**
 * DOS 联机中继（IPX）的准入与连接管理。跑：cd server && npm run test:ipx
 *
 * 这是站上**第三条**长连接端点，而 sseGuard.js 给另外两条补的四道闸这里一道都没有。
 * 2026-09-09 源站猝死就是长连接被挂满堆出来的 —— 同一个形状不能再来一次。
 * 目前 IPX_ENABLED 没开，这些测试是为了「开之前就已经是对的」。
 */
import { readFileSync } from 'node:fs'
import { WebSocket } from 'ws'
import { attachIpx, ipxStats, sendIpxFrame } from '../src/ipx.js'

let pass = 0
let fail = 0
const ok = (c, m) => {
  if (c) {
    pass++
    console.log('\u2705 ' + m)
  } else {
    fail++
    console.log('\u274c ' + m)
  }
}

const wss = attachIpx({ port: 0, host: '127.0.0.1' })
await new Promise((r) => wss.on('listening', r))
const port = wss.address().port

const open = (path) =>
  new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}${path}`)
    ws.on('open', () => resolve({ ws, accepted: true }))
    ws.on('close', () => resolve({ ws, accepted: false }))
    ws.on('error', () => resolve({ ws, accepted: false }))
  })

const nextBinary = (ws) =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('binary message timeout')), 2000)
    ws.once('message', (raw) => {
      clearTimeout(timer)
      resolve(Buffer.from(raw))
    })
  })

const ipxPacket = ({ destHost = 0, destSocket = 0, srcHost = 0, srcPort = 0 } = {}) => {
  const packet = Buffer.alloc(30)
  packet.writeUInt16BE(0xffff, 0)
  packet.writeUInt16BE(packet.length, 2)
  packet.writeUInt32BE(destHost >>> 0, 10)
  packet.writeUInt16BE(destSocket, 16)
  packet.writeUInt32BE(srcHost >>> 0, 22)
  packet.writeUInt16BE(srcPort, 26)
  packet.writeUInt16BE(0x4000, 28)
  return packet
}

/** 连上之后等一下，看服务端有没有随即把它关掉（准入拒绝就是 accept 之后 close） */
const settled = async (path) => {
  const r = await open(path)
  await new Promise((s) => setTimeout(s, 60))
  return r.accepted && r.ws.readyState === WebSocket.OPEN
}

console.log('\u2500\u2500 正常中继还能用（先守住 happy path）\u2500\u2500')
{
  const a = await open('/ipx/room1')
  const b = await open('/ipx/room1')
  ok(a.accepted && b.accepted, '同一个房间能进两个客户端')
  ok(ipxStats().some((r) => r.room === 'room1' && r.players === 2), 'ipxStats 报得出 2 个人')
  a.ws.close()
  b.ws.close()
  await new Promise((s) => setTimeout(s, 60))
  ok(!ipxStats().some((r) => r.room === 'room1'), '人走光之后房间被回收')
}

console.log('\n── 包身份不能冒充 ──')
{
  const a = await open('/ipx/auth-source')
  const b = await open('/ipx/auth-source')
  const registered = nextBinary(a.ws)
  a.ws.send(ipxPacket({ destSocket: 0x2 }))
  const reply = await registered
  const assignedHost = reply.readUInt32BE(10)
  const assignedPort = reply.readUInt16BE(14)

  const forwarded = nextBinary(b.ws)
  a.ws.send(ipxPacket({ destHost: 0xffffffff, srcHost: 0x01020304, srcPort: 0x9999 }))
  const packet = await forwarded
  ok(packet.readUInt32BE(22) === assignedHost && packet.readUInt16BE(26) === assignedPort,
    '⭐ 中继会把伪造的源地址改回这条连接真实分配的地址')

  let gotTruncated = false
  b.ws.once('message', () => { gotTruncated = true })
  const truncated = ipxPacket({ destHost: 0xffffffff })
  truncated.writeUInt16BE(truncated.length + 20, 2)
  a.ws.send(truncated)
  await new Promise((s) => setTimeout(s, 60))
  ok(gotTruncated === false, '⭐ 声明长度超过实包的截断数据不会转发')

  let gotTrailingBytes = false
  b.ws.once('message', () => { gotTrailingBytes = true })
  const trailing = Buffer.concat([ipxPacket({ destHost: 0xffffffff }), Buffer.from([0xde, 0xad])])
  a.ws.send(trailing)
  await new Promise((s) => setTimeout(s, 60))
  ok(gotTrailingBytes === false, '⭐ 声明长度小于 WebSocket 帧的尾随字节不会转发')
  a.ws.close()
  b.ws.close()
  await new Promise((s) => setTimeout(s, 60))
}

console.log('\n\u2500\u2500 \u2b50 准入闸 \u2500\u2500')
{
  ok((await settled('/ipx/' + 'x'.repeat(200))) === false, '\u2b50 房间名超长直接拒（否则 rooms 的 key 可以被撑到任意大）')

  const held = []
  let accepted = 0
  for (let i = 0; i < 12; i++) {
    const r = await open('/ipx/flood')
    await new Promise((s) => setTimeout(s, 20))
    if (r.accepted && r.ws.readyState === WebSocket.OPEN) {
      accepted++
      held.push(r.ws)
    }
  }
  ok(accepted <= 8, `\u2b50 同一个 IP 最多挂 8 条（实际收下 ${accepted} 条）`)
  for (const w of held) w.close()
  await new Promise((s) => setTimeout(s, 80))
}

console.log('\n\u2500\u2500 \u2b50 源码守卫 \u2500\u2500')
{
  const src = readFileSync(new URL('../src/ipx.js', import.meta.url), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')

  ok(/maxPayload: MAX_PAYLOAD/.test(src), '\u2b50 两种挂载方式都设了 maxPayload（ws 默认 100 MiB，而这里收到一帧要广播给全房间）')
  ok((src.match(/maxPayload: MAX_PAYLOAD/g) || []).length === 2, 'noServer 和独立端口两条路都设了')
  ok(/authenticatedPacket\(buf, address\)/.test(src), '转发前用连接身份覆盖 IPX 源地址')
  ok(/originAllowed\(req, allowedOrigins\)/.test(src), '浏览器来源会经过白名单校验')
  ok(
    /if \(clients\.get\(address\) !== ws\) return/.test(src),
    '\u2b50\u2b50 close 回调要先确认"表里存的还是我" —— 旧连接的 close 迟到会删掉顶替它的新连接，还可能把整个房间摘掉',
  )
  const closeAt = src.indexOf("ws.on('close'")
  const guardAt = src.indexOf('clients.get(address) !== ws')
  const delAt = src.indexOf('clients.delete(address)', closeAt)
  ok(guardAt > closeAt && guardAt < delAt, '守卫必须在 delete 之前')
}

console.log('\n\u2500\u2500 \u2b50 \u6162\u63a5\u6536\u7aef\u80cc\u538b \u2500\u2500')
{
  let sent = 0
  const openPeer = {
    OPEN: 1,
    readyState: 1,
    bufferedAmount: 512 * 1024 - 30,
    send() { sent++ },
    close() { throw new Error('\u672a\u9884\u671f\u65ad\u5f00') },
  }
  ok(sendIpxFrame(openPeer, Buffer.alloc(30)), '\u961f\u5217\u4e0a\u9650\u5185\u7684\u63a7\u5236\u5305\u7167\u5e38\u53d1\u9001')
  ok(sent === 1, '\u6b63\u5e38\u63a5\u6536\u7aef\u4ecd\u6536\u5230\u6570\u636e')

  let closeCode = 0
  const slowPeer = {
    OPEN: 1,
    readyState: 1,
    bufferedAmount: 512 * 1024,
    send() { throw new Error('\u6162\u63a5\u6536\u7aef\u4e0d\u80fd\u518d\u6536\u5230\u6392\u961f\u5305') },
    close(code) { closeCode = code },
  }
  ok(!sendIpxFrame(slowPeer, Buffer.alloc(1)), '\u8d85\u8fc7\u5f85\u53d1\u9001\u961f\u5217\u4e0a\u9650\u65f6\u505c\u6b62\u6295\u9012')
  ok(closeCode === 1013, '\u53ea\u5173\u95ed\u961f\u5217\u79ef\u538b\u7684\u6162\u63a5\u6536\u7aef\uff0c\u91ca\u653e\u5176\u5185\u5b58')
  const closedPeer = { ...openPeer, readyState: 3 }
  ok(!sendIpxFrame(closedPeer, Buffer.alloc(1)), '\u5df2\u5173\u95ed\u8fde\u63a5\u4e0d\u518d\u53d1\u9001')
}

wss.close()
console.log(`\n${fail ? '\u274c' : '\u2705'} IPX：${pass} 项通过，${fail} 项失败`)
process.exit(fail ? 1 : 0)
