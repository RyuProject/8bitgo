/**
 * 平台级 BIOS：某些平台不给 BIOS 根本起不来。
 *
 *   GET    /api/platform-bios            公开。返回 { 平台id: 对象存储key }
 *   PUT    /api/platform-bios/:platform  管理员。{ objectKey } 绑定
 *   DELETE /api/platform-bios/:platform  管理员。解绑
 *
 * 为什么读接口是公开的：播放器要靠它拼出 BIOS 地址才能启动引擎，
 * 而这里返回的只是对象 key，和游戏 ROM 的 key 同一个性质 —— 真正的访问控制
 * 在对象存储那一侧（Worker），不在这条接口上。
 */
import { Router } from 'express'
import { requireAdmin } from '../auth.js'
import { publicApi } from '../cache.js'
import { listPlatformBios, setPlatformBios, clearPlatformBios } from '../games-repo.js'
import { invalidateContent } from '../content.js'

export const platformBiosRouter = Router()

/** 平台 id 的形状约束。平台表在前端（src/data/platforms.ts），后端不跟着抄一份 */
const VALID_PLATFORM = /^[A-Za-z0-9_-]{1,20}$/

platformBiosRouter.get('/', async (_req, res, next) => {
  try {
    const map = await listPlatformBios()
    publicApi(res)
    res.json(map)
  } catch (e) {
    next(e)
  }
})

platformBiosRouter.put('/:platform', requireAdmin, async (req, res, next) => {
  try {
    const platform = String(req.params.platform || '')
    if (!VALID_PLATFORM.test(platform)) return res.status(400).json({ error: '平台 id 不合法' })
    const key = String(req.body?.objectKey ?? '').trim()
    if (!key) return res.status(400).json({ error: '缺少 objectKey' })
    if (key.length > 500) return res.status(400).json({ error: 'objectKey 过长' })
    await setPlatformBios(platform, key)
    // 首屏数据里不含 BIOS，但清一下没有坏处，且将来若进了 SSR payload 不会漏
    invalidateContent()
    res.json({ platform, objectKey: key })
  } catch (e) {
    next(e)
  }
})

platformBiosRouter.delete('/:platform', requireAdmin, async (req, res, next) => {
  try {
    const platform = String(req.params.platform || '')
    if (!VALID_PLATFORM.test(platform)) return res.status(400).json({ error: '平台 id 不合法' })
    await clearPlatformBios(platform)
    invalidateContent()
    res.json({ ok: true })
  } catch (e) {
    next(e)
  }
})
