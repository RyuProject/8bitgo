import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'

/**
 * 房主 / 成员的「名片」：用什么设备在玩、人在哪个国家、网络好不好。
 *
 * 三样东西**全部由服务端推断**，客户端一个字段都不上报，原因有两个：
 *
 *   1. 联机房间（netplay）的 socket 客户端是 EmulatorJS 自带的 data/src/netplay.js，
 *      不是我们的代码。想让它多报几个字段就得改引擎、还得每次升级重新打补丁
 *      （见 AGENTS.md 2.7）。而握手时的 UA 和 IP 本来就摆在服务端手里。
 *   2. 客户端报什么服务端就信什么的话，挂个 VPN 报个 🇯🇵、把 RTT 报成 1ms
 *      都是一行代码的事 —— 这三个标记的全部意义就是「别人说的不算」。
 *
 * 输出统一是这个形状（渲染成 emoji 是前端的事，见 src/services/presence.ts）：
 *
 *     { device: 'desktop' | 'mobile' | 'unknown',
 *       country: 'CN' | null,
 *       net: 'good' | 'fair' | 'poor' | 'unknown',
 *       rtt: 42 | null }
 *
 * ⚠️ 国家要能查出来，nginx 必须把真实 IP 传进来。反代少一行
 * `proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;`
 * 的话，服务端看到的每个人都是 127.0.0.1，全站永远是 ❓，而且不报错。
 * 见 deploy/netplay/README.md 里的 nginx 片段。
 */

/* ---------------- 网络分档 ---------------- */

/**
 * RTT 分档阈值（毫秒）。默认值按「国内到国内 / 跨洲」的经验值定：
 * 同区大约 20–80ms，跨洲 150–250ms，卫星或者很差的移动网 400ms 以上。
 */
const RTT_GOOD = Number(process.env.PRESENCE_RTT_GOOD || 120)
const RTT_FAIR = Number(process.env.PRESENCE_RTT_FAIR || 300)

/**
 * 注意这个 RTT 是「房主 ↔ 本站服务器」，不是「房主 ↔ 观众」——
 * 画面走的是 WebRTC 直连，根本不经过我们（见 live.js 的图）。
 * 所以它只是个可用的近似：房主到我们这儿都费劲，到别人那儿一般也好不了。
 * 前端的 title 里会把毫秒数写出来，别让人以为这是端到端延迟。
 */
export function netFromRtt(rtt) {
  if (typeof rtt !== 'number' || !Number.isFinite(rtt) || rtt < 0) return 'unknown'
  if (rtt <= RTT_GOOD) return 'good'
  if (rtt <= RTT_FAIR) return 'fair'
  return 'poor'
}

/* ---------------- 设备 ---------------- */

/**
 * 只分「手机 / 电脑 / 不知道」三档，不做机型识别 —— 卡片上就一个 emoji 的位置。
 *
 * 已知会判错的一种：iPadOS 13 之后 Safari 默认发的是 Mac 的 UA，iPad 会算成 💻。
 * 苹果自己都不打算让人分辨，我们也不猜（猜错比认怂更糟）。
 */
const MOBILE_UA = /Android|iPhone|iPod|Windows Phone|IEMobile|BlackBerry|BB10|Opera Mini|Opera Mobi|webOS|Mobile Safari|Silk\//i
/** 平板按手机算：都是「捧在手上、触屏、可能在移动网上」 */
const TABLET_UA = /iPad|Tablet|PlayBook|Kindle|Nexus 7|Nexus 10/i

export function deviceFromUa(ua) {
  const s = typeof ua === 'string' ? ua : ''
  if (!s) return 'unknown'
  if (MOBILE_UA.test(s) || TABLET_UA.test(s)) return 'mobile'
  return 'desktop'
}

/* ---------------- IP ---------------- */

/** `::ffff:1.2.3.4` / `[::1]:443` / `1.2.3.4:5678` 都收拾成纯地址 */
function normalizeIp(raw) {
  let ip = String(raw || '').trim()
  if (!ip) return ''
  // `[::1]:443` —— 方括号里才是地址
  if (ip.startsWith('[')) {
    const end = ip.indexOf(']')
    ip = end > 0 ? ip.slice(1, end) : ip.slice(1)
  }
  // 顺序要紧：先把 v4-mapped 的前缀削掉，否则 `::ffff:127.0.0.1` 会被下面
  // 当成「带端口的 v4」从最后一个冒号切开，切出个 `::ffff` 来
  if (/^::ffff:/i.test(ip)) ip = ip.slice(7)
  // 只有 `1.2.3.4:5678` 这一种是带端口的；纯 v6 冒号多得是，不能切
  if (ip.includes('.') && ip.split(':').length === 2) ip = ip.split(':')[0]
  return ip
}

/** 内网 / 回环 / 链路本地。这些查不出国家，也说明「这一跳还是代理」 */
function isPrivateIp(ip) {
  if (!ip) return true
  if (ip === '::1' || ip === '::') return true
  if (/^(10\.|127\.|169\.254\.|192\.168\.)/.test(ip)) return true
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(ip)) return true
  if (/^(f[cd]|fe[89ab])/i.test(ip)) return true // fc00::/7, fe80::/10
  return false
}

/**
 * TRUST_PROXY=false 时完全不看 X-Forwarded-For。
 * 其它值（默认 loopback）当作「前面有一层自己人的反代」，和 index.js 里
 * app.set('trust proxy', …) 的默认保持一致。
 */
const TRUST_PROXY = String(process.env.TRUST_PROXY ?? 'loopback')
const PROXY_TRUSTED = TRUST_PROXY !== 'false' && TRUST_PROXY !== '0' && TRUST_PROXY !== ''

/**
 * 从握手信息里挖出真实客户端 IP。
 *
 * 为什么取 X-Forwarded-For 的**最后一段**而不是第一段：nginx 的
 * `$proxy_add_x_forwarded_for` 是「客户端自己带来的那串 + 我实际看到的对端」，
 * 追加在末尾。开头那些是客户端随手写的，`curl -H 'X-Forwarded-For: 1.1.1.1'`
 * 就能让自己变成澳大利亚人。只有最后一段是反代亲眼所见。
 * （playcount.js 里取的是第一段 —— 那边只是计数，这里是要显示给所有人看的。）
 *
 * 直连进来的（对端不是内网地址）一律不信 XFF：说明请求没经过我们的反代。
 */
export function clientIpFrom(directAddress, headers = {}) {
  const direct = normalizeIp(directAddress)
  if (!PROXY_TRUSTED || !isPrivateIp(direct)) return direct
  const xff = headers['x-forwarded-for'] || headers['X-Forwarded-For'] || ''
  const hops = String(xff).split(',').map(normalizeIp).filter(Boolean)
  for (let i = hops.length - 1; i >= 0; i--) if (!isPrivateIp(hops[i])) return hops[i]
  const real = normalizeIp(headers['x-real-ip'])
  return real && !isPrivateIp(real) ? real : direct
}

/* ---------------- 国家 ---------------- */

/**
 * 离线库，不打第三方接口 —— 每开一个房间去请求一次 ip-api.com 这种服务，
 * 既慢又会被限流，还等于把访客 IP 送给别人。
 *
 * 用的是 @ip-location-db 的 geo-whois-asn-country（CC0，直接来自 RIR 的 whois，
 * 不需要 MaxMind 那种许可证密钥），mmdb 格式约 7.8MB，v4 + v6 都在一个文件里。
 * 更新就是 `npm update @ip-location-db/geo-whois-asn-country-mmdb`。
 *
 * 整块包在 try 里：库没装好也只是全站显示 ❓，不能让后端起不来 ——
 * 一个装饰性的小旗子不配把整站拖下水（AGENTS.md 2.10 的教训）。
 */
const require_ = createRequire(import.meta.url)
let geoReader = null
let geoWarned = false
try {
  const { Reader } = require_('mmdb-lib')
  const file = require_.resolve('@ip-location-db/geo-whois-asn-country-mmdb/geo-whois-asn-country.mmdb')
  geoReader = new Reader(readFileSync(file))
} catch (e) {
  console.warn('[presence] 国家库没加载上，房间卡片的地区会显示未知：', e?.message || e)
}

/** IP -> 国家码。查不到返回 null（内网、库没装、地址不合法都走这条） */
const geoCache = new Map()
const GEO_CACHE_MAX = 5000

export function countryFromIp(ip) {
  if (!geoReader || !ip || isPrivateIp(ip)) return null
  const hit = geoCache.get(ip)
  if (hit !== undefined) return hit
  let code = null
  try {
    const row = geoReader.get(ip)
    // 这个库的字段叫 country_code；换库时这里要跟着改
    const raw = row?.country_code || row?.country?.iso_code || null
    if (typeof raw === 'string' && /^[A-Za-z]{2}$/.test(raw)) code = raw.toUpperCase()
  } catch (e) {
    if (!geoWarned) {
      geoWarned = true
      console.warn('[presence] 国家查询出错（只提示一次）：', e?.message || e)
    }
  }
  // 简单粗暴地防止无限增长：满了就清空重来，命中率掉一阵子而已
  if (geoCache.size >= GEO_CACHE_MAX) geoCache.clear()
  geoCache.set(ip, code)
  return code
}

/* ---------------- RTT ---------------- */

/**
 * 用 socket.io 底层 engine.io 的心跳量往返延迟。
 *
 * 为什么不自己 emit 一个 'ping' 事件让客户端回：联机房间的客户端是 EmulatorJS 的，
 * 它只认自己协议里那几个事件名，发过去石沉大海。而 engine.io 的心跳是协议自带的，
 * 任何 socket.io 客户端都会回 —— 包括我们改不动的那个。
 *
 * 服务端发 ping、客户端回 pong，两边的时间差就是 RTT，不需要对表。
 *
 * 采样间隔 = pingInterval（netplay.js 里调成了 10 秒，默认的 25 秒太久，
 * 房间开出来第一眼全是 ❓）。单次采样会被一次 GC 或者一次切后台带偏，
 * 所以做了指数平滑：新样本只占三成，抖一下不会让格子从 👌 跳到 👎。
 */
const RTT_ALPHA = 0.3

export function trackRtt(socket) {
  let rtt = null
  const conn = socket?.conn
  if (!conn?.on) return () => null

  let sentAt = 0
  const onCreate = (packet) => {
    if (packet?.type === 'ping') sentAt = Date.now()
  }
  const onPacket = (packet) => {
    if (packet?.type !== 'pong' || !sentAt) return
    const sample = Date.now() - sentAt
    sentAt = 0
    // 大于 10 秒的样本多半是客户端被浏览器冻结了（切后台），不是网络差
    if (sample < 0 || sample > 10_000) return
    rtt = rtt === null ? sample : Math.round(rtt * (1 - RTT_ALPHA) + sample * RTT_ALPHA)
  }
  conn.on('packetCreate', onCreate)
  conn.on('packet', onPacket)
  // engine.io 的 socket 断开后整个对象就没人引用了，不用手动摘监听器

  return () => rtt
}

/* ---------------- 组装 ---------------- */

/** 没有任何信息时的默认名片。前端拿到它就是三个 ❓ */
export const UNKNOWN_PRESENCE = { device: 'unknown', country: null, net: 'unknown', rtt: null }

/**
 * 给一个 socket 建一张会自己更新的名片。
 * 设备和国家握手时就定了（不会变），只有 RTT 是活的，所以返回的是个取快照的函数。
 */
export function watchPresence(socket) {
  const headers = socket?.handshake?.headers || {}
  const device = deviceFromUa(headers['user-agent'])
  const country = countryFromIp(clientIpFrom(socket?.handshake?.address, headers))
  const getRtt = trackRtt(socket)
  return () => {
    const rtt = getRtt()
    return { device, country, net: netFromRtt(rtt), rtt }
  }
}

/**
 * HTTP 那一路（云端房间的心跳）用的版本。
 *
 * 云端房间没有到我们这儿的长连接，量不到服务端侧的 RTT，只能让浏览器把自己那次
 * 心跳请求的往返时间报上来 —— 这一项是客户端说了算的，所以钳一下范围，
 * 别让人报出 -1 或者 99999。设备和国家仍然是服务端自己看的，报不了假。
 */
export function presenceFromRequest(req, reportedRtt) {
  const device = deviceFromUa(req?.headers?.['user-agent'])
  // req.ip 已经按 index.js 里的 trust proxy 算好了，比自己再解析一遍靠谱
  const ip = normalizeIp(req?.ip) || clientIpFrom(req?.socket?.remoteAddress, req?.headers || {})
  const n = Number(reportedRtt)
  const rtt = Number.isFinite(n) && n >= 0 && n <= 10_000 ? Math.round(n) : null
  return { device, country: countryFromIp(ip), net: netFromRtt(rtt), rtt }
}
