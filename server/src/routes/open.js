/**
 * 开放平台 · 应用级接口 `/api/open/v1/*`
 *
 * 面向第三方：用 **AppID + key**（client_id + client_secret）换一枚应用级令牌，
 * 然后读游戏元数据、封面、ROM 短期凭据、嵌入播放器地址。
 * 用户相关的那半（OIDC 授权码 + PKCE）在 `routes/oauth.js`，两者共用同一套令牌与 scope。
 *
 * ## 三条不能动的规矩
 *
 * 1. **令牌与站内的互不相认**。见 `open/tokens.js` 的文件头 —— 那是这套东西唯一一个
 *    「错一次全盘皆输」的点。这里只做一件相关的事：中间件只认 `verifyOpenToken`，
 *    绝不去调 `requireUser`，也绝不复用任何站内路由对象。
 * 2. **输出走 `open/mapper.js` 的白名单**。`mappers.js` 那份是给自己人用的，
 *    带着对象 key 原文和后台运行参数。
 * 3. **CORS 单独一套**。第三方站点的浏览器会直接调这些接口，所以要放开到任意 Origin；
 *    但**绝不能**把站内的 `ALLOWED_ORIGINS` 改成 `*` —— 那会把 `/api/me`、`/api/admin`
 *    一起放开。两套策略分开写，就是下面那个 `openCors`。
 */
import express, { Router } from 'express'
import { listGames, recordPlay as recordGamePlay } from '../games-repo.js'
import { ping, query } from '../db.js'
import { take, isMeaningfulIp } from '../rateLimit.js'
import { assetPublicUrl, publicSiteUrl } from '../site-urls.js'
import { CACHE } from '../cache.js'
import { clientIpFrom } from '../presence.js'
import { openConfig } from '../open/config.js'
import { authenticateApp, readClientCredentials } from '../open/apps.js'
import { issueAppToken, issueUserToken, verifyOpenToken, OPEN_ACCESS_TTL_SEC } from '../open/tokens.js'
import {
  issueLivePublisherToken,
  LIVE_PUBLISHER_TTL_SEC,
} from '../open/live-publisher.js'
import {
  DEVICE_CODE_TTL_SEC,
  DEVICE_POLL_INTERVAL_SEC,
  createDeviceAuth,
  pollDeviceAuth,
} from '../open/device.js'
import { favIds, recentIds } from '../userdata.js'
import { saveCoords } from './saves.js'
import { APP_SCOPES, formatScopes, hasScope, missingScopes, parseScopes } from '../open/scopes.js'
import { openGame, openPage } from '../open/mapper.js'
import { OPEN_PLATFORMS } from '../open/platforms.js'
import { OPEN_GENRES, OPEN_LANGUAGES } from '../open/taxonomy.js'
import { liveCapacity, liveRooms, liveRoom } from '../live.js'
import { netplayRooms, netplayRoom } from '../netplay.js'
import { playIdentityForUser } from '../playcount.js'
import { netplayGameId } from '../../../shared/netplay-game-id.js'
import { listPublicCollections, getPublicCollection } from '../routes/collections.js'
import { normalizeLang, pickRom } from '../open/i18n.js'
import { ROM_GRANT_TTL_SEC, EMBED_TTL_SEC, signEmbed, signRomGrant, verifyRomGrant } from '../open/sign.js'
import { canRedeemSandboxRom, isSandboxRomSample, listSandboxRomSamples, romAccessForApp } from '../open/sandbox-roms.js'
import { recordRecent } from '../userdata.js'

export const openRouter = Router()

/* ---------------- CORS：只给 /api/open/*，和站内白名单是两套 ---------------- */

openRouter.use((req, res, next) => {
  res.set('Access-Control-Allow-Origin', '*')
  res.set('Access-Control-Allow-Headers', 'Authorization, Content-Type')
  res.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
  // 放开到任意 Origin 的接口**一律不带 cookie**：Bearer 走 header，天然没有 CSRF 面。
  // 这里显式不发 Allow-Credentials —— 带上它 + '*' 浏览器本来也会拒，但写明白省得有人去「修」。
  res.set('Vary', 'Origin')
  if (req.method === 'OPTIONS') return res.sendStatus(204)
  next()
})

/** OAuth 风格的错误体，现成的库能直接解析 */
function fail(res, status, error, description, extra) {
  return res.status(status).json({
    error,
    error_description: description,
    error_uri: `${publicSiteUrl()}/developers/docs/errors#${error}`,
    ...(extra || {}),
  })
}

/**
 * token 端点的请求体解析。
 *
 * ⚠️ **RFC 6749 §4.1.3 规定 token 端点收的是 `application/x-www-form-urlencoded`**，
 * 而这个应用全局只挂了 `express.json`（index.js）—— 于是标准写法发过来
 * `req.body` 是空的、`grant_type` 读不到，回一句 `400 unsupported_grant_type`。
 *
 * 现成的 OAuth 客户端库默认就发 form-encoded，**在这里一律会失败**，
 * 而那句错误里完全看不出真正的原因：它说的是「不支持这个 grant_type」，
 * 可调用方明明传了 `client_credentials`。不抓包根本查不出来。
 *
 * 所以在这一条路由上单独补一个解析器。JSON 那种写法继续照收 ——
 * 上游 express.json 已经解好了，content-type 对不上时这个解析器会跳过、不动 req.body。
 *
 * **不挂全局**，两个理由：
 *   · 那会让站内每一个 POST/PUT 都接受表单体，而跨域表单提交是不触发预检的
 *     「简单请求」—— 为了一个端点的兼容性平白多出一整个 CSRF 面。
 *   · 限额也该单独给：这个请求体最多几百字节，没有理由跟着全局那个 4MB 走。
 */
const tokenBody = express.urlencoded({ extended: false, limit: '16kb' })

/* ---------------- 系统：健康检查（公开，无需令牌） ---------------- */

/**
 * `GET /v1/health` —— 服务存活 + 数据库连通性探测。
 *
 * 仿 GGEMU 的 `/api/health`：公开、匿名、CORS 放开，方便监控和第三方程序直接探。
 * 故意**不挂 requireApp**：健康检查如果被令牌限流挡住，就探不出真实的「服务挂了」。
 * 回的形状对齐 `/api/health`（`{ service, db }`）再多带一个 `timestamp`，
 * 便于调用方判断探测时差。
 */
openRouter.get('/v1/health', async (req, res) => {
  const dbOk = await healthProbe()
  const status = dbOk ? 200 : 503
  res.status(status).json({
    service: '8bitgo-open',
    db: dbOk,
    timestamp: new Date().toISOString(),
  })
})

/**
 * ping 的结果缓存 + 单飞。**这不是性能优化，是可用性**。
 *
 * 这条接口公开、匿名、不限流（上面那段注释解释了为什么不能限流），
 * 而 `ping()` 每一次都真的从**连接池**借一条连接出去。那个池子是 SSR、直播、
 * 联机房间共用的 —— 也就是说一个 `while true; do curl …; done` 就能把它占满，
 * 一条健康检查接口足以把整站拖下水。而且症状会反过来骗人：站真的开始 503 了，
 * 监控看到的也是 503，于是「健康检查是对的」，没人会怀疑到健康检查本身。
 *
 * 两道一起才够：
 *   · **TTL**：5 秒。监控探针（10~60 秒一次）完全无感，数据库那边封顶在每 5 秒一次。
 *   · **单飞**：只有 TTL 挡不住「缓存冷的那一刻并发打进来 N 条」——
 *     而并发打进来正是要防的事。同一时刻最多一次真的探测在飞，其余请求等它的结果。
 *
 * 代价：数据库刚恢复时，最多 5 秒之后这条接口才会由 503 变回 200。
 */
const HEALTH_TTL_MS = 5000
let healthCache = { at: 0, ok: false }
let healthInFlight = null

function healthProbe() {
  if (Date.now() - healthCache.at < HEALTH_TTL_MS) return Promise.resolve(healthCache.ok)
  if (!healthInFlight) {
    healthInFlight = (async () => {
      let ok = false
      try {
        ok = await ping()
      } catch {
        ok = false
      }
      healthCache = { at: Date.now(), ok }
      /*
        ⚠️ **这一行不能少。** 漏了它 `healthInFlight` 永远非空，
        于是这个函数从第二次调用起一直返回**第一次那个已经落定的 promise** ——
        数据库真的挂了，这条接口也会永远回 200。
        比「没有缓存」糟得多：没有缓存只是慢，这个是**健康检查本身在撒谎**。
        （变异测试实测过：只删这一行，TTL 那条用例照样绿 ——
         所以下面 expireHealthCache 刻意**不碰** healthInFlight，见那段注释。）
      */
      healthInFlight = null
      return ok
    })()
  }
  return healthInFlight
}

/**
 * 只给测试用：把缓存**过期掉**（不是「重置整个状态」）。
 *
 * ⚠️ 刻意不动 `healthInFlight`。测试要问的是「TTL 到了之后会不会真的再探一次」，
 * 而那件事成立的前提正是上面那行 `healthInFlight = null` 还在。
 * 这里要是顺手把 in-flight 也清了，就等于替被测代码把它复位 ——
 * 那行删掉测试也不会红。
 */
export function expireHealthCache() {
  healthCache = { at: 0, ok: false }
}

/* ---------------- 设备码流程（RFC 8628） ---------------- */

/** 协议规定的 grant_type 值，一个字都不能改 */
export const DEVICE_GRANT = 'urn:ietf:params:oauth:grant-type:device_code'

/**
 * 轮询时那几种「还不行」的说明。
 * ⚠️ `authorization_pending` 和 `slow_down` **不是失败** —— 它们的意思是「接着等」。
 * 说清楚是因为接入方最容易在这里写错：把 400 一律当错误退出，
 * 结果就是用户明明在手机上点了同意，设备却已经放弃了。
 */
const DEVICE_ERROR_HINT = {
  authorization_pending: '用户还没在网页上确认，按 interval 接着轮询',
  slow_down: '轮询太快了，把间隔加大一点再继续',
  access_denied: '用户拒绝了这次授权',
  expired_token: '这串码已经过期，重新要一串',
  invalid_grant: 'device_code 无效',
}

/**
 * `POST /api/open/v1/device/code` —— 设备要一串码。
 *
 * 要 AppID + key（和取令牌同一套认证）：设备上本来就存着 key，
 * 而公开客户端那条路我们整个不开（见 §1.1，前端藏不住密钥）。
 */
openRouter.post('/v1/device/code', tokenBody, async (req, res, next) => {
  try {
    const cfg = openConfig()
    if (!cfg) return fail(res, 501, 'temporarily_unavailable', '开放平台未启用')

    const { clientId, clientSecret } = readClientCredentials(req)
    // 顺序和取令牌那条一样：先 IP 后 client_id，理由见那边的注释
    const ip = clientIpFrom(req.ip, req.headers)
    if (ip) {
      const byIp = take(`open:device:ip:${ip}`, 60, 3600_000)
      if (!byIp.ok) return rateLimited(res, byIp)
    }
    if (clientId) {
      const byApp = take(`open:device:${clientId}`, 60, 3600_000)
      if (!byApp.ok) return rateLimited(res, byApp)
    }

    const app = await authenticateApp(clientId, clientSecret)
    if (!app) return fail(res, 401, 'invalid_client', 'AppID 或 key 不正确')
    if (app.clientType !== 'confidential') {
      return fail(res, 400, 'unauthorized_client', '公开客户端（无 key）不能用设备码流程')
    }

    /*
      要哪些 scope。规矩和 client_credentials 那边**一模一样**：
      不传就给已获批的全部，传了就必须是子集，**不静默降级**。
      唯一的区别是这里不过滤 APP_SCOPES —— 设备码换来的是用户级令牌，
      user 级 scope 正是它存在的理由。
    */
    let scopes = [...app.approvedScopes]
    if (req.body?.scope) {
      const parsed = parseScopes(req.body.scope)
      if (parsed.unknown.length) return fail(res, 400, 'invalid_scope', `不认识的 scope：${parsed.unknown.join(' ')}`)
      const missing = missingScopes(parsed.scopes, app.approvedScopes)
      if (missing.length) return fail(res, 400, 'invalid_scope', `应用未获批：${missing.join(' ')}`)
      scopes = parsed.scopes
    }
    if (!scopes.length) return fail(res, 400, 'invalid_scope', '这个应用没有任何已获批的权限')

    const made = createDeviceAuth({ appId: app.id, scopes })
    // 待授权表满了。这是我们这边的容量问题，不是调用方做错了什么 —— 按 503 说
    if (!made) return fail(res, 503, 'temporarily_unavailable', '待授权的请求太多，稍后再试')

    const verify = new URL('/open/device', publicSiteUrl())
    const complete = new URL('/open/device', publicSiteUrl())
    complete.searchParams.set('code', made.userCode)
    res.json({
      device_code: made.deviceCode,
      user_code: made.userCode,
      verification_uri: verify.href,
      /* 带着码的完整地址：能显示二维码的设备直接把它编成码，用户不用手打 */
      verification_uri_complete: complete.href,
      expires_in: DEVICE_CODE_TTL_SEC,
      interval: DEVICE_POLL_INTERVAL_SEC,
    })
  } catch (e) {
    next(e)
  }
})

/* ---------------- 取令牌：AppID + key ---------------- */

/*
  解析失败（畸形、超限）**不用在这里接**：错误顺着 next(err) 走到 index.js 里那道
  openErrorMiddleware，会被翻成 OAuth 形状的错误体。JSON 那一路在全局的
  express.json 里就失败了、根本到不了这个路由，走的也是同一道 —— 两条路同一个出口。

  ⚠️ 这里原本包了一层自己转错误的中间件，和那道守卫**做的是同一件事**：
  删掉它测试一条都不红（变异测试实测）。两份等价的实现摆在两处，
  迟早有人只改其中一处。
*/

/**
 * `POST /api/open/v1/token`
 *
 * 只支持 `grant_type=client_credentials`（应用级）。用户级令牌走 `/api/oauth/token`
 * 的授权码流程 —— **两个入口刻意分开**：混在一起的话，一个写错 grant_type 的请求
 * 会在两套完全不同的安全模型之间滑动，而错误信息又不能说得太细。
 *
 * ⚠️ 这里签出来的令牌**背后没有用户**，所以它永远拿不到 user 级 scope（见 APP_SCOPES）。
 */
openRouter.post('/v1/token', tokenBody, async (req, res, next) => {
  try {
    const cfg = openConfig()
    if (!cfg) return fail(res, 501, 'temporarily_unavailable', '开放平台未启用')

    const { clientId, clientSecret } = readClientCredentials(req)
    /*
      限流按 IP + client_id 两层：只按 app 限，一个坏用户能拖垮整个应用；
      只按 IP 限，应用服务端的出口 IP 会互相挤占。

      ⚠️ **顺序要紧：先 IP，后 client_id。** client_id 是请求体/Basic 里的任意字符串，
      在 authenticateApp 之前它没经过任何验证 —— 先按它建桶的话，每一条伪造 client_id
      的请求都会往限流表里净增一条记录，而且这里的窗口是**一小时**，
      比 ratings 那条（60 秒）恶劣得多：一小时内一条都清不掉。
      先判 IP、超了就出去，未认证的请求就只能撑开有界的 IP key 空间。
    */
    const ip = clientIpFrom(req.ip, req.headers)
    if (ip) {
      const byIp = take(`open:token:ip:${ip}`, 120, 3600_000)
      if (!byIp.ok) return rateLimited(res, byIp)
    }
    if (clientId) {
      const byApp = take(`open:token:${clientId}`, 60, 3600_000)
      if (!byApp.ok) return rateLimited(res, byApp)
    }

    const grant = String(req.body?.grant_type || '')
    if (grant !== 'client_credentials' && grant !== DEVICE_GRANT) {
      return fail(
        res,
        400,
        'unsupported_grant_type',
        `这个端点支持 client_credentials（应用级）和 ${DEVICE_GRANT}（设备码，用户级）`,
      )
    }

    const app = await authenticateApp(clientId, clientSecret)
    // ⚠️ 认不出来一律同一句话：区分「没这个应用」和「密钥不对」就成了 AppID 探针
    if (!app) return fail(res, 401, 'invalid_client', 'AppID 或 key 不正确')
    if (app.clientType !== 'confidential') {
      return fail(res, 400, 'unauthorized_client', '公开客户端（无 key）不能用这个端点取令牌')
    }

    /*
      设备码兑现。RFC 8628 §3.4/§3.5。
      这一支**签的是用户级令牌**（kind='user'，sub=用户 id），所以它能拿到
      library.* / saves.* 这些应用级流程永远拿不到的 scope。
    */
    if (grant === DEVICE_GRANT) {
      const r = pollDeviceAuth(String(req.body?.device_code || ''), { appId: app.id })
      if (!r.ok) {
        // authorization_pending / slow_down 都是 400 —— 协议规定的，不是我们随便定的。
        // 设备拿它们当「接着等」，不是当失败。
        const status = r.error === 'expired_token' || r.error === 'access_denied' ? 400 : 400
        return fail(res, status, r.error, DEVICE_ERROR_HINT[r.error] ?? '', {
          ...(r.error === 'slow_down' ? { interval: DEVICE_POLL_INTERVAL_SEC } : {}),
        })
      }
      const access_token = issueUserToken({
        privateKey: cfg.privateKey,
        kid: cfg.kid,
        issuer: cfg.issuer,
        appId: app.id,
        sub: r.userId,
        scopes: r.scopes,
        ttl: OPEN_ACCESS_TTL_SEC,
      })
      return res.json({
        access_token,
        token_type: 'Bearer',
        expires_in: OPEN_ACCESS_TTL_SEC,
        scope: formatScopes(r.scopes),
      })
    }

    // 不传 scope 就给当前可用的应用级权限；沙箱样本与上产全库仍由后面的状态检查区分。
    const approvedApp = app.approvedScopes.filter((s) => APP_SCOPES.includes(s))
    // 沙箱只把 games.rom 用于站长挑的样本；生产的 approved_scopes 仍须人工审核。
    if (app.status === 'sandbox' && app.requestedScopes.includes('games.rom')) approvedApp.push('games.rom')
    const availableApp = parseScopes(approvedApp.join(' ')).scopes
    let scopes = availableApp
    if (req.body?.scope) {
      const parsed = parseScopes(req.body.scope)
      if (parsed.unknown.length) return fail(res, 400, 'invalid_scope', `不认识的 scope：${parsed.unknown.join(' ')}`)
      const userLevel = parsed.scopes.filter((s) => !APP_SCOPES.includes(s))
      if (userLevel.length) {
        return fail(res, 400, 'invalid_scope', `${userLevel.join(' ')} 需要用户授权，不能用 client_credentials 取`)
      }
      // **不静默降级**：少给一个 scope 却照常发令牌，接入方要到线上功能失效才发现
      const missing = missingScopes(parsed.scopes, availableApp)
      if (missing.length) return fail(res, 400, 'invalid_scope', `应用未获批：${missing.join(' ')}`)
      scopes = parsed.scopes
    }
    if (!scopes.length) return fail(res, 400, 'invalid_scope', '这个应用没有任何应用级权限')

    const access_token = issueAppToken({
      privateKey: cfg.privateKey,
      kid: cfg.kid,
      issuer: cfg.issuer,
      appId: app.id,
      scopes,
      ttl: OPEN_ACCESS_TTL_SEC,
    })
    res.json({
      access_token,
      token_type: 'Bearer',
      expires_in: OPEN_ACCESS_TTL_SEC,
      scope: formatScopes(scopes),
      rom_access: scopes.includes('games.rom') ? (app.status === 'sandbox' ? 'samples' : 'full') : 'none',
    })
  } catch (e) {
    next(e)
  }
})

function rateLimited(res, gate) {
  return res
    .status(429)
    .set('Retry-After', String(gate.retryAfter))
    .json({ error: 'rate_limited', error_description: '请求过于频繁', retry_after: gate.retryAfter })
}

/* ---------------- 鉴权中间件 ---------------- */

/**
 * 匿名（公开接口）的配额。
 *
 * **按分钟，不是按小时**，和取令牌那几条刻意不同，两个理由：
 *   · 语义：这里没有「猜密码」那种需要长时间锁定的事，误伤一个真实用户就要他等一小时，太重；
 *   · 开销：`take` 用的是时间戳数组，上限多大数组就多长。
 *     「一小时 N 万次」意味着满载时**每一条请求**都要 slice 一个几万元素的数组。
 */
const PUBLIC_PER_IP_PER_MIN = 300
const PUBLIC_GLOBAL_PER_MIN = 3000

/**
 * 匿名调用方的限流。放行回 null，否则回那个已经用到顶的闸门。
 *
 * ⚠️ 反代没把真实访客 IP 透传下来时（`isMeaningfulIp` 为假）**跳过按 IP 那一道**。
 * 那种情况下所有人塌缩成同一个值（Cloudflare 边缘节点地址 / 127.0.0.1），
 * 按 IP 限流就从「按人」退化成「全站每分钟 N 次」—— 几个真实用户就能把其他人全锁在门外。
 * 宁可放宽，不能误伤；兜底交给下面那条全站总量。
 *
 * ⚠️ 所以全站那一道**不是冗余**：按 IP 那道可能整个不执行，它是唯一的下限。
 */
function anonGate(req) {
  const ip = clientIpFrom(req.ip, req.headers)
  if (isMeaningfulIp(ip)) {
    const byIp = take(`open:pub:ip:${ip}`, PUBLIC_PER_IP_PER_MIN, 60_000)
    if (!byIp.ok) return byIp
  }
  const global = take('open:pub:global', PUBLIC_GLOBAL_PER_MIN, 60_000)
  return global.ok ? null : global
}

/**
 * 要一枚带指定 scope 的开放平台令牌。
 *
 * ⚠️ 只认 `verifyOpenToken`。**不要**在这里「顺手也试试站内 JWT」——
 * 那一行会把两套令牌重新打通，等于把文件头第 1 条作废。
 */
function requireApp(scope) {
  return (req, res, next) => {
    const cfg = openConfig()
    if (!cfg) return fail(res, 501, 'temporarily_unavailable', '开放平台未启用')
    const h = String(req.headers.authorization || '')
    const token = h.startsWith('Bearer ') ? h.slice(7).trim() : ''
    const claims = verifyOpenToken(token, { publicKey: cfg.publicKey, issuer: cfg.issuer })
    if (!claims) return fail(res, 401, 'invalid_token', '令牌无效或已过期')
    if (scope && !hasScope(claims.scopes, scope)) {
      return fail(res, 403, 'insufficient_scope', `需要 ${scope}`, { scope })
    }
    req.openClaims = claims
    /*
      按应用一层。

      ⚠️ 这里原本写的是「每应用每 IP 两层限流，和取令牌那条同一个理由」——
      两句都不对，2026-09-13 改掉：
        1. 代码里从来只有 appId 这一层，没有 IP 那一层；
        2. 而且在这条路上再加一层 IP **也没用**。取令牌那边需要它，是因为
           `client_id` 在认证之前是调用方任意写的字符串；而这里令牌已经验过签名，
           appId 是真的。再挂一个**同等上限**的 IP 桶，只会让一枚泄露的 key
           从 N 台机器打过来时拿到 N 倍总配额（更差）；设成**更低**的上限又会把
           「所有流量走一台服务器」这种正常接入方式直接卡死。
      所以正确的做法是删掉那句假话，而不是补一个什么都不干的桶去对应它。
      真正需要按 IP 的是**匿名**那条路（`anonGate`）：那里根本没有 appId 可以计数。
    */
    const gate = take(`open:api:${claims.appId}`, 3600, 3600_000)
    if (!gate.ok) return rateLimited(res, gate)
    next()
  }
}

/**
 * **公开**接口：不要求令牌，但带了就必须是有效的。
 *
 * ⚠️⚠️ **「带了一枚坏令牌」不能当匿名放行。**
 *
 * 这是这一改里最容易写错的一处：随手写成
 * `const claims = verifyOpenToken(token) ; if (claims) req.openClaims = claims; next()`，
 * 看上去「更宽容」，实际后果是接入方的令牌过期之后列表接口**照常回 200**，
 * 只是悄悄降了权限 —— 他们要到调 ROM 那条时才发现，
 * 而那句错误指向的是「ROM 权限不够」，不是「你的令牌两小时前就过期了」。
 * 同一个形状的 bug 刚在后台口令那边踩过一次（错的 admin token 遮住了正确的登录态）。
 *
 * 所以：**没有 Authorization 头 = 匿名；有头但验不过 = 401。**
 *
 * ⚠️ 带了有效令牌时**不校验任何 scope**。资源本身已经是公开的，
 * 再要求 `games.read` 就成了「匿名 curl 能读，带了只有 games.rom 的令牌反而 403」。
 */
function optionalApp() {
  const strict = requireApp()
  return (req, res, next) => {
    /*
      ⚠️⚠️ **这里刻意不查 `openConfig()`。**

      公开目录一把密钥都用不上：它只查数据库，不签、不验任何东西。
      而 `openConfig()` 为空的意思是「`OPEN_JWT_PRIVATE_KEY` 没配」——
      那是**取令牌**这件事的前提，不是**读游戏列表**的前提。

      这一条不是假设，是线上实测出来的：2026-09-13 生产环境 `/v1/platforms`
      回的就是 501 `开放平台未启用`（`server/.env` 里一个 OPEN_ 变量都没有）。
      如果这里跟着查一遍 cfg，那「游戏列表公开」就**依赖一个和它完全无关的环境变量** ——
      部署上去之后匿名调用方拿到的还是 501，整个改动等于没做。

      要密钥的那些（/v1/token、/v1/me、ROM、embed、设备码）照旧 501，那是对的：
      它们是真的需要密钥。
    */
    // 整个头缺席才算匿名。`Bearer `、`Basic …`、一串空白都算「带了凭证」，交给严格那条去拒
    // （带了令牌就必须验签，而验签要公钥 —— 所以那条路上 requireApp 仍然会 501）
    if (String(req.headers.authorization || '').trim()) return strict(req, res, next)
    const gate = anonGate(req)
    if (gate) return rateLimited(res, gate)
    next()
  }
}

/**
 * 要一枚**用户级**令牌（设备码换来的那种），而且带指定 scope。
 *
 * ⚠️ 和 requireApp 的区别不只是多判一个字段：`kind` 不对的话 `userId` 是空串，
 * 而下面那些查询全都是 `WHERE user_id = ?` —— 空串查出来是空集，
 * 看起来像「这个用户没有收藏」，而真相是「这枚令牌背后压根没有用户」。
 * 静默给出一个错误的空结果，比报错糟得多。
 *
 * 实际上应用级令牌永远拿不到 user 级 scope（client_credentials 那边挡着），
 * 所以这一道是纵深防御。纵深防御的意思就是：即使上游那道哪天破了，这里也不放行。
 */
function requireUserScope(scope) {
  const base = requireApp(scope)
  return (req, res, next) =>
    base(req, res, () => {
      const c = req.openClaims
      if (c?.kind !== 'user' || !c.userId) {
        return fail(res, 403, 'insufficient_scope', '这个接口要用户授权过的令牌（设备码流程）', { scope })
      }
      next()
    })
}

/* ---------------- 游戏元数据 ---------------- */

const MAX_PAGE_SIZE = 50

function coverUrl(key) {
  return assetPublicUrl(key)
}

/**
 * `GET /v1/games` —— 分页列表。**公开，不需要令牌**（2026-09-13）。
 *
 * 成人内容（`adult=1`）**整体排除**，没有任何开关能打开。
 * （这里原本写着「除非应用单独申请并通过审核（include_adult=1 + 已获批）」——
 *  那套东西一行代码都不存在。留着一句不存在的后门说明，比没有说明更糟：
 *  会有人照着它去实现，也会有人以为已经实现了。）
 *
 * ⚠️ `excludeAdult` 必须传给 `listGames`，**不能**只靠下面 openGamesBySlugs 那道过滤：
 * `total` 是 listGames 算的。两边不一致的症状是「total 说 100，一页页翻到底只有 87 款」，
 * 而且某些页会短几条 —— 接入方查不出来，只会觉得我们的接口时好时坏。
 */
openRouter.get('/v1/games', optionalApp(), async (req, res, next) => {
  try {
    const requiresWindows = req.query.requires_windows
    // 设备用这个参数排除跑不动的 Windows 客体；拼错值不能静默退回全库。
    if (requiresWindows !== undefined && requiresWindows !== 'true' && requiresWindows !== 'false') {
      return fail(res, 400, 'invalid_request', 'requires_windows 只接受 true 或 false')
    }
    const lang = normalizeLang(req.query.lang)
    const pageSize = Math.min(MAX_PAGE_SIZE, Math.max(1, Number(req.query.page_size) || 24))
    const result = await listGames({
      excludeAdult: true,
      requiresWindows: requiresWindows === undefined ? undefined : requiresWindows === 'true',
      platform: req.query.platform ? String(req.query.platform) : undefined,
      genre: req.query.genre ? String(req.query.genre) : undefined,
      q: req.query.q ? String(req.query.q) : undefined,
      sort: req.query.sort ? String(req.query.sort) : undefined,
      page: Number(req.query.page) || 1,
      pageSize,
      // includeHidden 一个字都不传：下架的游戏对外根本不存在
    })
    /*
      ⚠️ listGames 回的是**站内形状**（gameRowToApi，带着 rom / roms / cover 的对象 key）。
      这里必须重新按白名单组装，不能直接 res.json(result.items)。
      为此再取一次原始行 —— 多一次查询换「新增一列不会自动漏出去」，这笔买卖值。
    */
    const slugs = result.items.map((g) => g.slug)
    const items = await openGamesBySlugs(slugs, lang)
    res.set('Cache-Control', CACHE.api)
    res.json(openPage({ ...result, items }))
  } catch (e) {
    next(e)
  }
})

/** 按 slug 取原始行 + 关联，再过对外 mapper。顺序与传入一致 */
async function openGamesBySlugs(slugs, lang) {
  if (!slugs.length) return []
  const holes = slugs.map(() => '?').join(',')
  const rows = await query(`SELECT * FROM games WHERE slug IN (${holes}) AND hidden = 0 AND adult = 0`, slugs)
  const rel = await relationsFor(rows)
  const bySlug = new Map(rows.map((r) => [r.slug, r]))
  return slugs
    .map((s) => bySlug.get(s))
    .filter(Boolean)
    .map((row) => openGame(row, rel.get(String(row.id)) ?? {}, { lang, coverUrl }))
}

/**
 * 关联数据（类型 / 标签 / ROM）。
 * 复用 `attachRelations` 的查询形状，但它会顺手过站内 mapper，所以这里自己查一遍 ——
 * **对外这条路上，原始行绝不能经过站内 mapper**。
 */
async function relationsFor(rows) {
  const out = new Map()
  if (!rows.length) return out
  const ids = rows.map((r) => r.id)
  const holes = ids.map(() => '?').join(',')
  const [genreRows, tagRows, romRows] = await Promise.all([
    query(`SELECT game_id, genre_id FROM game_genres WHERE game_id IN (${holes})`, ids),
    query(`SELECT game_id, tag FROM game_tags WHERE game_id IN (${holes})`, ids),
    query(`SELECT game_id, lang, object_key FROM game_roms WHERE game_id IN (${holes})`, ids),
  ])
  const bucket = (id) => {
    const k = String(id)
    if (!out.has(k)) out.set(k, { genres: [], tags: [], roms: {} })
    return out.get(k)
  }
  for (const r of genreRows) bucket(r.game_id).genres.push(r.genre_id)
  for (const r of tagRows) bucket(r.game_id).tags.push(r.tag)
  for (const r of romRows) bucket(r.game_id).roms[r.lang] = r.object_key
  return out
}

/**
 * `GET /v1/games/:slug` —— 详情。**公开，不需要令牌**。
 *
 * ⚠️ 这条和列表都盖掉了 /api 那道全局 no-store，换成 `CACHE.api`（边缘 5 分钟）。
 * 前提是**响应对所有调用方完全一样** —— 现在确实如此（带不带令牌、是哪个应用，回的都一样）。
 * 将来只要给这两条加上任何**按应用不同**的字段（比如「这个应用能不能看成人内容」），
 * 必须当场改回 private/no-store，否则边缘会把 A 应用那份发给 B。
 * 代价是后台下架一款游戏之后，开放接口那边最多还能看到它 5 分钟。
 */
openRouter.get('/v1/games/:slug', optionalApp(), async (req, res, next) => {
  try {
    const lang = normalizeLang(req.query.lang)
    const [item] = await openGamesBySlugs([String(req.params.slug)], lang)
    // 下架 / 成人 / 不存在，对外都是同一个 404：区分开就成了「这游戏是不是被下架了」的查询器
    if (!item) return fail(res, 404, 'not_found', '没有这款游戏')
    res.set('Cache-Control', CACHE.api)
    res.json(item)
  } catch (e) {
    next(e)
  }
})

/**
 * `POST /v1/games/:slug/play` —— 其它设备在游戏**真的进入可玩状态后**上报一次。
 *
 * 必须是设备码 / 授权码换来的用户级令牌，并带 `library.write`：只有账号身份才能与站内
 * `game_plays` 的去重口径对齐。应用级令牌背后没有人；让它自报 device_id 等于允许调用方
 * 随便换一个字符串刷数，所以这里不提供那条退路。
 *
 * 同一账号在网页、掌机、电视上玩同一款只计一次；重试也只会得到 counted:false。
 * 上报同时刷新「最近在玩」，不然设备明明已经开玩，账号的 library 却长期看不到它。
 */
openRouter.post('/v1/games/:slug/play', requireUserScope('library.write'), async (req, res, next) => {
  try {
    const slug = String(req.params.slug)
    // 下架 / 成人 / 不存在与公开详情同一个 404，不能借写接口探测隐藏内容。
    if (!(await getRawGame(slug))) return fail(res, 404, 'not_found', '没有这款游戏')
    const who = playIdentityForUser(req.openClaims.userId)
    if (!who) return fail(res, 401, 'invalid_token', '用户令牌里没有有效账号')
    const counted = await recordGamePlay(slug, who.kind, who.identity)
    await recordRecent(req.openClaims.userId, slug)
    res.set('Cache-Control', 'private, no-store').json({ ok: true, counted })
  } catch (e) {
    next(e)
  }
})

/* ---------------- 平台目录（只读参考） ---------------- */

/**
 * `GET /v1/platforms` —— 第三方客户端挑模拟器用的目录。
 *
 * 游戏对象只给 `platform` 这个 slug，不暴露 core / 扩展名 / 能不能本地跑
 * （那些属于内部信息，且 `core` 在 FORBIDDEN_OUT_KEYS 里）。
 * 但一个要自己起本地模拟器的客户端，恰恰需要这三样：拿到 slug 后查这张表，
 * 就知道该调哪个模拟器、ROM 是什么扩展名、这个平台到底能不能本地跑
 * （html5 是网页、ps2 不提供整份镜像，都 runnable:false）。
 *
 * **公开，不需要令牌**：它只是一张静态参考表，而它描述的那些游戏本身已经是公开的。
 * 数据来自 `open/platforms.js`。
 *
 * ⚠️ 每行带一个 `enabled` —— 站上并不是 16 个平台都开着（白名单在
 * shared/site-taxonomy.js）。不看这个字段的客户端会列出永远没有内容的分类。
 */
openRouter.get('/v1/platforms', optionalApp(), (req, res) => {
  /*
    ⚠️ 这条要覆盖掉 /api 那道全局 noStore。

    它是**静态的、不含任何用户数据**的目录，而文档明确建议客户端「缓存整张表（很少变）」——
    服务端却发 no-store，等于让每台设备每次开机都重新拉一遍，两边自相矛盾。
    一小时足够短（改了平台表最多一小时全网生效），也足够长（省掉绝大多数重复请求）。

    `public` 是可以的：这里没有按令牌变化的内容，所有应用拿到的是同一份。
    ⚠️ 将来如果给这张表加了**按应用不同**的字段（比如「这个应用能不能访问该平台」），
    必须立刻改回 private —— 否则中间层缓存会把 A 应用的那份发给 B。
  */
  res.set('Cache-Control', 'public, max-age=3600')
  res.json({ items: OPEN_PLATFORMS })
})

/** 沙箱可测试的游戏目录。由站长指定，公开只露 slug，不露 ROM 对象 key。 */
openRouter.get('/v1/rom-samples', optionalApp(), async (req, res, next) => {
  try {
    res.set('Cache-Control', 'public, max-age=30')
    res.json({ items: await listSandboxRomSamples() })
  } catch (e) {
    next(e)
  }
})

/* ---------------- 类型 / 语言目录（只读参考） ---------------- */

/**
 * `GET /v1/genres` —— 给客户端画「按类型筛选」用的枚举。
 *
 * 和 /v1/platforms 一样：静态参考、**公开**、可缓存一小时。
 * 数据来自 `open/taxonomy.js`（镜像 `GENRE_IDS` + `genres.ts`）。
 */
openRouter.get('/v1/genres', optionalApp(), (req, res) => {
  res.set('Cache-Control', 'public, max-age=3600')
  res.json({ items: OPEN_GENRES })
})

/**
 * `GET /v1/languages` —— 给客户端画「按语言筛选」用的枚举。
 *
 * 同样静态参考、可缓存。数据直接来自 `shared/site-languages.js` 的 `SITE_LANGUAGES`。
 */
openRouter.get('/v1/languages', optionalApp(), (req, res) => {
  res.set('Cache-Control', 'public, max-age=3600')
  res.json({ items: OPEN_LANGUAGES })
})

/* ---------------- 外部设备开播 + 直播 / 联机房间发现 ---------------- */

/**
 * `POST /v1/live/publish-token` —— 用短期用户 access token 换用途单一的设备开播凭证。
 *
 * access token 能读用户授权过的数据，不应在一场数小时的直播里长期挂在 Socket.IO 上；
 * 发布凭证只能连接 `/live` 当主播，拿去调 REST 会因为 typ / aud 不同而验不过。
 */
openRouter.post('/v1/live/publish-token', requireUserScope('live.write'), (req, res) => {
  const cfg = openConfig()
  const publisherToken = issueLivePublisherToken({
    privateKey: cfg.privateKey,
    kid: cfg.kid,
    issuer: cfg.issuer,
    appId: req.openClaims.appId,
    userId: req.openClaims.userId,
  })
  const base = publicSiteUrl()
  res.set('Cache-Control', 'private, no-store').json({
    publisher_token: publisherToken,
    token_type: 'LivePublisher',
    expires_in: LIVE_PUBLISHER_TTL_SEC,
    protocol: '8bitgo-live-v1',
    signaling_url: new URL('/live', base).href,
    socket_path: '/socket.io',
    namespace: '/live',
    auth_field: 'publisherToken',
    capacity_url: new URL('/api/open/v1/live/capacity', base).href,
    ice_url: new URL('/api/netplay/ice', base).href,
  })
})

/** 直播快照补一条能直接打开的观看地址；信令 token 等内部字段仍由 live.js 的白名单挡住。 */
function openLiveRoom(room) {
  if (!room) return null
  const url = new URL(`/games/${encodeURIComponent(room.gameSlug)}`, publicSiteUrl())
  url.searchParams.set('live', room.roomId)
  return { ...room, watchUrl: url.href }
}

/**
 * P2P 房间去掉房主迁移时的内部候选 id。传了 game slug 时顺手给可直接加入的地址；
 * 没传时只有数值 gameId，调用方可用 shared/netplay-game-id.js 的 FNV-1a 规则匹配目录。
 */
function openNetplayRoom(room, gameSlug) {
  if (!room) return null
  const out = { ...room }
  delete out.nextHostUserId
  if (!gameSlug) return out
  const url = new URL(`/games/${encodeURIComponent(gameSlug)}`, publicSiteUrl())
  url.searchParams.set('p2p', room.roomId)
  return { ...out, gameSlug, joinUrl: url.href }
}

/**
 * `GET /v1/live/capacity` —— 开始采集和建 WebRTC 连接前的轻量预检。
 *
 * 设备端走版本化开放接口，站内网页走 `/api/live/capacity`；两条读的是同一份原始房间表。
 * 这里不能按大厅列表长度推算，因为切后台后从大厅隐藏的房间仍然占用全站席位。
 * 响应不缓存，而且只是一张瞬时快照；真正开房时 `go-live` 仍会原子复核。
 */
openRouter.get('/v1/live/capacity', optionalApp(), (_req, res) => {
  res.json(liveCapacity())
})

/**
 * `GET /v1/live/rooms` —— 当前在播的公开房间列表。
 *
 * 复用 `live.js` 的 `liveRooms()`，它已经走 `publicRoom()` 脱敏：不含主播 IP、续播 token、
 * 观众 socket.id，只给大厅要展示的字段（标题 / 游戏 / 主播名 / 人数 / 联机房号 / 2P 位）。
 * 和站内 `/api/live/rooms` 同一份内存房间表；`?game=<slug>` 只筛某一款游戏。
 * **公开，不需要令牌** —— 站内的 `GET /api/live/rooms`（index.js）本来就是匿名可读的同一份数据，
 * 在开放平台这边多加一道门只是形式。
 *
 * ⚠️ 这条**不加缓存**：房间是秒级变化的，缓存 30 秒等于把「谁在播」这件事变成假的。
 */
openRouter.get('/v1/live/rooms', optionalApp(), (req, res) => {
  const gameSlug = typeof req.query.game === 'string' && req.query.game ? req.query.game : undefined
  res.json({ items: liveRooms({ gameSlug }).map(openLiveRoom) })
})

/**
 * `GET /v1/live/rooms/:roomId` —— 单个房间快照。
 * 直链也能查到：不受「主播切后台太久了下榜」的影响（那是列表层面的过滤，单房照样在）。
 */
openRouter.get('/v1/live/rooms/:roomId', optionalApp(), (req, res) => {
  const room = liveRoom(req.params.roomId)
  if (!room) return fail(res, 404, 'not_found', '没有这个直播间')
  res.json(openLiveRoom(room))
})

/**
 * `GET /v1/netplay/rooms` —— 当前 P2P 联机房间。`?game=<slug>` 按游戏筛选，
 * 并让每个条目多出 gameSlug / joinUrl；不筛选时保留协议原生的数值 gameId。
 */
openRouter.get('/v1/netplay/rooms', optionalApp(), (req, res) => {
  const gameSlug = typeof req.query.game === 'string' && req.query.game ? req.query.game : undefined
  const gameId = gameSlug ? netplayGameId(gameSlug) : undefined
  res.json({ items: netplayRooms({ gameId }).map((room) => openNetplayRoom(room, gameSlug)) })
})

/** 单个 P2P 房间快照；房主迁移后仍可用旧 roomId 查询。 */
openRouter.get('/v1/netplay/rooms/:roomId', optionalApp(), (req, res) => {
  const gameSlug = typeof req.query.game === 'string' && req.query.game ? req.query.game : undefined
  const room = netplayRoom(req.params.roomId)
  if (!room || (gameSlug && String(room.gameId) !== String(netplayGameId(gameSlug)))) {
    return fail(res, 404, 'not_found', '没有这个联机房间')
  }
  res.json(openNetplayRoom(room, gameSlug))
})

/* ---------------- 合集（只读） ---------------- */

/**
 * `GET /v1/collections` —— 公开合集列表（分页）。**公开，不需要令牌**：
 * 站内 `GET /api/collections` 走的是 `optionalUser`，本来就匿名可读同一批数据。
 * 复用 `collections.js` 的 `listPublicCollections`（同一段查询 + 安全 `decorate`，
 * `viewerId` 传 null，所以输出里不会有 `mine`）。
 */
openRouter.get('/v1/collections', optionalApp(), async (req, res, next) => {
  try {
    const pageSize = Math.min(48, Math.max(1, Number(req.query.page_size) || 24))
    const { items, total, page, pageSize: size } = await listPublicCollections(req.query.page, pageSize)
    res.json({ items, page, page_size: size, total, total_pages: Math.ceil(total / size) })
  } catch (e) {
    next(e)
  }
})

/**
 * `GET /v1/collections/:id` —— 单个合集 + 里面的游戏。
 *
 * ⚠️ 游戏对象**不走**站内的 `attachRelations`（那会带出 ROM 真实地址等内部字段），
 * 而是用本文件的 `openGamesBySlugs` 白名单重新映射，和 /v1/games 的元素同一个形状。
 */
openRouter.get('/v1/collections/:id', optionalApp(), async (req, res, next) => {
  try {
    const lang = normalizeLang(req.query.lang)
    const found = await getPublicCollection(req.params.id)
    if (!found) return fail(res, 404, 'not_found', '没有这个合集')
    const games = await openGamesBySlugs(found.gameSlugs, lang)
    res.json({ collection: found.collection, games })
  } catch (e) {
    next(e)
  }
})

/* ---------------- ROM：短期签名凭据 ---------------- */

/** 一张 ROM 凭据最多能兑现多少次（余量留给断点续传 / 失败重试） */
const ROM_GRANT_MAX_REDEEM = 10

/**
 * `GET /v1/games/:slug/rom?lang=ja`
 *
 * 回一张**分钟级过期**的下载凭据，不回对象存储的真实地址。
 * 为什么这样而不是直接给地址：真实地址是永久的、可转发的、无法吊销的 ——
 * 一旦流出去，撤销这个应用的权限对它毫无影响。
 *
 * ⚠️ **前置改造还没做**：`assets.8bitgo.com` 目前公开可读，
 * 任何人从网络面板抄走地址就能无限下载。在那之前这一层只是「我们不主动给」，
 * 别对外宣传成访问控制。见 `open/sign.js` 的文件头与 docs/open-platform.md 的 P-1。
 */
openRouter.get('/v1/games/:slug/rom', requireApp('games.rom'), async (req, res, next) => {
  try {
    const cfg = openConfig()
    if (!cfg.romEnabled) return fail(res, 501, 'temporarily_unavailable', 'ROM 接口未启用')
    const mode = await romAccessForApp(req.openClaims.appId)
    if (!mode) return fail(res, 403, 'app_not_authorized', '应用已停用或没有当前 ROM 权限')
    const slug = String(req.params.slug)
    const row = await getRawGame(slug)
    if (!row) return fail(res, 404, 'not_found', '没有这款游戏')

    if (mode === 'sandbox' && !(await isSandboxRomSample(row))) {
      return fail(res, 403, 'sandbox_resource_only', '沙箱只能下载 /v1/rom-samples 列出的逐机型测试游戏')
    }

    // ROM 单独一层配额：它是这套接口里唯一按 GB 计费的东西
    const gate = mode === 'sandbox'
      ? take(`open:rom:sandbox:${req.openClaims.appId}`, 10, 3600_000)
      : take(`open:rom:${req.openClaims.appId}`, 600, 3600_000)
    if (!gate.ok) return rateLimited(res, gate)

    const rel = await relationsFor([row])
    const roms = rel.get(String(row.id))?.roms ?? {}
    const want = req.query.lang ? String(req.query.lang) : ''
    const hit = pickRom(roms, want)
    if (!hit) return fail(res, 404, 'rom_unavailable', '这款游戏没有可下载的 ROM')

    const grant = signRomGrant({
      secret: cfg.romSecret,
      appId: req.openClaims.appId,
      slug,
      lang: hit.lang,
      key: hit.key,
      mode,
    })
    res.json({
      // 凭据换成地址：注意 URL 里**没有** object key，抄走也只能下这一款、这几分钟
      url: `${publicSiteUrl()}/api/open/v1/rom/${grant}`,
      expires_in: ROM_GRANT_TTL_SEC,
      lang_requested: want || null,
      lang_actual: hit.lang,
      filename: hit.key.split('/').pop(),
    })
  } catch (e) {
    next(e)
  }
})

/**
 * `GET /v1/rom/:grant` —— 兑现凭据。
 *
 * **这一条不要求 Bearer**：凭据自己就是授权（它绑了 app / slug / 有效期），
 * 而下载多半发生在浏览器或 curl 里，带不上 Authorization 头。
 *
 * ⚠️ 正因为不要求 Bearer，**这是整套接口里唯一一条既没有令牌、原先也没有任何配额的路**。
 * 上游 `/v1/games/:slug/rom` 那道 600/小时 限的是**领票**，不是**兑票**：
 * 领一张票之后在五分钟里兑多少次，原来完全不设限。
 * 下面两道补上：一道按票（一张票最多兑这么多次），一道按 IP。
 */
openRouter.get('/v1/rom/:grant', async (req, res, next) => {
  try {
    const cfg = openConfig()
    if (!cfg?.romEnabled) return fail(res, 501, 'temporarily_unavailable', 'ROM 接口未启用')
    const v = verifyRomGrant(req.params.grant, { secret: cfg.romSecret })
    if (!v.ok) {
      const status = v.reason === 'expired' ? 410 : 403
      return fail(res, status, v.reason === 'expired' ? 'grant_expired' : 'invalid_grant', '凭据无效或已过期')
    }
    const currentAccess = await romAccessForApp(v.appId)
    if (!currentAccess || (v.mode === 'live' && currentAccess !== 'live')) {
      return fail(res, 403, 'app_not_authorized', '应用已停用或 ROM 权限已撤销')
    }
    if (v.mode === 'sandbox' && !(await canRedeemSandboxRom(v))) {
      return fail(res, 403, 'sandbox_resource_only', '测试样本已变更或 ROM 已下架')
    }
    /*
      按票。正常一次就够；留到 ROM_GRANT_MAX_REDEEM 是给断点续传和失败重试的余量。
      它把「抄走一张票 = 五分钟内无限下」变成「抄走一张票 = 最多再下 N 次」。

      ⚠️ 计数**必须放在验签之后** —— 放前面的话，随便伪造一串字符就能往限流表里
      净增一条记录，那正是 token 端点注释里写着要避免的那件事。
      key 用票本身：signRomGrant 里那个随机 nonce 保证同一个应用同一秒领两次也是两张票。
    */
    const byGrant = take(`open:romdl:${req.params.grant}`, ROM_GRANT_MAX_REDEEM, ROM_GRANT_TTL_SEC * 1000)
    if (!byGrant.ok) return rateLimited(res, byGrant)
    // 按 IP：挡住「拿一批票从一台机器上刷」。反代没透传真实 IP 时跳过，理由见 anonGate
    const ip = clientIpFrom(req.ip, req.headers)
    if (isMeaningfulIp(ip)) {
      const byIp = take(`open:romdl:ip:${ip}`, 60, 60_000)
      if (!byIp.ok) return rateLimited(res, byIp)
    }
    const target = assetPublicUrl(v.key)
    if (!target) return fail(res, 404, 'not_found', 'ROM 不可用')
    // 302 而不是代理转发：ROM 动辄几十上百 MB，全走源站的带宽没必要。
    // P-1 做完之后这里换成对象存储的预签名地址（同样是 302），调用方无感。
    res.set('Cache-Control', 'private, no-store').redirect(302, target)
  } catch (e) {
    next(e)
  }
})

async function getRawGame(slug) {
  const rows = await query('SELECT * FROM games WHERE slug = ? AND hidden = 0 AND adult = 0 LIMIT 1', [slug])
  return rows[0] || null
}

/* ---------------- 嵌入播放器 ---------------- */

/**
 * `GET /v1/games/:slug/embed` —— 换一个带签名、会过期的嵌入地址。
 *
 * ⚠️⚠️ **这道门目前还不是真的门 —— 别对外宣传成访问控制。**
 *
 * 原来这里写的是「防盗链靠 `/embed/*` 响应头上的 `frame-ancestors <该应用登记的域名>`」。
 * 2026-09-11 核对：全仓库**没有任何地方下发过 CSP**（grep `frame-ancestors` 只有这段注释
 * 本身），`/embed/:slug` 是纯前端路由、由 SSR catch-all 返回，不带任何安全响应头；
 * `open/sign.js` 导出的 `verifyEmbed()` **一个调用点都没有**。
 * 也就是说 signEmbed 发出去的 `?a=&e=&s=` 三个参数无人校验，
 * 任何网站直接 `<iframe src="https://…/embed/<slug>">` 就能白嵌。
 *
 * 要把它变成真的门，需要给 `/embed/*` 单独一条 Express 路由：先 `verifyEmbed()`，
 * 再按该应用登记的 `embed_origins` 下发 `Content-Security-Policy: frame-ancestors …`。
 * 在那之前，Referer 只是弱校验和用量归因，挡不住任何人。
 */
openRouter.get('/v1/games/:slug/embed', requireApp('games.read'), async (req, res, next) => {
  try {
    const cfg = openConfig()
    if (!cfg.embedEnabled) return fail(res, 501, 'temporarily_unavailable', '嵌入播放器未启用')
    const slug = String(req.params.slug)
    const row = await getRawGame(slug)
    if (!row) return fail(res, 404, 'not_found', '没有这款游戏')
    const lang = normalizeLang(req.query.lang)
    const { sig, exp } = signEmbed({ secret: cfg.embedSecret, appId: req.openClaims.appId, slug })
    const url = new URL(`/embed/${encodeURIComponent(slug)}`, publicSiteUrl())
    url.searchParams.set('a', req.openClaims.appId)
    url.searchParams.set('e', String(exp))
    url.searchParams.set('s', sig)
    url.searchParams.set('lang', lang)
    res.json({
      url: url.href,
      expires_in: EMBED_TTL_SEC,
      allow: 'fullscreen; gamepad; autoplay; clipboard-write',
    })
  } catch (e) {
    next(e)
  }
})

/* ---------------- 用户数据（只读，要用户级令牌） ---------------- */

/**
 * `GET /v1/library` —— 收藏与最近在玩。
 *
 * 回的是**完整的游戏对象**（和 /v1/games 的元素同一个形状），不是一串 slug：
 * 接入方拿到十个 slug 之后必然要再发十次请求去换标题和封面，
 * 而那十次查的是我们这边本来一次就能出的东西。
 *
 * ⚠️ 仍旧过 openGamesBySlugs → openGame 那条白名单，和别的接口一样 ——
 * 「这是用户自己的数据」不是把内部字段发出去的理由。
 */
openRouter.get('/v1/library', requireUserScope('library.read'), async (req, res, next) => {
  try {
    const lang = normalizeLang(req.query.lang)
    const uid = req.openClaims.userId
    const [favSlugs, recentSlugs] = await Promise.all([favIds(uid), recentIds(uid)])
    /*
      收藏没有上限（站内那一路也没有），所以这里自己封顶。
      不封的话，一个收藏了两千款的账号会让这个接口一次吐出几 MB ——
      而接入方多半只想展示前几屏。
    */
    const [favorites, recent] = await Promise.all([
      openGamesBySlugs(favSlugs.slice(0, MAX_LIBRARY_ITEMS), lang),
      openGamesBySlugs(recentSlugs, lang),
    ])
    res.json({
      favorites,
      recent,
      /** 收藏被截断了没有。接入方要不要提示「还有更多」，靠这个判断 */
      favorites_total: favSlugs.length,
    })
  } catch (e) {
    next(e)
  }
})

/** 收藏最多一次给多少款 */
const MAX_LIBRARY_ITEMS = 100

/**
 * `GET /v1/saves` —— 存档清单。**只给元信息，不带内容**：
 * 一份 DOS 变更包几百 KB，一次把全部内容吐出来对谁都没好处。
 */
openRouter.get('/v1/saves', requireUserScope('saves.read'), async (req, res, next) => {
  try {
    const rows = await query(
      `SELECT runtime, game_slug, slot, size, created_at, updated_at
         FROM saves WHERE user_id = ? ORDER BY updated_at DESC`,
      [req.openClaims.userId],
    )
    res.json({
      items: rows.map((r) => ({
        runtime: r.runtime,
        game_slug: r.game_slug,
        slot: r.slot,
        size: r.size,
        created_at: new Date(r.created_at).toISOString(),
        updated_at: new Date(r.updated_at).toISOString(),
      })),
    })
  } catch (e) {
    next(e)
  }
})

/**
 * `GET /v1/saves/:runtime/:slug?slot=0` —— 取一份存档的**二进制**。
 *
 * 坐标校验和站内共用同一个纯函数（saves.js 的 saveCoords）——
 * 各判一遍的话，哪天加个引擎名只会改其中一处，
 * 症状是「站内能存，第三方说未知的引擎」。
 */
openRouter.get('/v1/saves/:runtime/:slug', requireUserScope('saves.read'), async (req, res, next) => {
  try {
    const c = saveCoords({ runtime: req.params.runtime, slug: req.params.slug, slot: req.query.slot })
    if (!c.ok) {
      const msg = c.reason === 'runtime' ? '未知的引擎' : c.reason === 'slug' ? '游戏标识不合法' : '存档位不合法'
      return fail(res, 400, 'invalid_request', msg)
    }
    const row = await query(
      'SELECT data, updated_at FROM saves WHERE user_id = ? AND runtime = ? AND game_slug = ? AND slot = ? LIMIT 1',
      [req.openClaims.userId, c.runtime, c.slug, c.slot],
    )
    const hit = row[0]
    if (!hit) return fail(res, 404, 'not_found', '没有这份存档')
    res.setHeader('content-type', 'application/octet-stream')
    res.setHeader('x-save-updated-at', String(new Date(hit.updated_at).getTime()))
    // 别人的存档不该进任何一层缓存
    res.setHeader('cache-control', 'private, no-store')
    res.send(hit.data)
  } catch (e) {
    next(e)
  }
})

/* ---------------- 自省：接入方排错的第一站 ---------------- */

/**
 * `GET /v1/me` —— 这枚令牌是谁的、有哪些 scope、什么时候过期。
 * 有这条，「为什么我调那个接口 403」十秒就能自查完，不用来问我们。
 */
openRouter.get('/v1/me', requireApp(), (req, res) => {
  res.json({
    client_id: req.openClaims.appId,
    kind: req.openClaims.kind,
    /*
      用户级令牌要把用户 id 报出来 —— 接入方拿它区分「这是谁的授权」
      （同一个应用可能同时握着好几个用户的令牌）。应用级令牌背后没有用户，给 null，
      **不给空串**：空串在 JSON 里看起来像「有这个字段但值丢了」。
    */
    user_id: req.openClaims.kind === 'user' ? req.openClaims.userId : null,
    scope: formatScopes(req.openClaims.scopes),
    expires_at: new Date(req.openClaims.exp * 1000).toISOString(),
  })
})

export { requireApp }
