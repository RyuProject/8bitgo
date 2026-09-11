#!/usr/bin/env node
/**
 * DOS 联机中继（IPX）的准入与连接管理。跑：cd server && npm run test:ipx
 *
 * 这是站上**第三条**长连接端点，而 sseGuard.js 给另外两条补的四道闸这里一道都没有。
 * 2026-09-09 源站猝死就是长连接被挂满堆出来的 —— 同一个形状不能再来一次。
 * 目前 IPX_ENABLED 没开，这些测试是为了「开之前就已经是对的」。
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { WebSocket } from 'ws'
import { attachIpx, ipxStats } from '../src/ipx.js'

let pass = 0
let fail = 0
const ok = (c, m) => {
  c ? (pass++, console.log('\u2705 ' + m)) : (fail++, console.log('\u274c ' + m))
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
  ok(
    /if \(clients\.get\(address\) !== ws\) return/.test(src),
    '\u2b50\u2b50 close 回调要先确认"表里存的还是我" —— 旧连接的 close 迟到会删掉顶替它的新连接，还可能把整个房间摘掉',
  )
  const closeAt = src.indexOf("ws.on('close'")
  const guardAt = src.indexOf('clients.get(address) !== ws')
  const delAt = src.indexOf('clients.delete(address)', closeAt)
  ok(guardAt > closeAt && guardAt < delAt, '守卫必须在 delete 之前')
}

wss.close()
console.log(`\n${fail ? '\u274c' : '\u2705'} IPX：${pass} 项通过，${fail} 项失败`)
process.exit(fail ? 1 : 0)
