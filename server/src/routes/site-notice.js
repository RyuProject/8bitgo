/**
 * 站点公告条：首页搜索框与横幅之间那一条，文案与语气由后台控制。
 *
 *   GET  /api/site-notice        公开。`{ notice: { level, text } | null }`
 *   GET  /api/admin/site-notice  管理员。编辑器读的那一份（含 enabled 与关掉时的原文）
 *   PUT  /api/admin/site-notice  管理员。写 `{ level, text, enabled }`
 *
 * ## 为什么公开读和后台读写分成两个前缀
 *
 * 公开那份要进边缘缓存（见 CACHE.notice）。而**按身份变内容的接口绝不能进缓存** ——
 * 管理员读到的原文被缓存下来、下一个匿名访客带着同一个 URL 拿到它，这种事发生了
 * 也只能事后才知道。所以这里没有「加个参数就返回完整版」的设计，两条路彻底分家。
 *
 * ## 为什么公开缓存只有 30 秒
 *
 * 这条的用途就是「站点出事了，立刻告诉所有人」。沿用其它内容那 5 分钟的 s-maxage，
 * 等于让公告**在它最该出现的时刻迟到五分钟** —— 那正是唯一需要它的时刻。
 *
 * 读写用例在 ../site-notice.js（首页数据也要用同一份判断）。
 */
import { Router } from 'express'
import { requireAbility } from '../auth.js'
import { CACHE } from '../cache.js'
import { invalidateContent } from '../content.js'
import { readStoredNotice, readStoredNoticeSoft, saveNotice } from '../site-notice.js'
import { sanitizeNotice, visibleNotice } from '../../../shared/site-notice.js'

export const siteNoticeRouter = Router()
export const adminSiteNoticeRouter = Router()

siteNoticeRouter.get('/', async (_req, res, next) => {
  try {
    res.set('Cache-Control', CACHE.notice)
    res.json({ notice: visibleNotice(await readStoredNoticeSoft()) })
  } catch (e) {
    next(e)
  }
})

adminSiteNoticeRouter.get('/', requireAbility('site:manage'), async (_req, res, next) => {
  try {
    // 编辑器要看到原文（哪怕现在是关掉的），否则「关一下再开」就得把文案重打一遍。
    // 走 sanitizeNotice 是为了把旧版本 / 手工改库留下的歪形状归一，编辑器只认一种。
    res.set('Cache-Control', CACHE.none)
    res.json({ notice: sanitizeNotice(await readStoredNotice()) })
  } catch (e) {
    next(e)
  }
})

adminSiteNoticeRouter.put('/', requireAbility('site:manage'), async (req, res, next) => {
  try {
    const notice = await saveNotice(req.body)
    // 首页是 SSR 的：作废服务端那份内容缓存，否则改完的第一个访客看到的还是旧公告
    invalidateContent()
    res.json({ notice })
  } catch (e) {
    next(e)
  }
})
