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
import { listGames } from '../games-repo.js'
import { query } from '../db.js'
import { take } from '../rateLimit.js'
import { assetPublicUrl, publicSiteUrl } from '../site-urls.js'
import { clientIpFrom } from '../presence.js'
import { openConfig } from '../open/config.js'
import { authenticateApp, readClientCredentials } from '../open/apps.js'
import { issueAppToken, verifyOpenToken, OPEN_ACCESS_TTL_SEC } from '../open/tokens.js'
import { APP_SCOPES, formatScopes, hasScope, missingScopes, parseScopes } from '../open/scopes.js'
import { openGame, openPage } from '../open/mapper.js'
import { normalizeLang, pickRom } from '../open/i18n.js'
import { ROM_GRANT_TTL_SEC, EMBED_TTL_SEC, signEmbed, signRomGrant, verifyRomGrant } from '../open/sign.js'

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

/* ---------------- 取令牌：AppID + key ---------------- */

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

    if (String(req.body?.grant_type || '') !== 'client_credentials') {
      return fail(res, 400, 'unsupported_grant_type', '这个端点只支持 client_credentials；用户登录走 /api/oauth/authorize')
    }

    const app = await authenticateApp(clientId, clientSecret)
    // ⚠️ 认不出来一律同一句话：区分「没这个应用」和「密钥不对」就成了 AppID 探针
    if (!app) return fail(res, 401, 'invalid_client', 'AppID 或 key 不正确')
    if (app.clientType !== 'confidential') {
      return fail(res, 400, 'unauthorized_client', '公开客户端（无 key）不能用 client_credentials')
    }

    // 不传 scope 就给「已获批 ∩ 应用级」的全部；传了就必须是子集
    const approvedApp = app.approvedScopes.filter((s) => APP_SCOPES.includes(s))
    let scopes = approvedApp
    if (req.body?.scope) {
      const parsed = parseScopes(req.body.scope)
      if (parsed.unknown.length) return fail(res, 400, 'invalid_scope', `不认识的 scope：${parsed.unknown.join(' ')}`)
      const userLevel = parsed.scopes.filter((s) => !APP_SCOPES.includes(s))
      if (userLevel.length) {
        return fail(res, 400, 'invalid_scope', `${userLevel.join(' ')} 需要用户授权，不能用 client_credentials 取`)
      }
      // **不静默降级**：少给一个 scope 却照常发令牌，接入方要到线上功能失效才发现
      const missing = missingScopes(parsed.scopes, approvedApp)
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
    // 每应用每 IP 两层限流，和取令牌那条同一个理由
    const gate = take(`open:api:${claims.appId}`, 3600, 3600_000)
    if (!gate.ok) return rateLimited(res, gate)
    next()
  }
}

/* ---------------- 游戏元数据 ---------------- */

const MAX_PAGE_SIZE = 50

function coverUrl(key) {
  return assetPublicUrl(key)
}

/**
 * `GET /v1/games` —— 分页列表。
 *
 * 成人内容（`adult=1`）**整体排除**，除非应用单独申请并通过审核（`include_adult=1` + 已获批）。
 * 默认排除而不是默认包含：接入方不会想到要过滤，而我们知道它存在。
 */
openRouter.get('/v1/games', requireApp('games.read'), async (req, res, next) => {
  try {
    const lang = normalizeLang(req.query.lang)
    const pageSize = Math.min(MAX_PAGE_SIZE, Math.max(1, Number(req.query.page_size) || 24))
    const result = await listGames({
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

/** `GET /v1/games/:slug` */
openRouter.get('/v1/games/:slug', requireApp('games.read'), async (req, res, next) => {
  try {
    const lang = normalizeLang(req.query.lang)
    const [item] = await openGamesBySlugs([String(req.params.slug)], lang)
    // 下架 / 成人 / 不存在，对外都是同一个 404：区分开就成了「这游戏是不是被下架了」的查询器
    if (!item) return fail(res, 404, 'not_found', '没有这款游戏')
    res.json(item)
  } catch (e) {
    next(e)
  }
})

/* ---------------- ROM：短期签名凭据 ---------------- */

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
    const slug = String(req.params.slug)
    const row = await getRawGame(slug)
    if (!row) return fail(res, 404, 'not_found', '没有这款游戏')

    // ROM 单独一层配额：它是这套接口里唯一按 GB 计费的东西
    const gate = take(`open:rom:${req.openClaims.appId}`, 600, 3600_000)
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

/* ---------------- 自省：接入方排错的第一站 ---------------- */

/**
 * `GET /v1/me` —— 这枚令牌是谁的、有哪些 scope、什么时候过期。
 * 有这条，「为什么我调那个接口 403」十秒就能自查完，不用来问我们。
 */
openRouter.get('/v1/me', requireApp(), (req, res) => {
  res.json({
    client_id: req.openClaims.appId,
    kind: req.openClaims.kind,
    scope: formatScopes(req.openClaims.scopes),
    expires_at: new Date(req.openClaims.exp * 1000).toISOString(),
  })
})

export { requireApp }
