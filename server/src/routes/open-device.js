/**
 * 设备码流程里**用户确认那一步**的后端。`/api/open-device/*`。
 *
 * ⚠️ 这是**站内接口**（要登录、走站内 CORS 白名单），和 `/api/open/*` 不是一套 ——
 * 理由和 open-apps.js 文件头写的一样：挂到 openRouter 下面会把它放开到任意 Origin，
 * 于是任何网站都能拿着受害者的登录态替他批准一台设备。那是这套流程最坏的失败方式。
 *
 * 三条路：
 *   GET  /api/open-device/:code   这串码是哪个应用要的、要哪些权限（确认页展示用）
 *   POST /api/open-device/:code   {approve:true}  同意
 *   POST /api/open-device/:code   {approve:false} 拒绝
 */
import { Router } from 'express'
import { requireUser } from '../auth.js'
import { take } from '../rateLimit.js'
import { getApp, canAuthorize } from '../open/apps-repo.js'
import { OPEN_SCOPES, parseScopes } from '../open/scopes.js'
import { approveDeviceAuth, denyDeviceAuth, findByUserCode, normalizeUserCode } from '../open/device.js'

export const openDeviceRouter = Router()
openDeviceRouter.use(requireUser)

/**
 * 用户码的爆破面。
 *
 * 8 位、28 个字符的字母表 ≈ 3.8e11 种，但同一时刻**活着的码只有几十上百串** ——
 * 猜中一串就等于把某个人的账号授权给攻击者自己的应用。所以这一层限流不是省资源，
 * 是这串码够不够安全的一部分：每个账号每小时最多试 60 次，
 * 再配上 15 分钟的有效期，猜中的概率可以忽略。
 */
function lookupGate(req, res) {
  const gate = take(`open-device:${req.user.id}`, 60, 3600_000)
  if (gate.ok) return true
  res.status(429).set('Retry-After', String(gate.retryAfter)).json({ error: '试得太频繁了，等一会儿再试' })
  return false
}

/** 展示用的 scope 列表：码 + 中文说明。说明来自 scopes.js，不在这儿另写一份 */
function describeScopes(list) {
  return parseScopes((list || []).join(' ')).scopes.map((id) => ({
    id,
    desc: OPEN_SCOPES[id]?.desc ?? id,
    sensitive: Boolean(OPEN_SCOPES[id]?.sensitive),
  }))
}

openDeviceRouter.get('/:code', async (req, res, next) => {
  try {
    if (!lookupGate(req, res)) return
    const row = findByUserCode(req.params.code)
    /*
      码不对、过期、已经被用掉 —— 对外一律同一句话。
      分开说的话（「这串码已经批过了」）就等于告诉试码的人「这串是存在的」，
      而那正是爆破最需要的信号。
    */
    if (!row) return res.status(404).json({ error: '这串码无效或已过期' })
    const app = await getApp(row.appId)
    if (!app) return res.status(404).json({ error: '这串码无效或已过期' })

    /*
      ⚠️ 沙箱应用只能向**申请人自己 + 测试账号**要授权（apps-repo.js 的 canAuthorize）。
      这一条是「先沙箱后审核」整个模型的立足点：没有它，一把没审过的 key
      就能拿去向任意用户请求授权，也就是钓鱼。设计稿里专门写了「同意页必须调它」。
    */
    const allowed = await canAuthorize(app, req.user.id)
    res.json({
      app: { id: app.id, name: app.name, logo: app.logo || null, homepage: app.homepage || null, status: app.status },
      scopes: describeScopes(row.scopes),
      allowed,
      /** 不允许时给出原因，否则用户只看到一个灰按钮，不知道自己该做什么 */
      reason: allowed ? '' : '这个应用还在沙箱阶段，只能授权给它的开发者本人和登记过的测试账号',
    })
  } catch (e) {
    next(e)
  }
})

openDeviceRouter.post('/:code', async (req, res, next) => {
  try {
    if (!lookupGate(req, res)) return
    const approve = req.body?.approve === true
    const row = findByUserCode(req.params.code)
    if (!row) return res.status(404).json({ error: '这串码无效或已过期' })

    if (!approve) {
      denyDeviceAuth(req.params.code)
      return res.json({ ok: true, approved: false })
    }

    const app = await getApp(row.appId)
    if (!app) return res.status(404).json({ error: '这串码无效或已过期' })
    // 同上：同意页必须过这一关，而且要在真正写 userId **之前**
    if (!(await canAuthorize(app, req.user.id))) {
      return res.status(403).json({ error: '这个应用还在沙箱阶段，不能授权给这个账号' })
    }

    /*
      approveDeviceAuth 自己会再判一次「还是不是 pending」。
      为什么不信这里刚查到的那一行：两个人先后输了同一串码时，
      第二个人必须批不动 —— 设备只该拿到第一个人的授权。
    */
    const ok = approveDeviceAuth(normalizeUserCode(req.params.code), req.user.id)
    if (!ok) return res.status(409).json({ error: '这串码已经被处理过了' })
    res.json({ ok: true, approved: true })
  } catch (e) {
    next(e)
  }
})
