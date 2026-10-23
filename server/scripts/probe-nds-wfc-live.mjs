/** 仅人工验收时运行：检查同源中继 → 当前 WFC DNS → NAS / GameSpy。 */
import assert from 'node:assert/strict'
import { WebSocket } from 'ws'
import { dnsAnswerIps } from '../src/nds-wfc.js'

const base = process.argv[2] || 'http://127.0.0.1:5189'
const response = await fetch(`${base}/api/nds-wfc/session`, {
  method: 'POST',
  headers: { Origin: base, 'Content-Type': 'application/json' },
  body: JSON.stringify({ gameSlug: 'call-of-duty-world-at-war' }),
})
assert.equal(response.status, 200)
const session = await response.json()
const wsUrl = `${base.replace(/^http/, 'ws')}${session.path}${session.token}/udp/178.62.43.212/53/1/${'a'.repeat(16)}`
const ws = new WebSocket(wsUrl, 'binary', { headers: { Origin: base } })
const name = 'nas.nintendowifi.net'.split('.')
const query = Buffer.concat([
  Buffer.from([0x12, 0x34, 0x01, 0, 0, 1, 0, 0, 0, 0, 0, 0]),
  ...name.map((label) => Buffer.concat([Buffer.from([label.length]), Buffer.from(label)])),
  Buffer.from([0, 0, 1, 0, 1]),
])
const answer = await Promise.race([
  new Promise((resolve, reject) => {
    ws.once('open', () => ws.send(query))
    ws.once('message', (message) => resolve(Buffer.from(message)))
    ws.once('error', reject)
  }),
  new Promise((_, reject) => setTimeout(() => reject(new Error('WFC DNS 超时')), 10_000)),
])
const ips = dnsAnswerIps(answer, 'nas.nintendowifi.net')
const cachedNasIps = session.dns?.answers?.['nas.nintendowifi.net'] || []
assert.ok(ips.length > 0, `WFC DNS 没有返回可用公网地址：${answer.subarray(0, 96).toString('hex')}`)
assert.ok(!cachedNasIps.length || ips.some((ip) => cachedNasIps.includes(ip)), `DNS 回答与会话快照不一致：${ips.join(',')}`)
const nasIp = ips[0]
ws.close()
const tcpUrl = `${base.replace(/^http/, 'ws')}${session.path}${session.token}/tcp/${nasIp}/80`
const tcp = new WebSocket(tcpUrl, 'binary', { headers: { Origin: base } })
const httpReply = await Promise.race([
  new Promise((resolve, reject) => {
    tcp.once('open', () => tcp.send(Buffer.from('GET /ac HTTP/1.1\r\nHost: nas.nintendowifi.net\r\nConnection: close\r\n\r\n')))
    tcp.on('message', (message) => resolve(Buffer.from(message).toString('utf8')))
    tcp.once('error', reject)
  }),
  new Promise((_, reject) => setTimeout(() => reject(new Error('WFC 登录服务器 TCP 超时')), 10_000)),
])
assert.match(httpReply, /^HTTP\/1\.1 (?:200 OK|401 Unauthorized)/)
tcp.close()
const gpDns = new WebSocket(wsUrl, 'binary', { headers: { Origin: base } })
const gpName = 'gpcm.gs.nintendowifi.net'.split('.')
const gpQuery = Buffer.concat([
  Buffer.from([0x12, 0x35, 0x01, 0, 0, 1, 0, 0, 0, 0, 0, 0]),
  ...gpName.map((label) => Buffer.concat([Buffer.from([label.length]), Buffer.from(label)])),
  Buffer.from([0, 0, 1, 0, 1]),
])
const gpAnswer = await Promise.race([
  new Promise((resolve, reject) => {
    gpDns.once('open', () => gpDns.send(gpQuery))
    gpDns.once('message', (message) => resolve(Buffer.from(message)))
    gpDns.once('error', reject)
  }),
  new Promise((_, reject) => setTimeout(() => reject(new Error('GameSpy DNS 超时')), 10_000)),
])
const gpIps = dnsAnswerIps(gpAnswer, 'gpcm.gs.nintendowifi.net')
assert.ok(gpIps.length > 0, 'GameSpy 域名没有返回可用公网地址')
gpDns.close()
const gpUrl = `${base.replace(/^http/, 'ws')}${session.path}${session.token}/tcp/${gpIps[0]}/29900`
const gp = new WebSocket(gpUrl, 'binary', { headers: { Origin: base } })
const challenge = await Promise.race([
  new Promise((resolve, reject) => {
    gp.once('message', (message) => resolve(Buffer.from(message).toString('ascii')))
    gp.once('error', reject)
  }),
  new Promise((_, reject) => setTimeout(() => reject(new Error('GameSpy 登录挑战超时')), 10_000)),
])
assert.match(challenge, /^\\lc\\1\\challenge\\/)
gp.close()
console.log(`NDS WFC：同源 WebSocket → WFC DNS → NAS HTTP → GameSpy 登录挑战已打通（NAS ${nasIp}）`)
