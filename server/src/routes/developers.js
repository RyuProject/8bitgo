/**
 * 开发商的人工资料（logo / 简介 / 官网）。
 *
 *   GET    /api/developers        管理员。全量名单：作品数 + 代表作 + 已填的资料
 *   PUT    /api/developers/:name  管理员。写入 / 覆盖一家的资料
 *   DELETE /api/developers/:name  管理员。删掉资料，该开发商回到「用代表作封面」
 *
 * 为什么没有公开的读接口：前台开发商列表本来就要作品数和代表作，
 * 这些只有 facets 那条聚合查得出来。资料在 developerCounts() 里一起 LEFT JOIN 了，
 * 前台跟着 /api/page?path=/developers 一次拿全，不用多打一次请求。
 *
 * name 就是主键，且必须和 games.developer 里写的一字不差 —— 名单是从那一列
 * GROUP BY 出来的，对不上就等于给一个不存在的开发商填资料。所以后台不提供改名，
 * 要改名字得去改游戏里的开发商字段，再把这里的旧行删掉。
 */
import { Router } from 'express'
import { requireAdmin } from '../auth.js'
import { invalidateContent } from '../content.js'
import { listDeveloperProfiles, upsertDeveloperProfile, deleteDeveloperProfile } from '../games-repo.js'

export const developersRouter = Router()

const LIMITS = { name: 120, logo: 500, homepage: 300, description: 2000 }

/** 越界就直接拒绝，不做截断：悄悄砍一半的简介比报错更难发现 */
function clean(value, max) {
  const text = String(value ?? '').trim()
  return text.length > max ? null : text
}

developersRouter.get('/', requireAdmin, async (_req, res, next) => {
  try {
    const rows = await listDeveloperProfiles()
    res.json(
      rows.map((r) => ({
        name: r.developer,
        count: Number(r.n),
        logo: r.logo || '',
        description: r.description || '',
        descriptionEn: r.description_en || '',
        homepage: r.homepage || '',
        topGame: r.slug
          ? { slug: r.slug, title: r.title, titleZh: r.title_zh || undefined, icon: r.icon, cover: r.cover || undefined, platform: r.platform }
          : undefined,
      })),
    )
  } catch (e) {
    next(e)
  }
})

developersRouter.put('/:name', requireAdmin, async (req, res, next) => {
  try {
    const name = clean(req.params.name, LIMITS.name)
    if (!name) return res.status(400).json({ error: '开发商名字不合法或过长' })

    const logo = clean(req.body?.logo, LIMITS.logo)
    const homepage = clean(req.body?.homepage, LIMITS.homepage)
    const description = clean(req.body?.description, LIMITS.description)
    const descriptionEn = clean(req.body?.descriptionEn, LIMITS.description)
    if (logo === null) return res.status(400).json({ error: 'logo 地址过长' })
    if (homepage === null) return res.status(400).json({ error: '官网地址过长' })
    if (description === null || descriptionEn === null) return res.status(400).json({ error: '简介过长' })
    // 官网会渲染成 <a href>，只放行 http(s)：javascript: 这类伪协议点一下就是 XSS
    if (homepage && !/^https?:\/\//i.test(homepage)) return res.status(400).json({ error: '官网必须以 http:// 或 https:// 开头' })

    await upsertDeveloperProfile(name, { logo, description, descriptionEn, homepage })
    // 开发商列表在 SSR 首屏数据里（/api/page?path=/developers），不清缓存的话
    // 后台存完前台要等一个 TTL 才变
    invalidateContent()
    res.json({ name, logo, description, descriptionEn, homepage })
  } catch (e) {
    next(e)
  }
})

developersRouter.delete('/:name', requireAdmin, async (req, res, next) => {
  try {
    const name = clean(req.params.name, LIMITS.name)
    if (!name) return res.status(400).json({ error: '开发商名字不合法或过长' })
    const removed = await deleteDeveloperProfile(name)
    if (removed) invalidateContent()
    res.json({ ok: true, removed })
  } catch (e) {
    next(e)
  }
})
