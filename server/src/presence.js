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
 * 的话，服务端看到的每个人都是 127.0.0.1，IP 那一路就查不出任何东西。
 * 这种情况现在有两道兜底：网关自己加的国家头（Cloudflare 的 CF-IPCountry，见 countryFromHeaders），
 * 以及启动后第一次遇到时打一行警告——以前它是**静默**降级的，全站国旗一直 ❓ 却不报错，
 * 排查起来毫无线索。实在两样都没有，`GET /api/diag` 会把服务端到底看到了什么原样告诉你。
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
export function isPrivateIp(ip) {
  if (!ip) return true
  /**
   * ⚠️ 先削 `::ffff:` 再判。
   *
   * 下面那些正则全是 `^` 锚定的裸 v4 前缀，`::ffff:127.0.0.1` 一条都不命中 ——
   * 会被当成公网地址。而 `index.js` 的 `httpServer.listen(PORT)` 不带 host，
   * Node 双栈绑 `::`，同机 nginx 走 IPv4 回环连进来拿到的就正是这个形状。
   *
   * 本模块内部的调用方都先过了 normalizeIp（它削了），所以以前没暴露；
   * 但 sseGuard 那种按 IP 限流的外部调用方一旦直接传原始地址，
   * 判错的后果是**全站访客塌缩成同一个桶**、一起被限死。在这儿兜住，比指望每个调用方都记得 normalize 靠谱。
   * Docker / k8s 的 `::ffff:172.17.0.1`、`::ffff:10.x` 同理。
   */
  ip = String(ip).replace(/^::ffff:/i, '')
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
  const ip = resolveClientIp(directAddress, headers)
  warnIfCdnEdgeIp(ip, headers)
  return ip
}

function resolveClientIp(directAddress, headers) {
  const direct = normalizeIp(directAddress)
  if (!PROXY_TRUSTED || !isPrivateIp(direct)) return direct
  const xff = headers['x-forwarded-for'] || headers['X-Forwarded-For'] || ''
  const hops = String(xff).split(',').map(normalizeIp).filter(Boolean)
  for (let i = hops.length - 1; i >= 0; i--) if (!isPrivateIp(hops[i])) return hops[i]
  const real = normalizeIp(headers['x-real-ip'])
  return real && !isPrivateIp(real) ? real : direct
}

/** 只提示一次：这个进程的配置要么对要么错，刷一屏没有意义 */
let cdnEdgeWarned = false

/**
 * ⚠️ 自查：我们采用的 IP 是不是 **CDN 边缘节点**，而不是访客。
 *
 * 上面「取 XFF 最后一段」的设计**只在 nginx 直面用户时成立** —— 那时候最后一段是
 * nginx 亲眼看到的对端，伪造不了。但站点在 Cloudflare 后面时，nginx 看到的对端就是
 * **CF 的 anycast 节点**，于是 `$proxy_add_x_forwarded_for` 追加上去的最后一段是 CF 的地址，
 * 真实访客反而在前面那一段。
 *
 * 2026-09-07 线上实测就是这个状态（`xff: "34.162.230.222, 104.22.100.106"`，
 * 采用了后者 —— 104.22.x.x 是 Cloudflare 的段），后果一串，而且**每一条都不报错**：
 *
 *   · 每 IP 房间上限（直播 / 联机）对着 CF 节点算 → **同一个 CF 机房后面的所有玩家共用一个额度**
 *   · `maxMembersPerIp` 同理 → 同一机房后面只有几个人能进同一个联机房
 *   · 房间卡片的国旗查的是 CF anycast 地址（多半登记在美国）→ **全站玩家都显示同一个国家**，
 *     而且因为 `resolveCountry` 先用 IP、查到了就不再看网关头，那份**正确**的
 *     `CF-IPCountry` 永远轮不上
 *   · `clientKey` / 限流、匿名评分的 `anon_ip` 一并塌缩成按机房而不是按人
 *
 * 判据不需要维护 CF 的 IP 段：**`CF-Connecting-IP` 这个头存在**就说明流量确实过了 Cloudflare，
 * 而它的值就是 CF 认定的访客地址。它和我们采用的值不一致 = nginx 那一行透传写错了。
 *
 * 这里**只告警、不改行为** —— 直接改成信 `CF-Connecting-IP` 会开一个伪造口子
 * （源站没锁到 CF 的 IP 段时，谁都能直连源站自报地址），
 * 而现在这套「取最后一段」至少是伪造不了的。修法在 nginx 那一行，见下面的提示。
 */
function warnIfCdnEdgeIp(ip, headers) {
  if (cdnEdgeWarned) return
  const cf = normalizeIp(headers['cf-connecting-ip'] || headers['CF-Connecting-IP'])
  if (!cf || !ip || cf === ip) return
  cdnEdgeWarned = true
  console.warn(
    `[presence] 采用的客户端 IP 是 ${ip}，但 Cloudflare 说访客是 ${cf} —— ` +
      '我们拿到的是 CF 边缘节点的地址，不是人。后果：每 IP 房间上限 / 限流退化成「按机房共用」，' +
      '房间卡片的国旗全站显示同一个国家。修法是把 nginx 里那一行换掉（每个 location 都要）：' +
      'proxy_set_header X-Forwarded-For $http_cf_connecting_ip;  ' +
      '（并把源站防火墙锁到 Cloudflare 的 IP 段，否则这个头可以被直连源站的人伪造）。详见 GET /api/diag',
  )
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

/**
 * 网关在边缘加的国家头。
 *
 * 站点在 Cloudflare 后面时这个头**一定有**，而且是 CF 按它自己看到的对端算的，
 * 比我们这边查 IP 还准 —— 评论那边早就在用了（routes/comments.js）。
 * presence 以前完全没看它：于是反代少一行 X-Forwarded-For，IP 那一路查不出东西，
 * 明明手边就有现成的国家却还是显示 ❓。这是**最常见的那种「配置差一行、功能全废」**，
 * 多这一道兜底就能免掉。
 *
 * 'XX' 是 CF 表示「不知道」，'T1' 是 Tor 出口 —— 两个都不是国家，
 * 拿去画国旗会渲染成方框乱码，一律当查不到。
 */
const GATEWAY_COUNTRY_HEADERS = ['cf-ipcountry', 'x-vercel-ip-country', 'x-country-code']
const NOT_A_COUNTRY = new Set(['XX', 'T1', 'ZZ', 'AP', 'EU'])

export function countryFromHeaders(headers = {}) {
  for (const name of GATEWAY_COUNTRY_HEADERS) {
    const raw = headers[name]
    if (typeof raw !== 'string') continue
    const code = raw.trim().toUpperCase()
    if (/^[A-Z]{2}$/.test(code) && !NOT_A_COUNTRY.has(code)) return code
  }
  return null
}

/**
 * 一次把国家定下来：先按真实 IP 查离线库，查不到再用网关的头兜底。
 *
 * 顺序是有讲究的：IP 查库对**每一跳**都成立（自建反代、没有 CF 的部署也能用），
 * 网关头只在走了那家网关时才有。所以先本地、后网关。
 */
let ipBlindWarned = false
export function resolveCountry(ip, headers = {}) {
  const byIp = countryFromIp(ip)
  if (byIp) return byIp
  const byHeader = countryFromHeaders(headers)
  if (byHeader) return byHeader
  // 只提示一次，而且只在「IP 是内网 + 网关也没给」时提示 —— 这两样同时没有，
  // 基本可以断定是反代少配了头，而不是某个用户的地址查不到
  if (!ipBlindWarned && isPrivateIp(ip) && geoReader) {
    ipBlindWarned = true
    console.warn(
      '[presence] 看到的客户端地址是内网/回环（' + (ip || '空') + '），网关也没给国家头 —— ' +
        '房间卡片上的国旗会一直是 ❓。反代请把真实 IP 透传下来（socket.io / netplay 那个 location 也要加）：' +
        '直面用户时用 `proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;`；' +
        '**在 Cloudflare 后面时必须用 `proxy_set_header X-Forwarded-For $http_cf_connecting_ip;`** —— ' +
        '前者追加的是 CF 边缘节点的地址，会让全站塌缩成同一个「访客」。详见 GET /api/diag',
    )
  }
  return null
}

/** 离线国家库有没有加载上。/api/diag 用它区分「库没装好」和「这个 IP 查不到」 */
export function geoReady() {
  return geoReader !== null
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

/**
 * 连上之后多久主动探一次 RTT。
 *
 * 光等 engine.io 自己的心跳，头一个采样要等满一个 pingInterval —— 也就是房间卡片
 * 开出来的头 10 秒（线上默认 25 秒）网络那格必然是 ❓。而开房的人恰恰就在这几秒里
 * 盯着自己的卡片看，于是「网络永远显示不出来」成了个稳定的观感。
 *
 * engine.io 的 ping 是**协议层**的：服务端发一个 ping 包，任何 engine.io v4 客户端都会
 * 自动回 pong，不需要对方的应用代码配合 —— 联机那个改不动的 EmulatorJS 客户端也一样。
 * 所以这里在连上后立刻补发一个，1 秒内就能把格子填上。实测 polling / websocket 都有效。
 * 走的是引擎内部方法，包在 try 里：哪天 engine.io 改了，最差也就是退回等正常心跳。
 */
const EARLY_RTT_MS = Number(process.env.PRESENCE_EARLY_RTT_MS || 250)
/** 第一次探测的 pong 要是丢了，再补一次；两次都没有就老实等心跳 */
const EARLY_RTT_RETRY_MS = 1_500

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

  /** 主动补一个心跳包，见 EARLY_RTT_MS */
  const probe = () => {
    if (rtt !== null) return
    try {
      if (conn.readyState === 'open' && typeof conn.sendPacket === 'function') conn.sendPacket('ping')
    } catch {
      /* 引擎内部 API 变了就算了，等正常心跳 */
    }
  }
  const early = setTimeout(probe, EARLY_RTT_MS)
  const retry = setTimeout(probe, EARLY_RTT_RETRY_MS)
  early.unref?.()
  retry.unref?.()
  conn.once?.('close', () => {
    clearTimeout(early)
    clearTimeout(retry)
  })

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
  // 先按真实 IP 查库，查不到用网关的国家头兜底（见 resolveCountry）
  const country = resolveCountry(clientIpFrom(socket?.handshake?.address, headers), headers)
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
  return { device, country: resolveCountry(ip, req?.headers || {}), net: netFromRtt(rtt), rtt }
}
