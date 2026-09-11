/**
 * 首页「特别鸣谢」友情链接后台接口。
 *
 * 公开页面不额外请求这里：它跟着首页 SSR 数据一次取完。这个路由只负责后台的
 * 新增、修改、停用与删除，写完后主动清首页缓存，管理员刷新首页就能看到结果。
 */
import { Router } from 'express'
import { optionalUser, requireAbility } from '../auth.js'
import { invalidateContent } from '../content.js'
import { OUT, friendLinkStats, recordFriendLinkHit } from '../friend-link-hits.js'
import { clientKey, take } from '../rateLimit.js'
import { isCrawlerUa } from '../sseGuard.js'
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

/**
 * 出站点击上报。**公开、无需登录** —— 点友链的绝大多数是游客。
 *
 * 前端用 `navigator.sendBeacon` 打这一条（见 components/home/sections.tsx）：
 * 它不挡跳转、页面卸载了也会发出去，而 fetch 在跳转那一瞬间会被浏览器掐掉。
 * 所以这里**回 204 不回 JSON**：sendBeacon 根本不读响应体，回什么都是白写。
 *
 * 三道闸，缺一条这个数字就没法看：
 *   · 爬虫按 UA 挡掉（复用 sseGuard 那张表）—— 爬虫会把页面上每条链接都「点」一遍
 *   · 每 IP 限流 —— 不然一行 curl 循环就能把某条友链刷成站里最受欢迎的
 *   · 写库那层按「每人每天每条链接一次」去重（见 friend-link-hits.js）
 *
 * ⚠️ 一律回 204，**包括被挡掉的时候**。告诉刷的人「你被限流了」没有任何好处，
 * 而正常用户根本看不到这个响应。
 */
const CLICK_LIMIT = 30
const CLICK_WINDOW_MS = 60_000

friendLinksRouter.post('/:id/click', optionalUser, async (req, res) => {
  res.status(204)
  try {
    const id = idOf(req.params.id)
    if (!id) return res.end()
    if (isCrawlerUa(req.headers?.['user-agent'])) return res.end()
    if (!take(`flclick:${clientKey(req)}`, CLICK_LIMIT, CLICK_WINDOW_MS).ok) return res.end()
    await recordFriendLinkHit(id, OUT, req)
  } catch {
    /* 统计失败不该有任何可见后果 */
  }
  return res.end()
})

/** 后台列表上那两列看的是最近多少天 */
const STATS_DAYS = 30

friendLinksRouter.get('/', requireAbility('content:edit'), async (_req, res, next) => {
  try {
    const [links, stats] = await Promise.all([listAdminFriendLinks(), friendLinkStats(STATS_DAYS)])
    /*
      两个方向的人数一起给。**必须带 statsDays**：光给两个数字，界面上就只能写成
      「带出 12」，而 12 是这一天的、这一个月的、还是开站以来的，看的人无从判断 ——
      那种数字比没有更糟。
    */
    res.json({ links: links.map((l) => ({ ...l, hits: stats[l.id] ?? { out: 0, in: 0 } })), statsDays: STATS_DAYS })
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
