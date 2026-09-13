/**
 * 应用中心后台管理。`/api/admin/apps/*`，权限点 **`content:edit`**。
 *
 * 三个模块（官方 SDK / APP 下载 / 社区上架）共用一张表，靠 `kind` 分开；
 * 后台不区分，统一增删改，由列表里的 kind 标签告诉管理员这是哪一类。
 *
 * 下载方式有两种，后台自己选：
 *   · 填 `downloadUrl` 一个外链（GitHub Release / 自有域名都行）；
 *   · 或把安装包传到 R2（前端上传后把 key 当 downloadUrl 传回来，
 *     前端会用资源域名拼成可下载地址）。两种都落进 `download_url` 这一列。
 */
import { Router } from 'express'
import { requireAbility } from '../auth.js'
import { CACHE } from '../cache.js'
import { APP_KINDS, createApp, deleteApp, getApp, listAllApps, updateApp } from '../apps-repo.js'

export const adminAppsRouter = Router()
adminAppsRouter.use(requireAbility('content:edit'))
adminAppsRouter.use((_req, res, next) => {
  res.set('Cache-Control', CACHE.none)
  next()
})

const bad = (res, code, message, status = 400) => res.status(status).json({ error: message, code })

/**
 * 把请求体规范成数据层要的字段。接受驼峰（前端）或下划线（裸调）两种写法。
 * 校验集中在这儿：名称长度、kind 取值、链接必须是 http(s)。
 * 返回 { error } 或 { value }。
 */
function parseInput(body) {
  const b = body || {}
  const kind = APP_KINDS.includes(b.kind) ? b.kind : null
  if (!kind) return { error: 'kind 必须是 sdk / app / community' }

  const name = String(b.name ?? '').trim()
  if (name.length < 1 || name.length > 120) return { error: '名称长度需在 1–120 之间' }

  const downloadUrl = String(b.downloadUrl ?? b.download_url ?? '').trim()
  if (downloadUrl && !/^https?:\/\/\S+$/i.test(downloadUrl)) return { error: '下载链接必须是 http(s) 地址' }

  const published = b.published === false || b.published === 0 ? 0 : 1

  return {
    value: {
      kind,
      name,
      platform: String(b.platform ?? '').trim().slice(0, 40),
      version: String(b.version ?? '').trim().slice(0, 40) || null,
      description: String(b.description ?? '').slice(0, 4000) || null,
      downloadUrl: downloadUrl || null,
      icon: String(b.icon ?? '').trim().slice(0, 200) || null,
      sortOrder: Number.isFinite(Number(b.sortOrder)) ? Number(b.sortOrder) : 0,
      published,
      submitterName: String(b.submitterName ?? '').trim().slice(0, 80) || null,
      submitterContact: String(b.submitterContact ?? '').trim().slice(0, 200) || null,
    },
  }
}

adminAppsRouter.get('/', async (_req, res, next) => {
  try {
    res.json({ items: await listAllApps() })
  } catch (e) {
    next(e)
  }
})

adminAppsRouter.post('/', async (req, res, next) => {
  try {
    const p = parseInput(req.body)
    if (p.error) return bad(res, 'bad_input', p.error)
    const app = await createApp(p.value)
    res.status(201).json({ app })
  } catch (e) {
    next(e)
  }
})

adminAppsRouter.patch('/:id', async (req, res, next) => {
  try {
    const app = await getApp(Number(req.params.id))
    if (!app) return bad(res, 'not_found', '应用不存在', 404)
    // 以库里现有值为底，再用请求体覆盖 —— 没传的字段保持原样
    const base = {
      kind: app.kind,
      name: app.name,
      platform: app.platform,
      version: app.version,
      description: app.description,
      downloadUrl: app.download_url,
      icon: app.icon,
      sortOrder: app.sort_order,
      published: app.published,
      submitterName: app.submitter_name,
      submitterContact: app.submitter_contact,
    }
    const p = parseInput({ ...base, ...req.body })
    if (p.error) return bad(res, 'bad_input', p.error)
    p.value.kind = app.kind // kind 不允许改
    const updated = await updateApp(app.id, p.value)
    res.json({ app: updated })
  } catch (e) {
    next(e)
  }
})

adminAppsRouter.delete('/:id', async (req, res, next) => {
  try {
    const app = await getApp(Number(req.params.id))
    if (!app) return bad(res, 'not_found', '应用不存在', 404)
    await deleteApp(app.id)
    res.json({ ok: true })
  } catch (e) {
    next(e)
  }
})
