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
import { CACHE, publicApi } from '../cache.js'
import { listPlatformBios, setPlatformBios, clearPlatformBios } from '../games-repo.js'
import { invalidateContent } from '../content.js'

export const platformBiosRouter = Router()

/** 平台 id 的形状约束。平台表在前端（src/data/platforms.ts），后端不跟着抄一份 */
const VALID_PLATFORM = /^[A-Za-z0-9_-]{1,20}$/
/**
 * 街机 BIOS **系统包**的绑定，键写成 `bios:<系统名>`（`bios:neogeo`、`bios:pgm`）。
 *
 * ## 为什么复用同一张 platform_bios 表、同一个接口
 *
 * 因为要存的东西一模一样（一个字符串 key），差别只在「这份 BIOS 属于谁」：
 *   · `arcade`     —— 这个平台默认用哪份（历史遗留，arcade 只可能填一份）
 *   · `bios:pgm`   —— **PGM 板子**要的那份
 *
 * 街机一个平台底下其实是好几套硬件，而引擎只吃一个 BIOS 地址（`EJS_biosUrl`），
 * 所以「按游戏要哪个系统包」这件事必须能分开绑。换成一张新表 / 一套新接口，
 * 只是把同一件事抄第二遍；命名空间键让现有后台面板、探活、上传流程全部照旧复用。
 *
 * ⚠️ 系统名必须是核心要找的那个 set 名（`neogeo` / `pgm` / `skns`），
 * 因为核心是按固定文件名找 BIOS 的（见 admin/PlatformBiosPanel.tsx 的说明），
 * 而绑定地址的最后一段会被当成文件名。
 */
const VALID_BIOS_SET = /^bios:[a-z0-9_]{1,32}$/

const validKey = (v) => VALID_PLATFORM.test(v) || VALID_BIOS_SET.test(v)

platformBiosRouter.get('/', async (_req, res, next) => {
  try {
    const map = await listPlatformBios()
    // 短缓存：后台改完绑定清不了边缘，见 CACHE.bios 的注释
    publicApi(res, CACHE.bios)
    res.json(map)
  } catch (e) {
    next(e)
  }
})

platformBiosRouter.put('/:platform', requireAdmin, async (req, res, next) => {
  try {
    const platform = String(req.params.platform || '')
    if (!validKey(platform)) {
      return res.status(400).json({ error: '平台 id 或 BIOS 系统名不合法（BIOS 写成 bios:neogeo 这样）' })
    }
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
    if (!validKey(platform)) {
      return res.status(400).json({ error: '平台 id 或 BIOS 系统名不合法（BIOS 写成 bios:neogeo 这样）' })
    }
    await clearPlatformBios(platform)
    invalidateContent()
    res.json({ ok: true })
  } catch (e) {
    next(e)
  }
})
