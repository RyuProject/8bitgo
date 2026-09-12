/**
 * 开放平台的**申请与审核状态机**。纯函数、零依赖，可以在 node 里直接跑。
 *
 * ## 采用的模型：先沙箱，上产再审（2026-09-11 站长拍板）
 *
 * 另一条路是「审核通过才发 key」。没选它的理由：开发者在审核前**一行代码都跑不了**，
 * 于是申请单上写的只能是意向（「我想做个游戏聚合站」），而你无从判断 ——
 * 批或不批都是猜。先给沙箱之后，你审的是「他真的做出东西了」：
 * 回调地址是不是真的、嵌入域名有没有站、用量曲线上有没有真实调用。
 *
 * 而「拿 key 去钓鱼」这条路在审核前也走不通，因为**沙箱应用只能授权给白名单账号**
 * （申请人自己 + 最多 5 个测试号）。这是整个模型成立的关键一条，不是配额优化。
 *
 * ## 两个状态，别合成一个
 *
 *   status        应用当下的**能力**：sandbox / live / suspended
 *   review_state  上产申请的**流转**：none / pending / rejected
 *
 * 合成一个枚举（sandbox/pending/live/rejected/suspended）看着更简单，但会丢信息：
 * 一个正在申请上产的应用**仍然是可用的沙箱应用**，它的 key 照旧能调接口。
 * 合并之后 `status === 'pending'` 那一刻，所有「这个应用能不能用」的判断都得跟着改，
 * 而漏改一处的症状是「提交申请之后沙箱突然不能用了」。
 *
 *   sandbox + none      刚建好，或者被打回之后改完还没再提交
 *   sandbox + pending   申请上产中（沙箱照旧可用）
 *   sandbox + rejected  被打回，理由在 review_reason 里
 *   live    + none      已上产
 *   suspended + *       被处置。**令牌不会当场失效**，最长还有 15 分钟（见文件尾）
 */

import { APP_SCOPES, OPEN_SCOPES, SENSITIVE_SCOPES, missingScopes, parseScopes } from './scopes.js'

export const APP_STATUSES = Object.freeze(['sandbox', 'live', 'suspended'])
export const REVIEW_STATES = Object.freeze(['none', 'pending', 'rejected'])

/**
 * 自助创建时**直接给**的 scope。
 *
 * 只有 `games.read`：它读的是我们本来就公开在网站上的东西（游戏列表、简介、封面），
 * 拿它做不了任何不可逆的事。其余一律要审：
 *   · `games.rom` —— 把游戏本体带出站；
 *   · `openid/profile/email` —— 拿到真实用户；
 *   · `library.*` / `saves.*` —— 写玩家的数据，`saves.write` 能覆盖几十小时的进度。
 */
export const SELF_SERVE_SCOPES = Object.freeze(['games.read'])

/** 沙箱期的硬限制。写在这儿是为了让接口和界面读同一份，别各写一遍 */
export const SANDBOX_LIMITS = Object.freeze({
  /** 回调地址条数；沙箱允许 http://localhost */
  redirectUris: 3,
  /** 除申请人自己以外，还能加几个测试账号 */
  testers: 5,
  /** 每小时接口调用 */
  qps: 5,
  callsPerDay: 10_000,
})

export const LIVE_LIMITS = Object.freeze({
  redirectUris: 10,
  testers: 0, // 上产之后不限授权对象，这张白名单就不用了
  qps: 50,
  callsPerDay: 200_000,
})

export function limitsFor(status) {
  return status === 'live' ? LIVE_LIMITS : SANDBOX_LIMITS
}

/** 申请单必填的说明有多长。太短的一律退回 —— 一句「做个网站」审不了 */
export const REVIEW_NOTE_MIN = 30
export const REVIEW_NOTE_MAX = 2000
/** 打回 / 处置理由。会原样给申请人看，所以必填 */
export const REVIEW_REASON_MAX = 500

/**
 * 这个应用现在能不能调接口。
 *
 * ⚠️ `pending` **不影响可用性** —— 见文件头。写成「pending 就停」的话，
 * 开发者一提交申请，他正在调试的东西当场全断。
 */
export function isUsable(app) {
  return app?.status === 'sandbox' || app?.status === 'live'
}

/**
 * 审核中锁住哪些字段。
 *
 * ⚠️ 这一条是审核有意义的前提：不锁的话，提交之后把 `requested_scopes` 改成
 * `saves.write`、把回调地址换成别人的域名，而你批的还是当初看到的那一版 ——
 * **审的是 A，批的是 B**。这类漏洞在真实的开放平台里出过不止一次。
 *
 * 名字、简介、logo 这些**不锁**：它们不影响权限，改了也不会让审核结论失真，
 * 而锁住它们只会让「填错一个字要先撤回申请」。
 */
export const LOCKED_WHILE_PENDING = Object.freeze(['requested_scopes', 'redirect_uris', 'embed_origins', 'client_type'])

export function lockedFields(app) {
  return app?.review_state === 'pending' ? [...LOCKED_WHILE_PENDING] : []
}

/** 统一的失败形状：`{ ok: false, code, message }`，code 给界面查文案，message 给人看 */
const no = (code, message) => ({ ok: false, code, message })
const yes = (patch, event) => ({ ok: true, patch, event })

/**
 * 创建应用时，请求的 scope 里哪些是不能自助拿的。
 * **不报错、也不静默丢掉**：写进 `requested_scopes` 等着审，`approved_scopes` 里只给自助那部分。
 * 这样开发者在界面上看到的是「已获批 games.read，待审核 games.rom」，而不是一句
 * 「你申请的东西没了」或者一个他看不懂的 400。
 */
export function splitOnCreate(requested) {
  const { scopes, unknown } = parseScopes(requested)
  if (unknown.length) return no('unknown_scope', `不认识的 scope：${unknown.join(' ')}`)
  const granted = scopes.filter((s) => SELF_SERVE_SCOPES.includes(s))
  const pending = scopes.filter((s) => !SELF_SERVE_SCOPES.includes(s))
  // games.read 一律给上：一个连游戏列表都读不了的应用，建出来没有任何事可做
  if (!granted.includes('games.read')) granted.unshift('games.read')
  return { ok: true, granted, pending, requested: scopes }
}

/**
 * 提交上产申请。
 *
 * @param app  应用当前行（status / review_state / requested_scopes / redirect_uris …）
 * @param o    { note, requestedScopes }
 */
export function submit(app, o = {}) {
  if (!app) return no('not_found', '应用不存在')
  if (app.status === 'suspended') return no('suspended', '应用已被停用，请先联系我们')
  if (app.status === 'live') return no('already_live', '这个应用已经在生产环境了')
  if (app.review_state === 'pending') return no('already_pending', '已经在审核中了')

  const note = String(o.note ?? '').trim()
  if (note.length < REVIEW_NOTE_MIN) {
    return no('note_too_short', `用途说明至少 ${REVIEW_NOTE_MIN} 个字 —— 太短的没法审`)
  }
  if (note.length > REVIEW_NOTE_MAX) return no('note_too_long', '用途说明太长了')

  const { scopes, unknown } = parseScopes(o.requestedScopes ?? app.requested_scopes)
  if (unknown.length) return no('unknown_scope', `不认识的 scope：${unknown.join(' ')}`)
  if (!scopes.length) return no('no_scope', '至少要申请一个 scope')

  /*
    ⚠️ 上产必须有 https 回调地址 —— 只有申请 OIDC 那几个 scope 时才需要。
    纯应用级的应用（只读游戏库）根本没有回调这回事，硬性要求会把它们挡在门外。
  */
  const needsRedirect = scopes.some((s) => OPEN_SCOPES[s]?.kind === 'user')
  const uris = asList(app.redirect_uris)
  if (needsRedirect) {
    if (!uris.length) return no('no_redirect', '需要用户授权的权限（library.* / saves.* / openid 等）必须先在控制台登记回调地址')
    const bad = uris.filter((u) => !/^https:\/\//i.test(u))
    if (bad.length) return no('insecure_redirect', `上产的回调地址必须是 https：${bad.join(' ')}`)
  }

  return yes(
    { review_state: 'pending', review_note: note, requested_scopes: scopes.join(' '), review_reason: null },
    { action: 'submit', detail: note },
  )
}

/** 申请人自己撤回。撤回之后回到 none，可以继续改 */
export function withdraw(app) {
  if (!app) return no('not_found', '应用不存在')
  if (app.review_state !== 'pending') return no('not_pending', '当前没有在审核的申请')
  return yes({ review_state: 'none' }, { action: 'withdraw' })
}

/**
 * 批准上产。
 *
 * `scopes` 是**审核人最终批的那一份**，可以少于申请的（批一部分是常态：
 * 「元数据和登录给你，ROM 先不给」）。**不能多于申请的** —— 批了人家没申请的东西，
 * 一是他不知道自己有，二是出事时说不清是谁要的。
 */
export function approve(app, o = {}) {
  if (!app) return no('not_found', '应用不存在')
  if (app.review_state !== 'pending') return no('not_pending', '这个应用没有在审核的申请')

  const asked = parseScopes(app.requested_scopes).scopes
  const { scopes, unknown } = parseScopes(o.scopes ?? app.requested_scopes)
  if (unknown.length) return no('unknown_scope', `不认识的 scope：${unknown.join(' ')}`)
  if (!scopes.length) return no('no_scope', '至少要批一个 scope；一个都不给的话用「打回」')
  const extra = missingScopes(scopes, asked)
  if (extra.length) return no('scope_not_requested', `申请单里没有这些：${extra.join(' ')}`)

  // 上产之后测试账号白名单就不再生效，界面上要跟着收起来（见 limitsFor）
  return yes(
    {
      status: 'live',
      review_state: 'none',
      approved_scopes: scopes.join(' '),
      rate_tier: String(o.tier || 'live'),
      review_reason: null,
    },
    { action: 'approve', detail: scopes.join(' ') + (o.note ? ` · ${String(o.note).trim()}` : '') },
  )
}

/**
 * 打回。**理由必填**，而且会原样给申请人看 ——
 * 一个没有理由的「已拒绝」只会换来一次一模一样的重新提交。
 */
export function reject(app, o = {}) {
  if (!app) return no('not_found', '应用不存在')
  if (app.review_state !== 'pending') return no('not_pending', '这个应用没有在审核的申请')
  const reason = String(o.reason ?? '').trim()
  if (!reason) return no('no_reason', '打回必须写理由（申请人会看到）')
  if (reason.length > REVIEW_REASON_MAX) return no('reason_too_long', '理由太长了')
  // ⚠️ 打回**不动** approved_scopes：他自助拿到的 games.read 还在，沙箱继续能用。
  // 顺手清掉的话，被打回一次就等于连调试环境一起没了。
  return yes({ review_state: 'rejected', review_reason: reason }, { action: 'reject', detail: reason })
}

/**
 * 停用。出事时的急停：立刻不能换新令牌、不能领凭据。
 *
 * ⚠️ **已经发出去的 access token 不会当场失效**，最长还有 15 分钟
 * （它是自包含的 JWT，验的时候不查库，见 open/tokens.js 的 OPEN_ACCESS_TTL_SEC）。
 * 真要「立刻」，得给验证中间件加一张吊销名单查询 —— 那是另一件事，本期没做。
 * 界面上必须把这 15 分钟说出来，别让人以为点完就断了。
 */
export function suspend(app, o = {}) {
  if (!app) return no('not_found', '应用不存在')
  if (app.status === 'suspended') return no('already_suspended', '已经是停用状态')
  const reason = String(o.reason ?? '').trim()
  if (!reason) return no('no_reason', '停用必须写理由')
  return yes(
    { status: 'suspended', review_state: 'none', review_reason: reason, suspended_from: app.status },
    { action: 'suspend', detail: reason },
  )
}

/**
 * 恢复。**回到停用前的那一档**，不是一律回 live ——
 * 一个从沙箱被停用的应用，恢复之后直接进生产等于绕过了审核。
 */
export function restore(app) {
  if (!app) return no('not_found', '应用不存在')
  if (app.status !== 'suspended') return no('not_suspended', '这个应用没有被停用')
  const back = app.suspended_from === 'live' ? 'live' : 'sandbox'
  return yes({ status: back, review_reason: null, suspended_from: null }, { action: 'restore', detail: back })
}

/**
 * 改资料。审核中锁着的字段一律拒绝（见 LOCKED_WHILE_PENDING）。
 * @returns {{ ok: true, patch }} | 失败
 */
export function editable(app, patch = {}) {
  if (!app) return no('not_found', '应用不存在')
  const locked = lockedFields(app)
  const hit = Object.keys(patch).filter((k) => locked.includes(k))
  if (hit.length) {
    return no('locked_while_pending', `审核中不能改：${hit.join(' ')}。要改请先撤回申请`)
  }
  return { ok: true, patch }
}

/** 申请单里出现敏感 scope 时，给审核人显示的提示（界面上标红那几条） */
export function sensitiveAsks(requested) {
  return parseScopes(requested).scopes.filter((s) => SENSITIVE_SCOPES.includes(s))
}

/** 这批 scope 里有没有需要回调地址的（用户级） */
export function needsRedirectUri(scopes) {
  return parseScopes(scopes).scopes.some((s) => OPEN_SCOPES[s]?.kind === 'user')
}

/** 应用级 scope 的子集，界面上「不用审就能用的」那一栏 */
export function appLevel(scopes) {
  return parseScopes(scopes).scopes.filter((s) => APP_SCOPES.includes(s))
}

function asList(raw) {
  if (Array.isArray(raw)) return raw.map(String)
  try {
    const v = JSON.parse(String(raw || '[]'))
    return Array.isArray(v) ? v.map(String) : []
  } catch {
    return []
  }
}
export { asList as parseUriList }
