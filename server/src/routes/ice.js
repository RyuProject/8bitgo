/**
 * ICE 配置下发：GET /api/netplay/ice
 *
 * 为什么要有这个接口 —— 两个原因：
 *
 * 1. **连通率**。P2P 直连要穿 NAT，只靠 STUN 大约有一到两成的组合连不通
 *    （对称型 NAT、部分企业网与移动网络），必须有 TURN 中继兜底。
 *    ⚠️ 更要命的是 STUN 本身可达不可达：内置的默认几台是 Google / Twilio 的，
 *    在部分地区**根本不可达** —— 那种情况下浏览器**连自己的公网地址都问不出来**，
 *    只有一堆 host 候选，除非两边在同一个路由器下面，否则必然连不通。
 *    配上 Cloudflare 那一路会顺带带来 stun.cloudflare.com，这个问题一并解决。
 *
 * 2. **凭证不能写进前端包**。以前 TURN 账号密码是通过 VITE_NETPLAY_ICE 打进 JS 的，
 *    任何人打开 DevTools 就能抄走，拿你的 TURN 当免费流量中转。
 *    这里改成按请求现算 / 现取一份**短期凭证**，密码永远不出服务器。
 *
 * ── 三种 TURN，可以同时配，按这个顺序下发 ──────────────────
 *
 *   1. 自建 coturn      TURN_URLS + TURN_SECRET            static-auth-secret，服务端现算 HMAC
 *   2. 托管（固定账号）  TURN_BACKUP_URLS + USERNAME/CREDENTIAL 或 BACKUP_SECRET
 *   3. Cloudflare       TURN_CF_KEY_ID + TURN_CF_API_TOKEN  服务端向 CF 现领短期凭证
 *
 * 全都会**一起**下发给浏览器。WebRTC 不是「主的挂了才用备的」那种串行回退 ——
 * 它从所有 ICE 服务器一起收集候选，然后按优先级配对：中继（relay）候选的优先级本来就最低，
 * 只有直连全部失败时才会用上；两个中继之间，排在前面的那个本地优先级更高，所以自建那路会先被试。
 * 也就是说兜底那路只在「直连不通 **且** 自建 coturn 这一路也配不上」时才吃流量 ——
 * 正是兜底该有的行为，而且自建挂掉的那段时间站点不会整个瘫掉。
 *
 * ⚠️ **Cloudflare Realtime 有两个完全不同的产品，别拿错：**
 *   · TURN Service —— 就是这里用的。仪表盘里建一个 **TURN key**，给你 Key ID + API token，
 *     服务端拿它去换短期 TURN 凭证。这才是能塞进 iceServers 的东西。
 *   · Realtime SFU —— 建出来的是 **App ID + App Secret**，走 /v1/apps/<id>/sessions，
 *     是个媒体服务器（大家把流推给它、再从它那儿拉），**不是 TURN，塞不进 iceServers**。
 *     它能解决的是另一个问题（房主上行扛不住十几路观众），要改的是整套推拉流架构。
 *
 * 一个都没配时退回纯 STUN，功能照常，只是连通率低一些 —— hasTurn 会如实报 false，
 * 前端据此把「连不上」的提示说得具体点，而不是让人对着转圈瞎猜。
 */
import { Router } from 'express'
import { createHmac } from 'node:crypto'
import { registerTurnPath, turnHealthSnapshot, turnPathDown } from '../turnProbe.js'

export const iceRouter = Router()

const DEFAULT_STUN = [
  'stun:stun.l.google.com:19302',
  'stun:stun1.l.google.com:19302',
  'stun:global.stun.twilio.com:3478',
]

const list = (v) =>
  String(v || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)

/** coturn 的短期凭证：用户名里带过期时间，密码是它的 HMAC */
function turnCredentials(secret, ttlSec, label) {
  const expiry = Math.floor(Date.now() / 1000) + ttlSec
  const username = `${expiry}:${label}`
  const credential = createHmac('sha1', secret).update(username).digest('base64')
  return { username, credential, expiry }
}

/* ---------------- Cloudflare Realtime TURN ---------------- */

/**
 * 覆盖用（测试里指向本地假服务）。正式环境不要动。
 * 和这个文件里其它配置一样**按请求现读** —— 写成模块级常量的话，
 * 测试里改了 env 也已经晚了（模块早加载完了），线上改配置也得重启进程。
 */
const cfApiBase = () => process.env.TURN_CF_API_BASE || 'https://rtc.live.cloudflare.com/v1'
/** 向 CF 领一份凭证的有效期。它家默认给 86400（24 小时） */
const cfTtl = () => Math.max(600, Math.min(172_800, Number(process.env.TURN_CF_TTL_SEC) || 86_400))
/**
 * 领凭证的超时。这个接口在**开局的关键路径上** —— 玩家点开始游戏就要等它。
 * CF 那边抽风的话宁可这一轮没有 CF 中继，也不能让所有人卡在这里。
 */
const cfTimeoutMs = () => Number(process.env.TURN_CF_TIMEOUT_MS || 2_500)
/** 快过期多久就重新领。凭证 24 小时有效，提前 10 分钟换足够 */
const CF_REFRESH_MARGIN_SEC = 600
/** 领失败之后多久才再试。CF 挂了的时候不能每个请求都去撞一次、每次多等 2.5 秒 */
const CF_COOLDOWN_MS = 30_000

/**
 * 缓存住领来的那份，别每次请求都去调 CF 的接口。
 *
 * 按「key + 接口地址 + ttl」缓存：运维换了 key（或者轮换了 token）之后，
 * 缓存和冷却计时都要跟着作废 —— 否则旧凭证还会挂着用到过期，换 key 等于没换。
 */
let cfState = { key: '', cache: null, inflight: null, failedAt: 0, warned: false }

function cfSlot(keyId, base, ttl) {
  const key = `${keyId}|${base}|${ttl}`
  if (cfState.key !== key) cfState = { key, cache: null, inflight: null, failedAt: 0, warned: false }
  return cfState
}

/**
 * 向 Cloudflare 领一份短期 TURN 凭证。
 *
 *   POST /v1/turn/keys/<keyId>/credentials/generate-ice-servers
 *   Authorization: Bearer <api token>
 *   {"ttl": 86400}
 *
 * ⚠️ **响应的分组方式不要赌。** CF 文档给的示例是两条
 * （`[{urls:[stun...]}, {urls:[turn...], username, credential}]`），
 * 而仪表盘上「如何创建凭据」给的示例是**一条**里 stun 和 turn 混排、凭证挂在这一条上。
 * 两种都见过，将来还可能再变。所以这里**不按条目结构解析，按 URL 的 scheme 拆**：
 * `stun:` 归 STUN 组（不需要凭证），`turn:` / `turns:` 归 TURN 组（带上这一条的凭证）。
 * 怎么分组都能解析对。
 *
 * 顺带：CF 自己会带 stun.cloudflare.com，我们把它并进 STUN 那一格 ——
 * 顺手解决「默认那几台 STUN 在部分地区不可达」的老问题，这是配 CF 的额外收益。
 *
 * 拿不到就返回 null：调用方照常下发其它几路，绝不让这一路的故障拖垮整个接口。
 */
async function cloudflareIce() {
  const keyId = (process.env.TURN_CF_KEY_ID || '').trim()
  const token = (process.env.TURN_CF_API_TOKEN || '').trim()
  if (!keyId || !token) return null

  const ttl = cfTtl()
  const base = cfApiBase()
  const st = cfSlot(keyId, base, ttl)
  const now = Math.floor(Date.now() / 1000)
  if (st.cache && st.cache.expiry - now > CF_REFRESH_MARGIN_SEC) return st.cache
  if (st.inflight) return st.inflight
  if (Date.now() - st.failedAt < CF_COOLDOWN_MS) return st.cache // 刚失败过，先用旧的（可能是 null）

  st.inflight = (async () => {
    try {
      const res = await fetch(`${base}/turn/keys/${encodeURIComponent(keyId)}/credentials/generate-ice-servers`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ ttl }),
        signal: AbortSignal.timeout(cfTimeoutMs()),
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const data = await res.json()
      // iceServers 可能是数组，也可能被写成单个对象 —— 两种都收
      const entries = Array.isArray(data?.iceServers)
        ? data.iceServers
        : data?.iceServers
          ? [data.iceServers]
          : []
      const stunUrls = []
      const turns = []
      for (const e of entries) {
        const urls = Array.isArray(e?.urls) ? e.urls : e?.urls ? [e.urls] : []
        const turnUrls = []
        for (const raw of urls) {
          const u = String(raw)
          if (u.startsWith('stun:')) stunUrls.push(u)
          else if (u.startsWith('turn:') || u.startsWith('turns:')) turnUrls.push(u)
        }
        // TURN 必须带凭证才有用：没凭证的 turn: 交给浏览器只会报错
        if (turnUrls.length && e?.username && e?.credential) {
          turns.push({ urls: turnUrls, username: String(e.username), credential: String(e.credential) })
        }
      }
      if (!turns.length) throw new Error('响应里没有带凭证的 TURN 地址')
      st.cache = { stunUrls, turns, expiry: now + ttl }
      st.failedAt = 0
      st.warned = false
      return st.cache
    } catch (e) {
      st.failedAt = Date.now()
      if (!st.warned) {
        st.warned = true
        console.warn('[ice] 向 Cloudflare 领 TURN 凭证失败（冷却 30 秒后再试，其余几路不受影响）：', e?.message || e)
      }
      return st.cache // 旧的还没过期就先用着；没有就是 null
    } finally {
      st.inflight = null
    }
  })()
  return st.inflight
}

/**
 * 自建 / 托管那两路短期凭证的有效期。
 *
 * ⚠️ 这个值同时是**「ICE 接口被缓存多久还不至于出事」的上限**：coturn 校验 username 里的
 * 时间戳，过期即 401。默认 3600 意味着缓存超过一小时那一路就对所有人废了。
 * 前面那层 CDN 只要没把 /api/ 排除出缓存规则，就应该把这个值调大（43200 = 12 小时），
 * 让自建这路和 CF 那路（TTL 24 小时）的抗缓存能力对齐 ——
 * 别再出现「CF 活着、自建早死了」这种半死不活最难查的状态。
 */
const iceTtl = () => Math.max(300, Math.min(86400, Number(process.env.TURN_TTL_SEC) || 3600))

/* ---------------- 三路 TURN 的配置读取（探活和下发共用一份） ---------------- */

const selfHostedUrls = () => list(process.env.TURN_URLS)
const managedUrls = () => list(process.env.TURN_BACKUP_URLS)

/** 探活时用的签名函数：**每次现签**，不能存签好的凭证（见 turnProbe.js 里 registerTurnPath 的注释） */
function mintSelfHosted() {
  const secret = (process.env.TURN_SECRET || '').trim()
  if (!secret) throw new Error('TURN_SECRET 没配')
  return turnCredentials(secret, iceTtl(), 'probe')
}

function mintManaged() {
  const secret = (process.env.TURN_BACKUP_SECRET || '').trim()
  if (secret) return turnCredentials(secret, iceTtl(), 'probe')
  const username = (process.env.TURN_BACKUP_USERNAME || '').trim()
  const credential = (process.env.TURN_BACKUP_CREDENTIAL || '').trim()
  if (!username || !credential) throw new Error('托管那路的凭证没配全')
  return { username, credential }
}

async function mintCloudflare() {
  const cf = await cloudflareIce()
  const t = cf?.turns?.[0]
  if (!t) throw new Error('CF 那路还没领到凭证')
  return { username: t.username, credential: t.credential }
}

/**
 * 把当前配到的几路 TURN 登记给探针。
 *
 * 每次请求都调一遍（很便宜，就是覆盖几个 Map 条目），这样运维改了 env 不用重启也能生效 ——
 * 和这个文件里「所有配置按请求现读」的约定一致。src/index.js 启动时也调一次，
 * 免得开站到第一个玩家之间那段时间探针没东西可探。
 */
export async function registerTurnProbeTargets() {
  const self = selfHostedUrls()
  registerTurnPath('self-hosted', (process.env.TURN_SECRET || '').trim() ? self : [], mintSelfHosted)

  const managed = managedUrls()
  const hasManagedCred =
    (process.env.TURN_BACKUP_SECRET || '').trim() ||
    ((process.env.TURN_BACKUP_USERNAME || '').trim() && (process.env.TURN_BACKUP_CREDENTIAL || '').trim())
  registerTurnPath('managed', hasManagedCred ? managed : [], mintManaged)

  // CF 的地址是它现发的，所以要先有一份凭证才知道探哪儿
  let cfUrls = []
  try {
    const cf = await cloudflareIce()
    cfUrls = (cf?.turns || []).flatMap((t) => t.urls)
  } catch {
    cfUrls = []
  }
  registerTurnPath('cloudflare', cfUrls, mintCloudflare)
}

iceRouter.get('/', async (req, res) => {
  const ttl = iceTtl()
  // 标签只用来在 coturn 日志里区分来源，不参与鉴权，所以放个粗粒度的标识就行
  const label = String(req.query.u || 'guest').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 24) || 'guest'

  /** 各路凭证的过期时间。前端按**最早**的那个安排续期，不然先过期的那路会静默失效 */
  const expiries = []
  /** 哪几路真的生效了。运维自查用：线上打开这个接口就知道兜底到底配上没有 */
  const turnSources = []

  // Cloudflare 那一路要先取（异步），它还会顺带给我们两台 STUN
  let cf = null
  try {
    cf = await cloudflareIce()
  } catch {
    cf = null // cloudflareIce 内部已经兜过了，这里只是再保一层：绝不让它 500
  }

  const stun = list(process.env.STUN_URLS)
  const stunUrls = [...(stun.length ? stun : DEFAULT_STUN), ...(cf?.stunUrls ?? [])]
  const iceServers = [{ urls: [...new Set(stunUrls)] }]

  /**
   * 三路先各自算出来，**最后再决定发哪几路** —— 切换就发生在这一步。
   *
   * WebRTC 那边没有串行回退（所有服务器一起收集候选），所以「自建挂了换 CF」
   * 唯一能做手脚的地方就是这里：探针说某一路是死的，就干脆不把它交给浏览器。
   * 好处不只是省掉那条路白耗的候选收集时间，更重要的是**故障不再是静默的**：
   * turnSources 会少掉那一路，turnHealth 里写着为什么。
   */
  const candidates = []

  // ── 1. 自建 coturn ──
  const turnUrls = selfHostedUrls()
  const secret = (process.env.TURN_SECRET || '').trim()
  if (turnUrls.length && secret) {
    const cred = turnCredentials(secret, ttl, label)
    candidates.push({
      name: 'self-hosted',
      server: { urls: turnUrls, username: cred.username, credential: cred.credential },
      expiry: cred.expiry,
    })
  }

  // ── 2. 托管服务（固定账号密码，或同样的 HMAC 约定）──
  const backupUrls = managedUrls()
  const backupSecret = (process.env.TURN_BACKUP_SECRET || '').trim()
  const backupUser = (process.env.TURN_BACKUP_USERNAME || '').trim()
  const backupCred = (process.env.TURN_BACKUP_CREDENTIAL || '').trim()
  if (backupUrls.length) {
    if (backupSecret) {
      const cred = turnCredentials(backupSecret, ttl, label)
      candidates.push({
        name: 'managed',
        server: { urls: backupUrls, username: cred.username, credential: cred.credential },
        expiry: cred.expiry,
      })
    } else if (backupUser && backupCred) {
      // 固定账号密码：不会过期，所以不进 expiries
      candidates.push({
        name: 'managed',
        server: { urls: backupUrls, username: backupUser, credential: backupCred },
      })
    }
  }

  // ── 3. Cloudflare Realtime TURN ──
  if (cf?.turns?.length) {
    for (const t of cf.turns) {
      candidates.push({
        name: 'cloudflare',
        server: { urls: t.urls, username: t.username, credential: t.credential },
        expiry: cf.expiry,
      })
    }
  }

  /**
   * ⚠️ **安全阀：摘掉之后一路都不剩的话，照旧全发。**
   *
   * 探针是**从服务器**发出去的，所以它能可靠地判「坏」，判不了「全世界都到得了」。
   * 万一它把唯一一路误判死了，宁可发一条可能坏的中继，也不能让所有人退回纯 STUN
   * （只有 host/srflx 候选时，一到两成的玩家组合是**必然**连不通的）。
   * 这种时候 hasTurn 如实报 false —— 观众端据此把「网络之间没有通路」和「主播下播了」分开。
   */
  const downNames = new Set(candidates.filter((c) => turnPathDown(c.name)).map((c) => c.name))
  const kept = candidates.filter((c) => !downNames.has(c.name))
  const serving = kept.length ? kept : candidates
  const turnDropped = kept.length ? [...downNames] : []

  for (const c of serving) {
    iceServers.push(c.server)
    if (c.expiry) expiries.push(c.expiry)
    if (!turnSources.includes(c.name)) turnSources.push(c.name)
  }

  // 顺手把「现在配到了哪几路」同步给探针（很便宜，改了 env 不用重启）。
  // **不 await** —— 这个接口在开局的关键路径上，一毫秒都不该为探活的簿记等。
  registerTurnProbeTargets().catch(() => {})

  /**
   * 凭证会过期，别让 CDN / 浏览器缓存住。
   *
   * ⚠️ 光有 `Cache-Control` 不够。2026-09-07 线上实测：这个接口被前面那层缓存了
   * **13.7 小时**，发给所有人的都是十几个小时前签的凭证 —— 自建 coturn 的 username
   * 是 `<过期时间戳>:label`，过期即 401，那一路对所有人都废了，而 hasTurn 照报 true。
   * Cloudflare 的 "Cache Everything" 规则会盖掉源站的 `Cache-Control`，
   * 但它认这两个更高优先级的头（Cloudflare-CDN-Cache-Control > CDN-Cache-Control > Cache-Control）。
   *
   * 这只是第二道闸：**真正该做的是把 /api/ 排除出缓存规则**，
   * 而且 Edge TTL 被设成固定值时这几个头一样会被无视 —— 所以客户端那边还带了
   * 分钟桶参数兜底（见 src/services/netplay.ts 的 iceBucket）。
   */
  res.set('Cache-Control', 'no-store')
  res.set('CDN-Cache-Control', 'no-store')
  res.set('Cloudflare-CDN-Cache-Control', 'no-store')
  res.json({
    iceServers,
    /**
     * 有没有**活着的** TURN 兜底。前端据此决定要不要提示「可能连不通」。
     * 注意：探针把所有路都判死时 iceServers 里其实还留着它们（见上面那个安全阀），
     * 但这里如实报 false —— 别骗观众端「有中继」。
     */
    hasTurn: kept.length > 0,
    /** 配了几路 TURN */
    turnCount: turnSources.length,
    /** 分别是哪几路（self-hosted / managed / cloudflare）—— 自查用 */
    turnSources,
    /**
     * 探活把哪几路摘掉了。**这就是「自动切换」发生过的凭据** ——
     * 线上一 curl 就知道：`turnDropped: ["self-hosted"]` 意味着现在 CF 在扛全部中继流量。
     * 详细原因（错误码 + 该去查哪一行配置）在 GET /api/diag 的 turn 段里。
     */
    turnDropped,
    /** 每一路现在的状态：up / down / unknown（还没探过，一律按能用处理）*/
    turnHealth: turnHealthSnapshot(),
    /** 最早的凭证过期时间（unix 秒）；0 表示没有会过期的凭证，无需续期 */
    expiry: expiries.length ? Math.min(...expiries) : 0,
    ttl,
  })
})
