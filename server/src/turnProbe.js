/**
 * 「自建 TURN 现在到底能不能用」—— 主动探活，以及据此在下发时切换。
 *
 * ── 先把一个常见误解摆平 ──────────────────────────────────
 * WebRTC **没有**「主的挂了才用备的」这种串行回退。`iceServers` 里所有服务器是一起
 * 交给浏览器的，它同时向每一台收集候选，然后按优先级配对。所以「自建挂了自动换 CF」
 * 这件事，在浏览器那一侧其实**本来就是自动的**（自建配不上，就只剩 CF 的 relay 候选可用）。
 *
 * 那还要这个模块干什么？因为「自动兜住了」和「没问题」是两件事：
 *
 *   1. 一条配不上的 TURN 仍然要白耗浏览器的候选收集时间（每台不可达的服务器都得等到超时），
 *      开局和观众入场都跟着变慢。
 *   2. **你不会知道。** `turnSources` 照样如实报 `['self-hosted','cloudflare']`，
 *      而 CF 从「兜底」变成扛 100% 的中继流量 —— 只有账单上看得出来。
 *      2026-09-07 那次 CDN 缓存事故能藏那么久，就是因为「兜底还在工作」。
 *   3. 万一 CF 那路也悄悄没了（token 过期、key 轮换），要等到真的没人能连才发现。
 *
 * 所以真正能做「切换」的地方只有一处：**服务端在下发之前就知道哪一路是死的，不发它。**
 * 而唯一可靠的问法是拿即将下发的那份凭证真的走一遍 Allocate ——
 * ping 通 / TCP 连得上 / 端口开着全都不算，线上最常见的两种死法在那些检查里都是绿的：
 *   · 凭证时间戳过期 → coturn 回 401（CDN 缓存住 ICE 接口就是这个）
 *   · 中继端口段 49160-49200/udp 没放行 → 握手过了，但分不到中继地址
 * 顺带：`turns:` 那条走真 TLS 校验，证书过期也能探出来（浏览器一样会拒）。
 *
 * ── 边界 ──────────────────────────────────────────────
 * 探针是**从服务器**发出去的。所以它能可靠地判「坏」，不能可靠地判「全世界都能到」：
 * 源站到 coturn 通、而公网到 coturn 的中继端口不通，这种情况探针查不出来。
 * 因此判定为「down」时才动下发，「up」只当作「没有已知故障」。
 */
import { randomBytes } from 'node:crypto'
import dgram from 'node:dgram'
import net from 'node:net'
import tls from 'node:tls'
import {
  ATTR,
  CLASS,
  METHOD,
  appendIntegrity,
  decodeMessage,
  encodeMessage,
  errorCode,
  longTermKey,
  parseTurnUrl,
  xorAddress,
} from './turnStun.js'

/* ─────────────────── 一条链路上的收发通道 ─────────────────── */

/**
 * UDP 要自己重传（RFC 5389 的 RTO 退避）。探活如果只发一次，
 * 丢一个包就误判成「TURN 挂了」—— 这种误判会真的改下发，代价比多发两个包大得多。
 */
const UDP_RETRANSMIT_MS = [0, 500, 1500]

function makeChannel(t, { timeoutMs, insecureTls }) {
  return new Promise((resolve, reject) => {
    const waiters = []
    const inbox = []
    let closed = false
    let fail = (e) => reject(e)

    const deliver = (msg) => {
      const i = waiters.findIndex((w) => w.tx.equals(msg.transactionId))
      if (i >= 0) {
        const w = waiters.splice(i, 1)[0]
        clearTimeout(w.timer)
        clearInterval(w.rtx)
        w.resolve(msg)
      } else {
        inbox.push(msg)
      }
    }
    const die = (err) => {
      if (closed) return
      closed = true
      for (const w of waiters.splice(0)) {
        clearTimeout(w.timer)
        clearInterval(w.rtx)
        w.reject(err)
      }
      fail(err)
    }

    /** 等一条 transaction id 对得上的回包；`retransmit` 只在 UDP 上给 */
    const api = (send, close) => ({
      request(buf, waitMs) {
        const tx = buf.subarray(8, 20)
        const hit = inbox.findIndex((m) => m.transactionId.equals(tx))
        if (hit >= 0) return Promise.resolve(inbox.splice(hit, 1)[0])
        return new Promise((res, rej) => {
          const w = { tx: Buffer.from(tx), resolve: res, reject: rej, timer: 0, rtx: 0 }
          w.timer = setTimeout(() => {
            const i = waiters.indexOf(w)
            if (i >= 0) waiters.splice(i, 1)
            clearInterval(w.rtx)
            rej(new Error('超时没回包'))
          }, waitMs)
          waiters.push(w)
          try {
            if (t.transport === 'udp') {
              let n = 0
              const fire = () => {
                if (closed || !waiters.includes(w)) return
                send(buf)
                if (++n < UDP_RETRANSMIT_MS.length) w.rtx = setTimeout(fire, UDP_RETRANSMIT_MS[n] - UDP_RETRANSMIT_MS[n - 1])
              }
              fire()
            } else {
              send(buf)
            }
          } catch (e) {
            rej(e)
          }
        })
      },
      close() {
        if (closed) return
        closed = true
        for (const w of waiters.splice(0)) {
          clearTimeout(w.timer)
          clearInterval(w.rtx)
        }
        try {
          close()
        } catch {
          /* 关个 socket 而已，抛了也无所谓 */
        }
      },
    })

    if (t.transport === 'udp') {
      const sock = dgram.createSocket(net.isIPv6(t.host) ? 'udp6' : 'udp4')
      sock.on('error', die)
      sock.on('message', (d) => {
        const m = decodeMessage(d)
        if (m) deliver(m)
      })
      const ch = api((buf) => sock.send(buf, t.port, t.host), () => sock.close())
      fail = (e) => {
        try {
          sock.close()
        } catch {
          /* 已经关了 */
        }
        reject(e)
      }
      resolve(ch)
      return
    }

    // TCP / TLS：STUN 报文是背靠背发的，靠头里的长度字段自己切
    const onSock = (sock) => {
      let acc = Buffer.alloc(0)
      sock.setTimeout(timeoutMs, () => die(new Error('连接空闲超时')))
      sock.on('error', die)
      sock.on('close', () => die(new Error('连接被对方关掉了')))
      sock.on('data', (d) => {
        acc = Buffer.concat([acc, d])
        for (;;) {
          if (acc.length < 20) break
          const total = 20 + acc.readUInt16BE(2)
          if (acc.length < total) break
          const m = decodeMessage(acc.subarray(0, total))
          acc = acc.subarray(total)
          if (m) deliver(m)
          else break
        }
      })
      const ch = api((buf) => sock.write(buf), () => sock.destroy())
      fail = (e) => {
        sock.destroy()
        reject(e)
      }
      resolve(ch)
    }

    if (t.secure) {
      // 证书**默认要验** —— 浏览器连 turns: 也验，放过去就等于探不出证书问题
      const sock = tls.connect(
        { host: t.host, port: t.port, servername: t.host, rejectUnauthorized: !insecureTls, timeout: timeoutMs },
        () => onSock(sock),
      )
      sock.on('error', die)
      sock.on('timeout', () => die(new Error('TLS 握手超时')))
    } else {
      const sock = net.connect({ host: t.host, port: t.port, timeout: timeoutMs }, () => onSock(sock))
      sock.on('error', die)
      sock.on('timeout', () => die(new Error('TCP 连接超时')))
    }
  })
}

/* ─────────────────── 一条 URL 的 Allocate 探活 ─────────────────── */

const authAttrs = (username, realm, nonce) => [
  [ATTR.USERNAME, Buffer.from(username, 'utf8')],
  [ATTR.REALM, realm],
  [ATTR.NONCE, nonce],
]

/**
 * 对一条 turn:/turns: 地址走一次完整的 Allocate。
 *
 * 流程（RFC 5766 §6）：不带凭证发一次 → 对方必回 401 并给 realm/nonce →
 * 带 USERNAME/REALM/NONCE/MESSAGE-INTEGRITY 再发一次 → 成功响应里带 XOR-RELAYED-ADDRESS。
 * **没拿到中继地址就不算通** —— 只走完握手、分不到地址正是「中继端口段没放行」的形状。
 *
 * 拿到之后立刻发一个 lifetime=0 的 Refresh 把它退掉：
 * 不退的话每探一次就在 coturn 上留一个 10 分钟的中继分配，白占端口。
 */
export async function probeTurnUrl({ url, username, credential, timeoutMs = 3000, insecureTls = false }) {
  const t = parseTurnUrl(url)
  const started = Date.now()
  const base = { url: String(url), transport: t ? `${t.secure ? 'tls' : t.transport}` : '?' }
  if (!t) return { ...base, ok: false, error: '地址解析不了' }
  if (t.secure && t.transport === 'udp') {
    // turns: + transport=udp 是 DTLS，coturn 默认不开；探它只会得到一个假的「不通」
    return { ...base, ok: false, skipped: true, error: 'turns 走 DTLS，本探针不支持，跳过' }
  }
  if (!username || !credential) return { ...base, ok: false, error: '没有凭证' }

  let ch = null
  try {
    ch = await makeChannel(t, { timeoutMs, insecureTls })

    const first = await ch.request(
      encodeMessage({
        method: METHOD.ALLOCATE,
        transactionId: randomBytes(12),
        attrs: [
          [ATTR.REQUESTED_TRANSPORT, Buffer.from([17, 0, 0, 0])], // 17 = UDP
          [ATTR.SOFTWARE, '8bitgo-turn-probe'],
        ],
      }),
      timeoutMs,
    )

    // 正常情况第一发必然是 401；直接成功说明这台没开鉴权（也算通，但值得说一声）
    let realm = first.attrs.get(ATTR.REALM)
    let nonce = first.attrs.get(ATTR.NONCE)
    if (first.cls === CLASS.SUCCESS) {
      const relay = xorAddress(first.attrs.get(ATTR.XOR_RELAYED_ADDRESS), first.transactionId)
      return { ...base, ok: Boolean(relay), relay, rttMs: Date.now() - started, note: '这台 TURN 没要凭证' }
    }
    if (!realm || !nonce) {
      const { code, reason } = errorCode(first.attrs.get(ATTR.ERROR_CODE))
      return { ...base, ok: false, code, error: `第一发没给 realm/nonce（${code || '?'} ${reason}）`.trim() }
    }

    // 438 Stale Nonce 时对方会给新 nonce，允许再来一次
    for (let attempt = 0; attempt < 2; attempt++) {
      const key = longTermKey(username, realm.toString('utf8'), credential)
      const msg = appendIntegrity(
        encodeMessage({
          method: METHOD.ALLOCATE,
          transactionId: randomBytes(12),
          attrs: [
            [ATTR.REQUESTED_TRANSPORT, Buffer.from([17, 0, 0, 0])],
            [ATTR.SOFTWARE, '8bitgo-turn-probe'],
            ...authAttrs(username, realm, nonce),
          ],
        }),
        key,
      )
      const res = await ch.request(msg, timeoutMs)

      if (res.cls === CLASS.SUCCESS) {
        const relay = xorAddress(res.attrs.get(ATTR.XOR_RELAYED_ADDRESS), res.transactionId)
        if (!relay) {
          return { ...base, ok: false, error: '给了成功响应但没有中继地址（中继端口段没放行？）' }
        }
        // 退掉这次分配，别在 coturn 上留垃圾
        try {
          await ch.request(
            appendIntegrity(
              encodeMessage({
                method: METHOD.REFRESH,
                transactionId: randomBytes(12),
                attrs: [[ATTR.LIFETIME, Buffer.from([0, 0, 0, 0])], ...authAttrs(username, realm, nonce)],
              }),
              key,
            ),
            1000,
          )
        } catch {
          /* 退不掉就让它自己到期，不影响判定 */
        }
        return { ...base, ok: true, relay, rttMs: Date.now() - started }
      }

      const { code, reason } = errorCode(res.attrs.get(ATTR.ERROR_CODE))
      const newNonce = res.attrs.get(ATTR.NONCE)
      if (code === 438 && newNonce) {
        nonce = newNonce
        realm = res.attrs.get(ATTR.REALM) || realm
        continue
      }
      return { ...base, ok: false, code, error: explainAllocateError(code, reason) }
    }
    return { ...base, ok: false, error: 'nonce 一直是过期的（438 反复出现）' }
  } catch (e) {
    return { ...base, ok: false, error: String(e?.message || e) }
  } finally {
    ch?.close()
  }
}

/** 把 coturn 的错误码翻成「该去查哪一行配置」，排查的人不用再翻文档 */
function explainAllocateError(code, reason) {
  const tail = reason ? `（${reason}）` : ''
  if (code === 401) {
    return (
      '401 凭证被拒' +
      tail +
      ' —— 最常见的两种：① 下发的凭证已过期（`/api/netplay/ice` 被 CDN 缓存住了，' +
      '把 /api/ 排除出缓存规则）；② TURN_SECRET 和 turnserver.conf 的 static-auth-secret 不一致（末尾空格/换行也算）'
    )
  }
  if (code === 441) return `441 realm 不匹配${tail} —— turnserver.conf 的 realm 和签发时用的不一致`
  if (code === 486 || code === 508) return `${code} coturn 资源用尽${tail} —— 中继端口段是不是太窄，或者旧分配没退掉`
  if (code === 403) return `403 被策略拒绝${tail} —— 看 denied-peer-ip / allowed-peer-ip`
  return `${code || '?'} 分配失败${tail}`
}

/* ─────────────────── 各路的健康状态 + 后台探活 ─────────────────── */

/**
 * 连续失败几次才判「down」。
 * 一次失败就改下发的话，一个丢包 / 一次瞬时抖动就能把自建那路踢掉；
 * 反过来一次成功就立刻恢复 —— 恢复要快，判死要慢。
 */
const DOWN_AFTER = 2

const paths = new Map() // name → { urls, mint, state, fails, checkedAt, results, since, error }

const num = (v, d) => {
  const n = Number(v)
  return Number.isFinite(n) && n > 0 ? n : d
}
const probeIntervalMs = () => num(process.env.TURN_PROBE_INTERVAL_SEC, 60) * 1000
const probeTimeoutMs = () => num(process.env.TURN_PROBE_TIMEOUT_MS, 3000)
const probeOff = () => String(process.env.TURN_PROBE || '').toLowerCase() === 'off'
const insecureTls = () => String(process.env.TURN_PROBE_INSECURE_TLS || '') === '1'

/**
 * 登记一路要探的 TURN。
 *
 * ⚠️ 存的是**签凭证的函数**，不是签好的凭证。存死凭证的话：自建那路 TTL 一小时，
 * 只要一小时内没人开局，下一轮探活就会拿着过期凭证去撞 401，
 * 把「没人玩」误判成「TURN 挂了」—— 而这恰好和我们要抓的真 bug 长得一模一样。
 */
export function registerTurnPath(name, urls, mint) {
  const list = (urls || []).map(String).filter(Boolean)
  if (!list.length || typeof mint !== 'function') {
    paths.delete(name)
    return
  }
  const prev = paths.get(name)
  const sameUrls = prev && prev.urls.join('|') === list.join('|')
  paths.set(name, {
    urls: list,
    mint,
    // 地址变了就当一路新的，历史判定作废
    state: sameUrls ? prev.state : 'unknown',
    fails: sameUrls ? prev.fails : 0,
    checkedAt: sameUrls ? prev.checkedAt : 0,
    results: sameUrls ? prev.results : [],
    since: sameUrls ? prev.since : 0,
    error: sameUrls ? prev.error : '',
  })
}

/** 'up' | 'down' | 'unknown'。unknown（还没探过）**一律按能用处理**，绝不因为没数据就砍掉一路 */
export const turnPathState = (name) => paths.get(name)?.state || 'unknown'
export const turnPathDown = (name) => turnPathState(name) === 'down'

/** 摊给 /api/netplay/ice 和 /api/diag 看的快照 */
export function turnHealthSnapshot({ verbose = false } = {}) {
  const out = {}
  for (const [name, p] of paths) {
    out[name] = {
      state: p.state,
      checkedAt: p.checkedAt || null,
      since: p.since || null,
      ...(verbose ? { error: p.error || null, urls: p.results } : {}),
    }
  }
  return out
}

async function probePath(name) {
  const p = paths.get(name)
  if (!p) return
  let cred = null
  try {
    cred = await p.mint()
  } catch (e) {
    cred = null
    p.error = `签凭证失败：${String(e?.message || e)}`
  }
  const results = []
  if (cred?.username && cred?.credential) {
    for (const url of p.urls) {
      results.push(
        await probeTurnUrl({
          url,
          username: cred.username,
          credential: cred.credential,
          timeoutMs: probeTimeoutMs(),
          insecureTls: insecureTls(),
        }),
      )
    }
  }
  // 一条通就算这一路通（浏览器也是有一条能用就够）；全被跳过的话不算数据
  const usable = results.filter((r) => !r.skipped)
  const ok = usable.some((r) => r.ok)
  const graded = usable.length > 0

  p.results = results
  p.checkedAt = Math.floor(Date.now() / 1000)
  if (!graded) {
    p.error = results[0]?.error || '没有可探的地址'
    return
  }
  p.error = ok ? '' : usable.find((r) => !r.ok)?.error || '分配失败'

  const was = p.state
  if (ok) {
    p.fails = 0
    p.state = 'up'
  } else {
    p.fails++
    if (p.fails >= DOWN_AFTER) p.state = 'down'
  }
  if (p.state !== was) {
    p.since = p.checkedAt
    if (p.state === 'down') {
      console.warn(
        `[turn] ${name} 探活失败 ${p.fails} 次，判定为不可用，已从 ICE 下发里摘掉。原因：${p.error}`,
      )
    } else if (was === 'down') {
      console.warn(`[turn] ${name} 恢复了，重新下发`)
    }
  }
}

let loop = null

/**
 * 起后台探活。
 * ⚠️ **绝不接在 `/api/netplay/ice` 的请求路径上** —— 那个接口在开局的关键路径上，
 * 玩家点「开始游戏」就在等它；探活最坏要等好几秒。所以请求只读缓存里的判定。
 * 由 src/index.js 显式调用：测试直接 import 路由，不会顺带发出探测包。
 */
export function startTurnHealth() {
  if (loop || probeOff()) return
  const tick = async () => {
    for (const name of [...paths.keys()]) {
      try {
        await probePath(name)
      } catch (e) {
        console.warn(`[turn] 探 ${name} 时自己抛了（不影响下发）：`, e?.message || e)
      }
    }
  }
  // 起来先等一小会儿：让第一个请求把要探的几路登记进来，也别和启动挤在一起
  loop = setInterval(tick, probeIntervalMs())
  loop.unref?.()
  setTimeout(tick, 3000).unref?.()
}

export function stopTurnHealth() {
  if (loop) clearInterval(loop)
  loop = null
}

/** 测试用：清掉登记表和判定 */
export function _resetTurnHealth() {
  paths.clear()
}

/** 测试 / CLI 用：立刻探一轮并返回快照 */
export async function probeNow() {
  for (const name of [...paths.keys()]) await probePath(name)
  return turnHealthSnapshot({ verbose: true })
}
