/**
 * 开放平台 · 用户级令牌那一半：授权码 + PKCE（OIDC 的授权码流程）。
 *
 * `routes/open.js` 里是应用级（client_credentials）那半；这一份是**用户级**那半——
 * 一枚令牌背后站着一个真实用户（sub = users.id），靠它才能拿 library.* / saves.*。
 * 设备码那一半在 `routes/open.js` 的 `/v1/token` 里（同样调用 issueUserToken），
 * 这一份是给**有浏览器**的 Web 应用用的：用户在 8bitgo 上登录、点同意，
 * 浏览器被重定向回应用的 redirect_uri 带一枚 code，应用用 code + PKCE 换用户令牌。
 *
 * ## 为什么强制 PKCE（RFC 7636）
 *
 * 公开客户端（纯前端 SPA）藏不住 client_secret，截获的授权码能被人直接拿去换令牌。
 * PKCE 让「换令牌」这一步必须出示授权码时对应的 code_verifier，截获 code 没用。
 * 所以这里 **code_challenge 必填、且 method 只能是 S256**（plain 直接拒）。
 *
 * ## 授权码存在内存里
 *
 * 和 device.js 同一个取舍：授权码寿命只有 5 分钟、一次性，重启就清空、多实例不共享。
 * 对用户级令牌来说能接受——用户重新走一遍授权即可。等哪天要跑多实例再换库。
 */
import express, { Router } from 'express'
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { openConfig } from '../open/config.js'
import { getApp, canAuthorize } from '../open/apps-repo.js'
import { authenticateApp, readClientCredentials } from '../open/apps.js'
import { issueUserToken, OPEN_ACCESS_TTL_SEC } from '../open/tokens.js'
import { OPEN_SCOPES, parseScopes, missingScopes } from '../open/scopes.js'
import { parseUriList } from '../open/review.js'
import { requireUser } from '../auth.js'
import { publicSiteUrl } from '../site-urls.js'
import { take } from '../rateLimit.js'
import { clientIpFrom } from '../presence.js'

export const oauthRouter = Router()

/* ---------------- CORS：授权码换令牌的可能是浏览器里的公开客户端 ---------------- */
oauthRouter.use((req, res, next) => {
  res.set('Access-Control-Allow-Origin', '*')
  res.set('Access-Control-Allow-Headers', 'Authorization, Content-Type')
  res.set('Access-Control-Allow-Methods', 'POST, OPTIONS')
  res.set('Vary', 'Origin')
  if (req.method === 'OPTIONS') return res.sendStatus(204)
  next()
})

/** OAuth 风格错误体（和 open.js 同一个形状） */
function fail(res, status, error, description, extra) {
  const body = {
    error,
    error_description: description,
    error_uri: `${publicSiteUrl()}/developers/docs/errors#${error}`,
  }
  if (extra) Object.assign(body, extra)
  return res.status(status).json(body)
}

/* ---------------- 授权码存储（内存，5 分钟，一次性） ---------------- */

const codes = new Map()
const CODE_TTL_SEC = 300

function sweepCodes(now = Date.now()) {
  for (const [k, v] of codes) if (v.expiresAt <= now) codes.delete(k)
  return codes.size
}

function issueAuthCode({ appId, userId, scopes, challenge }) {
  sweepCodes()
  const code = randomBytes(24).toString('base64url')
  codes.set(code, {
    appId: String(appId),
    userId: String(userId),
    scopes: [...scopes],
    challenge: String(challenge),
    expiresAt: Date.now() + CODE_TTL_SEC * 1000,
  })
  return code
}

/**
 * 兑现一枚授权码。
 *
 * @returns {{ ok: true, appId, userId, scopes } | { error: 'invalid_grant' | 'expired_token' }}
 *
 * ⚠️ **一次性**：取出来立刻删，重放同一枚 code 直接 invalid_grant。
 * ⚠️ PKCE 用**定长比较**：code_verifier 是用户控制的，普通 === 会泄露「前几位对没对」。
 */
function redeemAuthCode(code, verifier) {
  const row = codes.get(String(code || ''))
  if (!row) return { error: 'invalid_grant' }
  codes.delete(String(code))
  if (row.expiresAt <= Date.now()) return { error: 'expired_token' }
  const got = createHash('sha256').update(String(verifier || '')).digest()
  const want = Buffer.from(row.challenge, 'base64url')
  if (got.length !== want.length || !timingSafeEqual(got, want)) return { error: 'invalid_grant' }
  return { ok: true, appId: row.appId, userId: row.userId, scopes: row.scopes }
}

/* ---------------- 参数校验（GET 和 POST 都要走一遍） ---------------- */

async function validateAuthorizeQuery(req) {
  // GET 参数在 query 里，POST（用户点同意的表单）在 body 里——两处都读
  const q = (req.method === 'POST' ? req.body : req.query) || {}
  const get = (k) => String(q[k] || '')
  const cfg = openConfig()
  if (!cfg) return { error: fail2('temporarily_unavailable', '开放平台未启用') }
  const clientId = get('client_id')
  if (!clientId) return { error: fail2('invalid_client', '缺少 client_id') }
  const app = await getApp(clientId)
  if (!app) return { error: fail2('invalid_client', 'AppID 不存在') }

  const redirectUri = get('redirect_uri')
  const uris = parseUriList(app.redirect_uris)
  if (!redirectUri || !uris.includes(redirectUri)) return { error: fail2('invalid_redirect_uri', 'redirect_uri 不在该应用的白名单里') }

  if (get('response_type') !== 'code') {
    return { error: fail2('unsupported_response_type', '只支持 response_type=code') }
  }
  const method = get('code_challenge_method')
  const challenge = get('code_challenge')
  if (!challenge || method !== 'S256') return { error: fail2('invalid_request', '必须带 code_challenge 且 method=S256（强制 PKCE）') }

  // scope：不传给「全部已获批」；传了必须是子集（user 级 scope 这里允许，正是它的用途）
  let scopes = [...parseScopes(app.approved_scopes).scopes]
  if (q.scope) {
    const parsed = parseScopes(get('scope'))
    if (parsed.unknown.length) return { error: fail2('invalid_scope', `不认识的 scope：${parsed.unknown.join(' ')}`) }
    const missing = missingScopes(parsed.scopes, parseScopes(app.approved_scopes).scopes)
    if (missing.length) return { error: fail2('invalid_scope', `应用未获批：${missing.join(' ')}`) }
    scopes = parsed.scopes
  }

  /*
    沙箱应用只能申请人自己 + 白名单；live 才对所有人开放（见 apps-repo 的 canAuthorize）。

    ⚠️ 这里**不能直接 return error**，要把结论交出去让两侧各自处理：
      · GET  同意页照常渲染，只是把「同意」按钮灰掉并说明原因 ——
        直接报错的话用户看到的是一页 JSON，不知道自己该干什么；
      · POST 真正拦下（403）。GET 上灰掉按钮只是界面，改个请求就能绕过。

    2026-09-12 审计时这里是半截的：函数硬 return access_denied、**没有**返回
    `allowed` / `reason`，而两个调用方都在读 `v.allowed`。于是 GET 回的是
    `allowed: undefined`，POST 那句 `if (!v.allowed) return 403` **对所有人恒成立** ——
    整条授权码流程是死的，而且症状是「403 该应用暂未开放」，看起来像权限配置问题。
  */
  const allowed = await canAuthorize(app, req.user.id)
  return {
    app,
    redirectUri,
    scopes,
    challenge,
    state: get('state'),
    allowed,
    reason: allowed ? '' : '该应用暂未开放给此账号授权（沙箱应用仅限申请人与测试账号）',
  }
}

/** 给 validateAuthorizeQuery 用的小包装：把 {error: [code,desc]} 翻成 fail() */
function fail2(code, desc) {
  return { fail: (res, status = 400) => fail(res, status, code, desc) }
}

/* ---------------- 授权页（GET）+ 确认（POST） ---------------- */

/** 展示用的 scope 列表：id + 中文说明 + 是否敏感。说明来自 scopes.js，不在这儿另写一份 */
function describeScopes(list) {
  return parseScopes((list || []).join(' ')).scopes.map((id) => ({
    id,
    desc: OPEN_SCOPES[id]?.desc ?? id,
    sensitive: Boolean(OPEN_SCOPES[id]?.sensitive),
  }))
}

/**
 * `GET /api/oauth/authorize` —— 渲染同意页。
 *
 * 走 JSON 还是 HTML：接入方的 SPA 会带 `Accept: application/json` 来取「要同意哪些权限」
 * 自己画界面；直接浏览器打开就给一份最小可用的 HTML（含 Approve / Deny 表单）。
 */
oauthRouter.get('/authorize', requireUser, async (req, res, next) => {
  try {
    const v = await validateAuthorizeQuery(req)
    if (v.error) return v.error.fail(res)
    const acceptsJson = String(req.headers.accept || '').includes('application/json')
    if (acceptsJson) {
      return res.json({
        client_id: v.app.id,
        app: {
          id: v.app.id,
          name: v.app.name,
          logo: v.app.logo || null,
          homepage: v.app.homepage || null,
          status: v.app.status,
        },
        scopes: describeScopes(v.scopes),
        redirect_uri: v.redirectUri,
        state: v.state,
        allowed: v.allowed,
        reason: v.reason,
      })
    }
    res.type('html').send(
      consentPage({ appName: v.app.name, scopes: v.scopes, query: req.query, allowed: v.allowed, reason: v.reason }),
    )
  } catch (e) {
    next(e)
  }
})

/**
 * `POST /api/oauth/authorize` —— 用户点了同意 / 拒绝。
 *
 * 重新校验一遍（GET 那次校验不算数，参数可能被改），然后发授权码、按 302 跳回
 * redirect_uri?code=...&state=...（浏览器流）；带 `Accept: application/json` 就回 JSON
 * `{ code, redirect_uri, state }`（SPA 自己跳）。
 */
// 同时收 JSON（前端 SPA）和 urlencoded（第三方 OAuth 库）：两者 Content-Type 不同，各解析各的，
// 匹配到的中间件干活、另一个 next() 过去，不会冲突。
/*
  ⚠️⚠️ **requireUser 是这条路由上最要紧的一个词。**

  下面 issueAuthCode 把第三方应用绑到 `req.user.id`，validateAuthorizeQuery 里的
  canAuthorize 也用它 —— 这一步就是整个授权码流程中「证明你是谁」的那一步。
  少了守卫的话，这段代码在**没有任何身份证明**的情况下铸一枚指向某个 sub 的授权码。

  2026-09-12 审计时它确实是缺的。当时没被利用，只是因为 `req.user` 恰好 undefined、
  往下解引用直接抛异常变成 500 —— 挡住它的是一个崩溃，不是一道判断。
  谁为了「修这个 500」把它换成 optionalUser，当场就变成「匿名给任意 sub 铸授权码」。

  ⚠️ 另外记一笔：requireUser 只认 `Authorization: Bearer`（auth.js 的 bearer()，不看 cookie）。
  所以自带的那个最小同意页**必须用 fetch 提交并自己带上令牌** —— 纯 HTML form
  提交不了请求头，会 401。见 consentPage。
*/
oauthRouter.post(
  '/authorize',
  requireUser,
  express.json({ limit: '16kb' }),
  express.urlencoded({ extended: false, limit: '16kb' }),
  async (req, res, next) => {
  try {
    const v = await validateAuthorizeQuery(req)
    if (v.error) return v.error.fail(res)
    // ⚠️ 沙箱应用没通过 canAuthorize 时，GET 会灰掉按钮，但 POST 必须在这里真正拦下 ——
    // 用户改请求、或者别人直接打这个端点，都不能绕过沙箱限制。
    if (!v.allowed) return fail(res, 403, 'access_denied', v.reason)

    const decision = req.body?.decision
    if (decision === 'deny') {
      return redirectWithCode(res, v.redirectUri, v.state, null, 'access_denied')
    }
    const code = issueAuthCode({
      appId: v.app.id,
      userId: req.user.id,
      scopes: v.scopes,
      challenge: v.challenge,
    })
    return redirectWithCode(res, v.redirectUri, v.state, code, null)
  } catch (e) {
    next(e)
  }
})

/** 302 跳回 redirect_uri（带 code 或 error），或 JSON 形式（SPA） */
function redirectWithCode(res, redirectUri, state, code, error) {
  const acceptsJson = String(res.req.headers.accept || '').includes('application/json')
  const u = new URL(redirectUri)
  if (code) u.searchParams.set('code', code)
  if (state) u.searchParams.set('state', state)
  if (error) u.searchParams.set('error', error)
  if (acceptsJson) {
    return res.json({ redirect_uri: redirectUri, state: state || null, code: code || null, error: error || null })
  }
  return res.redirect(302, u.href)
}

/* ---------------- 换令牌：授权码 + PKCE ---------------- */

const tokenBody = express.urlencoded({ extended: false, limit: '16kb' })

/**
 * `POST /api/oauth/token` —— grant_type=authorization_code。
 *
 * 公开客户端（SPA）不发 secret，全靠 PKCE；机密客户端要 client_secret。
 * 两种都走完后，用 issueUserToken 签一枚**用户级**令牌（kind='user'，sub=用户 id）。
 */
oauthRouter.post('/token', tokenBody, async (req, res, next) => {
  try {
    const cfg = openConfig()
    if (!cfg) return fail(res, 501, 'temporarily_unavailable', '开放平台未启用')

    if (String(req.body?.grant_type || '') !== 'authorization_code') {
      return fail(res, 400, 'unsupported_grant_type', '这个端点只支持 authorization_code')
    }

    // 两层限流：先 IP 后 client_id（理由同 open.js 的令牌端点）
    const ip = clientIpFrom(req.ip, req.headers)
    if (ip) {
      const byIp = take(`open:oauth:ip:${ip}`, 120, 3600_000)
      if (!byIp.ok) return rateLimited(res, byIp)
    }
    const { clientId, clientSecret } = readClientCredentials(req)
    if (clientId) {
      const byApp = take(`open:oauth:${clientId}`, 60, 3600_000)
      if (!byApp.ok) return rateLimited(res, byApp)
    }

    const app = await getApp(clientId)
    if (!app) return fail(res, 401, 'invalid_client', 'AppID 不存在')
    // 机密客户端必须验密钥；公开客户端靠 PKCE，没有 secret
    if (app.client_type === 'confidential') {
      const authed = await authenticateApp(clientId, clientSecret)
      if (!authed) return fail(res, 401, 'invalid_client', 'AppID 或 key 不正确')
    }

    const r = redeemAuthCode(req.body?.code, req.body?.code_verifier)
    if (!r.ok) {
      const status = r.error === 'expired_token' ? 400 : 400
      return fail(res, status, r.error, r.error === 'expired_token' ? '授权码已过期，请重新发起授权' : '授权码无效')
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
    res.json({
      access_token,
      token_type: 'Bearer',
      expires_in: OPEN_ACCESS_TTL_SEC,
      scope: r.scopes.join(' '),
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

/* ---------------- 最小同意页（开发 / 自测用；正式界面由前端 SPA 接管） ---------------- */

function consentPage({ appName, scopes, query, allowed = true, reason = '' }) {
  const scopeInputs = Object.entries(query)
    .map(([k, v]) => `<input type="hidden" name="${esc(k)}" value="${esc(String(v))}">`)
    .join('')
  const scopeList = scopes.map((s) => `<li><code>${esc(s)}</code></li>`).join('')
  const reasonHtml = !allowed ? `<p style="color:#c0392b">${esc(reason)}</p>` : ''
  return `<!doctype html><html lang="zh"><head><meta charset="utf-8"><title>授权 ${esc(appName)}</title></head>
<body style="font-family:system-ui,sans-serif;max-width:32rem;margin:4rem auto">
<h2>授权 <b>${esc(appName)}</b> 访问你的 8BitGo 账号？</h2>
<p>该应用将获得以下权限：</p><ul>${scopeList}</ul>
${reasonHtml}
<form method="post" action="/api/oauth/authorize">
${scopeInputs}
<button name="decision" value="approve" type="submit"${allowed ? '' : ' disabled'}>同意</button>
<button name="decision" value="deny" type="submit">拒绝</button>
</form></body></html>`
}

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])
}
