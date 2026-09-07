#!/usr/bin/env node
/**
 * 对着**真的** coturn / CF 跑一次探活，把结论直接打出来。
 *
 *   cd server && npm run turn:probe
 *
 * 为什么要有这个命令行版：`server/scripts/test-turn-probe.mjs` 里那个假 TURN 服务端
 * 只能证明「报文的收发流程是对的」—— MESSAGE-INTEGRITY 到底算得对不对、
 * 你那台 coturn 的 realm / secret / 中继端口段对不对，**只有真机能证明**。
 * 这个脚本就是那一步，读 server/.env，不改任何东西。
 *
 * 读到什么算好：每一路 state=up，并且 urls 里至少一条 ok=true 且带 relay 地址。
 * relay 那个地址就是 coturn 真的给我们分配的中继端口 —— 拿到它才叫「TURN 能用」，
 * ping 通 / 端口开着都不算（线上最常见的两种死法在那些检查里都是绿的）。
 */
import { config } from 'dotenv'
import { registerTurnProbeTargets } from '../src/routes/ice.js'
import { probeNow } from '../src/turnProbe.js'

config()

const names = { 'self-hosted': '自建 coturn', managed: '托管服务', cloudflare: 'Cloudflare' }

await registerTurnProbeTargets()
const snap = await probeNow()

const entries = Object.entries(snap)
if (!entries.length) {
  console.log('一路 TURN 都没配 —— 看 server/.env 里的 TURN_URLS / TURN_BACKUP_URLS / TURN_CF_KEY_ID')
  process.exit(1)
}

let bad = 0
for (const [name, p] of entries) {
  const icon = p.state === 'up' ? '✅' : p.state === 'down' ? '❌' : '❔'
  console.log(`\n${icon} ${names[name] || name}  —— ${p.state}`)
  for (const r of p.urls || []) {
    if (r.skipped) {
      console.log(`   ⏭  ${r.url}  ${r.error}`)
    } else if (r.ok) {
      console.log(`   ✅ ${r.url}  ${r.rttMs}ms  中继地址 ${r.relay}${r.note ? `  ⚠️ ${r.note}` : ''}`)
    } else {
      console.log(`   ❌ ${r.url}\n      ${r.error}`)
    }
  }
  if (p.state !== 'up') bad++
}

console.log(
  bad
    ? `\n${bad} 路有问题。自建那路 401 的话，先按 /api/netplay/ice 是否被 CDN 缓存查（裸 URL 和 ?cb=随机 的 expiry 对不上就是它）。`
    : '\n全部可用。',
)
process.exit(bad ? 1 : 0)
