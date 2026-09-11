/**
 * 后台的应用审核。`/api/admin/open-apps/*`，权限点 **`apps:review`**（当下只给 admin）。
 *
 * 为什么单独一个权限点，而不是塞进 `content:edit` 或 `site:manage`：
 * 批一个应用上产 = 把站外的一把 key 放进生产环境，它能读真实用户的数据、能领 ROM 凭据。
 * 那不是「改内容」，是**对外授权** —— 改错内容看得见也改得回来，而发出去的 key 收不回来。
 * 想以后放给运营，改 `shared/roles.js` 里 volunteer 那一行就够，不用回头改路由。
 *
 * 判断全在 `open/review.js`（纯函数、可测）；这里只做鉴权、取行、落库、**留痕**。
 */
import { Router } from 'express'
import { requireAbility } from '../auth.js'
import { CACHE } from '../cache.js'
import {
  appForReviewer,
  getApp,
  getAppForReview,
  listForReview,
  listReviews,
  listSecrets,
  listTesters,
  logReview,
  patchApp,
} from '../open/apps-repo.js'
import { approve, reject, restore, sensitiveAsks, suspend } from '../open/review.js'
import { SENSITIVE_SCOPES } from '../open/scopes.js'

export const adminOpenAppsRouter = Router()
adminOpenAppsRouter.use(requireAbility('apps:review'))
adminOpenAppsRouter.use((_req, res, next) => {
  res.set('Cache-Control', CACHE.none)
  next()
})

const bad = (res, code, message, status = 400) => res.status(status).json({ error: message, code })

function fromReview(res, r) {
  return bad(res, r.code, r.message, r.code === 'not_found' ? 404 : 400)
}

/** 审核人做完动作后统一的回包：应用 + 流水，界面一次拿全 */
async function shape(appId) {
  const app = await getAppForReview(appId)
  return { app: appForReviewer(app), reviews: await listReviews(appId) }
}

/**
 * 队列。默认 `?state=pending`，**按提交时间正序** —— 先交的先审。
 * `?state=` 传空串就是全部（用来翻历史）。
 */
adminOpenAppsRouter.get('/', async (req, res, next) => {
  try {
    const state = req.query.state === undefined ? 'pending' : String(req.query.state)
    const rows = await listForReview({ state, status: req.query.status ? String(req.query.status) : '' })
    res.json({
      items: rows.map((r) => ({
        ...appForReviewer(r),
        /** 申请单里的敏感项，界面上要标出来 —— 这几个是真正需要人看一眼的 */
        sensitive: sensitiveAsks(r.requested_scopes),
      })),
      sensitiveScopes: [...SENSITIVE_SCOPES],
    })
  } catch (e) {
    next(e)
  }
})

adminOpenAppsRouter.get('/:id', async (req, res, next) => {
  try {
    // join users 的那一版：审核最要看的一条就是「申请人是谁」
    const app = await getAppForReview(req.params.id)
    if (!app) return bad(res, 'not_found', '应用不存在', 404)
    res.json({
      app: appForReviewer(app),
      reviews: await listReviews(app.id),
      // 密钥只给提示位和最后使用时间：审核人判断「这个应用真的在跑吗」靠它，
      // 而明文和哈希谁都看不到
      secrets: await listSecrets(app.id),
      testers: await listTesters(app.id),
      sensitive: sensitiveAsks(app.requested_scopes),
    })
  } catch (e) {
    next(e)
  }
})

/**
 * 批准上产。`scopes` 可以少于申请的（「元数据和登录给你，ROM 先不给」是常态），
 * 不能多于申请的 —— 批了人家没申请的东西，一是他不知道自己有，二是出事时说不清是谁要的。
 */
adminOpenAppsRouter.post('/:id/approve', async (req, res, next) => {
  try {
    const app = await getApp(req.params.id)
    const r = approve(app, { scopes: req.body?.scopes, tier: req.body?.tier, note: req.body?.note })
    if (!r.ok) return fromReview(res, r)
    await patchApp(app.id, { ...r.patch, reviewed_by: req.user.id, reviewed_at: new Date() })
    await logReview(app.id, req.user.id, r.event.action, r.event.detail)
    res.json(await shape(app.id))
  } catch (e) {
    next(e)
  }
})

/** 打回。理由必填，**会原样给申请人看** —— 没有理由的「已拒绝」只换来一次一样的重新提交 */
adminOpenAppsRouter.post('/:id/reject', async (req, res, next) => {
  try {
    const app = await getApp(req.params.id)
    const r = reject(app, { reason: req.body?.reason })
    if (!r.ok) return fromReview(res, r)
    await patchApp(app.id, { ...r.patch, reviewed_by: req.user.id, reviewed_at: new Date() })
    await logReview(app.id, req.user.id, r.event.action, r.event.detail)
    res.json(await shape(app.id))
  } catch (e) {
    next(e)
  }
})

/**
 * 停用（急停）。
 *
 * ⚠️ **已经发出去的 access token 不会当场失效**，最长还有 15 分钟
 * （自包含 JWT，验的时候不查库）。回包里把这一条明确带出去，让界面照着说 ——
 * 不说的话，处置的人会以为点完就断了。
 */
adminOpenAppsRouter.post('/:id/suspend', async (req, res, next) => {
  try {
    const app = await getApp(req.params.id)
    const r = suspend(app, { reason: req.body?.reason })
    if (!r.ok) return fromReview(res, r)
    await patchApp(app.id, { ...r.patch, reviewed_by: req.user.id, reviewed_at: new Date() })
    await logReview(app.id, req.user.id, r.event.action, r.event.detail)
    res.json({
      ...(await shape(app.id)),
      notice: '已停用：不能再换新令牌、不能再领 ROM 凭据。⚠️ 已经发出去的令牌最长还有 15 分钟有效。',
    })
  } catch (e) {
    next(e)
  }
})

/** 恢复。回到**停用前那一档**，不是一律回 live（否则沙箱应用被停一次反而绕过了审核） */
adminOpenAppsRouter.post('/:id/restore', async (req, res, next) => {
  try {
    const app = await getApp(req.params.id)
    const r = restore(app)
    if (!r.ok) return fromReview(res, r)
    await patchApp(app.id, { ...r.patch, reviewed_by: req.user.id, reviewed_at: new Date() })
    await logReview(app.id, req.user.id, r.event.action, r.event.detail)
    res.json(await shape(app.id))
  } catch (e) {
    next(e)
  }
})
