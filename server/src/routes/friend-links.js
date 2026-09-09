/**
 * 首页「特别鸣谢」友情链接后台接口。
 *
 * 公开页面不额外请求这里：它跟着首页 SSR 数据一次取完。这个路由只负责后台的
 * 新增、修改、停用与删除，写完后主动清首页缓存，管理员刷新首页就能看到结果。
 */
import { Router } from 'express'
import { requireAbility } from '../auth.js'
import { invalidateContent } from '../content.js'
import {
  createFriendLink,
  deleteFriendLink,
  listAdminFriendLinks,
  updateFriendLink,
} from '../friend-links.js'

export const friendLinksRouter = Router()

const LIMITS = { name: 80, url: 500, image: 500, sortOrder: 65535 }

function idOf(raw) {
  const id = Number(raw)
  return Number.isSafeInteger(id) && id > 0 ? id : 0
}

function cleanText(raw, max) {
  const value = String(raw ?? '').trim()
  return value.length <= max ? value : null
}

export function validateFriendLinkPayload(body) {
  const name = cleanText(body?.name, LIMITS.name)
  const url = cleanText(body?.url, LIMITS.url)
  const image = cleanText(body?.image, LIMITS.image)
  const sortOrder = Number(body?.sortOrder ?? 0)
  if (!name) return { error: '名称不能为空，且不能超过 80 个字符' }
  // 链接会直接进 <a href>，只放行 http(s)，避免 javascript: 一类伪协议。
  if (!url || !/^https?:\/\//i.test(url)) return { error: '链接必须以 http:// 或 https:// 开头' }
  if (image === null) return { error: '图片地址不能超过 500 个字符' }
  if (image && /^(?!https?:\/\/)[a-z][a-z0-9+.-]*:/i.test(image)) {
    return { error: '图片只支持对象存储 key、站内路径或 http(s) 地址' }
  }
  if (!Number.isInteger(sortOrder) || sortOrder < 0 || sortOrder > LIMITS.sortOrder) {
    return { error: '排序号必须是 0–65535 的整数' }
  }
  if (body?.enabled !== undefined && typeof body.enabled !== 'boolean') return { error: '启用状态必须是布尔值' }
  return { value: { name, url, image, sortOrder, enabled: body?.enabled ?? true } }
}

friendLinksRouter.get('/', requireAbility('content:edit'), async (_req, res, next) => {
  try {
    res.json(await listAdminFriendLinks())
  } catch (e) {
    next(e)
  }
})

friendLinksRouter.post('/', requireAbility('content:edit'), async (req, res, next) => {
  try {
    const parsed = validateFriendLinkPayload(req.body)
    if (parsed.error) return res.status(400).json({ error: parsed.error })
    const link = await createFriendLink(parsed.value)
    invalidateContent()
    res.status(201).json(link)
  } catch (e) {
    next(e)
  }
})

friendLinksRouter.put('/:id', requireAbility('content:edit'), async (req, res, next) => {
  try {
    const id = idOf(req.params.id)
    if (!id) return res.status(404).json({ error: '友情链接不存在' })
    const parsed = validateFriendLinkPayload(req.body)
    if (parsed.error) return res.status(400).json({ error: parsed.error })
    const link = await updateFriendLink(id, parsed.value)
    if (!link) return res.status(404).json({ error: '友情链接不存在' })
    invalidateContent()
    res.json(link)
  } catch (e) {
    next(e)
  }
})

friendLinksRouter.delete('/:id', requireAbility('content:edit'), async (req, res, next) => {
  try {
    const id = idOf(req.params.id)
    if (!id) return res.status(404).json({ error: '友情链接不存在' })
    const removed = await deleteFriendLink(id)
    if (!removed) return res.status(404).json({ error: '友情链接不存在' })
    invalidateContent()
    res.json({ ok: true })
  } catch (e) {
    next(e)
  }
})
