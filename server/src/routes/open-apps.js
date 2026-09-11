/**
 * 开发者控制台的后端。`/api/open-apps/*`，**站内接口**（要登录、走站内 CORS 白名单）。
 *
 * ⚠️ 和 `/api/open/*` 是两套东西，别混：
 *   · `/api/open/*`      第三方**用 key 调的**开放接口，CORS 放开到任意 Origin、RS256 令牌；
 *   · `/api/open-apps/*` 本站用户**管理自己应用的**页面接口，登录态 + 站内 CORS。
 * 把它挂到 openRouter 下面会顺带把「管理应用」也放开到任意 Origin —— 那等于
 * 任何网站都能拿着受害者的登录态替他建应用、轮换密钥。
 *
 * 判断全在 `open/review.js`（纯函数、可测）；这里只做鉴权、取行、落库、留痕。
 */
import { Router } from 'express'
import { requireUser } from '../auth.js'
import { take } from '../rateLimit.js'
import { CACHE } from '../cache.js'
import {
  addTester,
  appForOwner,
  countAppsOfOwner,
  createApp,
  getApp,
  issueSecret,
  listAppsOfOwner,
  listReviews,
  listSecrets,
  listTesters,
  logReview,
  MAX_APPS_PER_OWNER,
  patchApp,
  removeTester,
  revokeSecret,
} from '../open/apps-repo.js'
import { editable, parseUriList, splitOnCreate, submit, withdraw } from '../open/review.js'
import { parseScopes } from '../open/scopes.js'

export const openAppsRouter = Router()
openAppsRouter.use(requireUser)
openAppsRouter.use((_req, res, next) => {
  res.set('Cache-Control', CACHE.none)
  next()
})

const bad = (res, code, message, status = 400) => res.status(status).json({ error: message, code })

/** review.js 的失败形状 -> HTTP */
function fromReview(res, r) {
  const status = r.code === 'not_found' ? 404 : r.code === 'locked_while_pending' ? 409 : 400
  return bad(res, r.code, r.message, status)
}

/**
 * 拿到自己的应用。**不是自己的一律 404，不是 403** ——
 * 403 会告诉对方「这个 id 存在」，而 app id 是可以枚举着试的。
 */
async function ownApp(req, res) {
  const app = await getApp(req.params.id)
  if (!app || String(app.owner_id) !== String(req.user.id)) {
    bad(res, 'not_found', '应用不存在', 404)
    return null
  }
  return app
}

/* ---------------- 列表与创建 ---------------- */

openAppsRouter.get('/', async (req, res, next) => {
  try {
    const rows = await listAppsOfOwner(req.user.id)
    res.json({ items: rows.map(appForOwner), maxApps: MAX_APPS_PER_OWNER })
  } catch (e) {
    next(e)
  }
})

const NAME_MIN = 2
const NAME_MAX = 60

/**
 * 建应用。**当场进沙箱、当场发第一把 key**，不排队等审核。
 *
 * 为什么不是「审核通过才发 key」：开发者在审核前一行代码都跑不了，于是申请单上写的
 * 只能是意向，而你无从判断。先给沙箱之后，你审的是「他真的做出东西了」。
 * 而「拿 key 去钓鱼」在审核前也走不通 —— 沙箱应用只能授权给白名单账号
 * （见 apps-repo.js 的 canAuthorize）。
 *
 * ⚠️ 响应里的 `secret` 是**唯一一次**能看到它的机会，库里只有 bcrypt 哈希。
 * 界面上必须让人当场复制走，并说清「丢了只能轮换，不能再看」。
 */
openAppsRouter.post('/', async (req, res, next) => {
  try {
    /*
      ⚠️ 这个额度必须比 MAX_APPS_PER_OWNER **宽**。
      两者一样（都是 10）的话，一个正常用户永远撞不到「最多 10 个应用」那句提示 ——
      他先撞上「建得太频繁」，而这两句话的下一步动作完全不同：
      一句是「等一小时」，另一句是「先删掉一个」。
    */
    const gate = take(`open-apps:create:${req.user.id}`, MAX_APPS_PER_OWNER * 2, 3600_000)
    if (!gate.ok) return res.status(429).set('Retry-After', String(gate.retryAfter)).json({ error: '建得太频繁了，稍后再试', code: 'rate_limited' })

    const name = String(req.body?.name ?? '').trim()
    if (name.length < NAME_MIN || name.length > NAME_MAX) return bad(res, 'bad_name', `应用名需要 ${NAME_MIN}–${NAME_MAX} 个字符`)

    if ((await countAppsOfOwner(req.user.id)) >= MAX_APPS_PER_OWNER) {
      return bad(res, 'too_many_apps', `一个账号最多 ${MAX_APPS_PER_OWNER} 个应用`)
    }

    const split = splitOnCreate(req.body?.scopes ?? 'games.read')
    if (!split.ok) return fromReview(res, split)

    const uris = cleanList(req.body?.redirectUris, { sandbox: true })
    if (uris.error) return bad(res, 'bad_redirect', uris.error)
    const origins = cleanList(req.body?.embedOrigins, { originOnly: true })
    if (origins.error) return bad(res, 'bad_origin', origins.error)

    const { id, secret } = await createApp(req.user.id, {
      name,
      description: String(req.body?.description ?? '').slice(0, 2000),
      homepage: String(req.body?.homepage ?? '').slice(0, 300),
      privacyUrl: String(req.body?.privacyUrl ?? '').slice(0, 300),
      clientType: req.body?.clientType === 'public' ? 'public' : 'confidential',
      redirectUris: uris.list,
      embedOrigins: origins.list,
      requestedScopes: split.requested,
    // ⚠️ 第三个参数是**已批**的那份（自助只给 games.read）。
    // 漏了它 createApp 会当场抛 —— 测试第一条就是撞在这儿的
    }, split.granted)
    const app = await getApp(id)
    res.status(201).json({
      app: appForOwner(app),
      /** ⚠️ 只有这一次 */
      secret,
      secretNotice: '这是唯一一次显示 AppKey 的机会。请立刻保存；丢了只能新建一把（轮换），不能再看。',
    })
  } catch (e) {
    next(e)
  }
})

/* ---------------- 单个应用 ---------------- */

openAppsRouter.get('/:id', async (req, res, next) => {
  try {
    const app = await ownApp(req, res)
    if (!app) return
    res.json({
      app: appForOwner(app),
      secrets: await listSecrets(app.id),
      testers: app.status === 'sandbox' ? await listTesters(app.id) : [],
      reviews: await listReviews(app.id),
    })
  } catch (e) {
    next(e)
  }
})

openAppsRouter.patch('/:id', async (req, res, next) => {
  try {
    const app = await ownApp(req, res)
    if (!app) return
    const patch = {}
    if (req.body?.name !== undefined) {
      const name = String(req.body.name).trim()
      if (name.length < NAME_MIN || name.length > NAME_MAX) return bad(res, 'bad_name', `应用名需要 ${NAME_MIN}–${NAME_MAX} 个字符`)
      patch.name = name
    }
    if (req.body?.description !== undefined) patch.description = String(req.body.description).slice(0, 2000)
    if (req.body?.homepage !== undefined) patch.homepage = String(req.body.homepage).slice(0, 300)
    if (req.body?.privacyUrl !== undefined) patch.privacy_url = String(req.body.privacyUrl).slice(0, 300)
    if (req.body?.redirectUris !== undefined) {
      const r = cleanList(req.body.redirectUris, { sandbox: app.status === 'sandbox' })
      if (r.error) return bad(res, 'bad_redirect', r.error)
      patch.redirect_uris = JSON.stringify(r.list)
    }
    if (req.body?.embedOrigins !== undefined) {
      const r = cleanList(req.body.embedOrigins, { originOnly: true })
      if (r.error) return bad(res, 'bad_origin', r.error)
      patch.embed_origins = JSON.stringify(r.list)
    }
    if (req.body?.scopes !== undefined) {
      const { scopes, unknown } = parseScopes(req.body.scopes)
      if (unknown.length) return bad(res, 'unknown_scope', `不认识的 scope：${unknown.join(' ')}`)
      patch.requested_scopes = scopes.join(' ')
    }

    // ⚠️ 审核中锁住权限相关的字段，否则「审的是 A、批的是 B」（见 review.js 的 LOCKED_WHILE_PENDING）
    const gate = editable(app, patch)
    if (!gate.ok) return fromReview(res, gate)

    await patchApp(app.id, patch)
    res.json({ app: appForOwner(await getApp(app.id)) })
  } catch (e) {
    next(e)
  }
})

/* ---------------- 密钥 ---------------- */

openAppsRouter.post('/:id/secrets', async (req, res, next) => {
  try {
    const app = await ownApp(req, res)
    if (!app) return
    if (app.client_type === 'public') return bad(res, 'public_client', '公开客户端不发密钥（前端藏不住密钥）')
    const secret = await issueSecret(app.id)
    res.status(201).json({
      secret,
      secrets: await listSecrets(app.id),
      secretNotice: '新密钥已生效，旧的**仍然可用**。请先把线上换成新的，再回来撤销旧的那一把。',
    })
  } catch (e) {
    if (e?.code === 'too_many_secrets') return bad(res, e.code, e.message)
    next(e)
  }
})

openAppsRouter.delete('/:id/secrets/:secretId', async (req, res, next) => {
  try {
    const app = await ownApp(req, res)
    if (!app) return
    const ok = await revokeSecret(app.id, req.params.secretId, { clientType: app.client_type })
    if (!ok) return bad(res, 'not_found', '没有这把密钥', 404)
    res.json({ secrets: await listSecrets(app.id) })
  } catch (e) {
    if (e?.code === 'last_secret') return bad(res, e.code, e.message, 409)
    next(e)
  }
})

/* ---------------- 沙箱测试账号 ---------------- */

openAppsRouter.get('/:id/testers', async (req, res, next) => {
  try {
    const app = await ownApp(req, res)
    if (!app) return
    res.json({ testers: await listTesters(app.id) })
  } catch (e) {
    next(e)
  }
})

openAppsRouter.post('/:id/testers', async (req, res, next) => {
  try {
    const app = await ownApp(req, res)
    if (!app) return
    if (app.status !== 'sandbox') return bad(res, 'not_sandbox', '上产之后不再需要测试账号白名单')
    // 按邮箱找人，和 /api/im/lookup 同一条限流理由：这是个「邮箱有没有注册」的探针
    const gate = take(`open-apps:tester:${req.user.id}`, 20, 3600_000)
    if (!gate.ok) return res.status(429).set('Retry-After', String(gate.retryAfter)).json({ error: '查得太频繁了', code: 'rate_limited' })
    const r = await addTester(app.id, String(req.body?.email ?? ''))
    if (!r.ok) {
      // ⚠️ 查不到和被封禁回同一句话 —— 否则这里成了账号探针
      if (r.code === 'too_many') return bad(res, r.code, '测试账号已满')
      return bad(res, 'not_found', '没有找到这个邮箱对应的用户', 404)
    }
    res.status(201).json({ testers: await listTesters(app.id) })
  } catch (e) {
    next(e)
  }
})

openAppsRouter.delete('/:id/testers/:userId', async (req, res, next) => {
  try {
    const app = await ownApp(req, res)
    if (!app) return
    await removeTester(app.id, req.params.userId)
    res.json({ testers: await listTesters(app.id) })
  } catch (e) {
    next(e)
  }
})

/* ---------------- 上产申请 ---------------- */

openAppsRouter.post('/:id/submit', async (req, res, next) => {
  try {
    const app = await ownApp(req, res)
    if (!app) return
    const r = submit(app, { note: req.body?.note, requestedScopes: req.body?.scopes ?? app.requested_scopes })
    if (!r.ok) return fromReview(res, r)
    await patchApp(app.id, { ...r.patch, submitted_at: new Date() })
    await logReview(app.id, req.user.id, r.event.action, r.event.detail)
    res.json({ app: appForOwner(await getApp(app.id)), reviews: await listReviews(app.id) })
  } catch (e) {
    next(e)
  }
})

openAppsRouter.post('/:id/withdraw', async (req, res, next) => {
  try {
    const app = await ownApp(req, res)
    if (!app) return
    const r = withdraw(app)
    if (!r.ok) return fromReview(res, r)
    await patchApp(app.id, r.patch)
    await logReview(app.id, req.user.id, r.event.action, null)
    res.json({ app: appForOwner(await getApp(app.id)), reviews: await listReviews(app.id) })
  } catch (e) {
    next(e)
  }
})

/* ---------------- 校验：回调地址与嵌入域名 ---------------- */

/**
 * 回调地址的校验。**精确匹配是 OAuth 安全的地基**，所以这里也严：
 *
 *   · 必须是绝对 URL；
 *   · **不许带 fragment**（`#…`）—— 授权码是拼在 query 上的，带 fragment 的地址
 *     在拼接时会出现「参数跑到 # 后面」这种谁都想不到的形状；
 *   · 生产必须 https；沙箱额外放行 `http://localhost` 和 `http://127.0.0.1`
 *     （本机开发没有 https，硬要求会把所有人挡在门外）；
 *   · 去重、条数上限。
 */
function cleanList(raw, { sandbox = false, originOnly = false } = {}) {
  const input = Array.isArray(raw) ? raw : String(raw ?? '').split(/[\s,]+/)
  const list = []
  for (const item of input) {
    const s = String(item ?? '').trim()
    if (!s) continue
    let u
    try {
      u = new URL(s)
    } catch {
      return { error: `不是合法地址：${s}` }
    }
    if (!/^https?:$/.test(u.protocol)) return { error: `只支持 http(s)：${s}` }
    if (u.hash) return { error: `地址里不能带 #：${s}` }
    const localhost = u.hostname === 'localhost' || u.hostname === '127.0.0.1'
    if (u.protocol === 'http:' && !(sandbox && localhost)) {
      return { error: `必须是 https（沙箱可以用 http://localhost）：${s}` }
    }
    if (originOnly) {
      if (u.pathname !== '/' || u.search) return { error: `嵌入域名只要协议 + 域名，不要路径：${s}` }
      const v = u.origin
      if (!list.includes(v)) list.push(v)
      continue
    }
    // 回调地址要**原样**存：精确匹配就是拿这个串去比的，规整一下反而会对不上
    if (!list.includes(s)) list.push(s)
  }
  const cap = sandbox ? 3 : 10
  if (list.length > cap) return { error: `最多 ${cap} 条` }
  return { list }
}

export { cleanList as validateUriList, parseUriList }
