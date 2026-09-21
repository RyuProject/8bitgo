/**
 * 8BitGo TV —— 24/7 复古游戏直播频道。
 *
 * 这里不真正推送视频流（那需要独立的串流基础设施），而是把「频道当前在播哪款游戏、
 * 接下来轮到哪些」这件事由服务端按时间确定性地排好、下发给前端。前端据此渲染一台
 * 会自己换台的复古电视机：每隔一段固定时间（TV_SEGMENT_MS）自动切到下一款，像真频道一样。
 *
 * 收不到信号（本接口 503）时，前端退回「游戏库浏览」这种备用节目（参照 ggemu 的 /pro 页）。
 *
 * ⚠️ 人数只是演示用的随机值，不是真实在线数 —— 真要做在线人数得接直播信令那一套。
 */
import { Router } from 'express'
import { listGames, platformCounts } from '../games-repo.js'
import { cached } from '../content.js'
import { publicApi } from '../cache.js'

export const tvRouter = Router()

// 每款游戏在频道里播多久（毫秒）。前端必须和这个保持一致才切得齐
export const TV_SEGMENT_MS = 8 * 60 * 1000

/** 这个接口允许短缓存：频道节目单是按时间算的，几秒内所有人看到的一样 */
function cacheShort(res) {
  res.set('Cache-Control', 'public, max-age=5, s-maxage=5')
}

tvRouter.get('/', async (req, res) => {
  try {
    // 按平台切频道：?platform=nes 就只在这个平台的游戏里轮播
    const platform = typeof req.query.platform === 'string' ? req.query.platform : undefined
    // 轮播池对所有访客都一样 → 进内容缓存（后台改动会被 invalidateContent 清掉）。
    // viewers 是演示用的随机值，故意留在缓存之外算，否则同一份缓存会把在线人数钉死成一个不变的数。
    const key = `tv:pool:${platform || 'all'}`
    const items = await cached(key, async () => (await listGames({ platform, sort: 'popular', pageSize: 60 })).items)
    if (!items.length) {
      // 没有可播的游戏 = 没有信号
      return res.status(503).json({ error: 'no programs' })
    }
    const viewers = 120 + Math.floor(Math.random() * 480)
    cacheShort(res)
    res.json({
      live: true,
      channel: '8BitGo TV',
      tagline: '24/7 Retro Game Channel',
      segmentMs: TV_SEGMENT_MS,
      viewers,
      // 前端 Game 形状（已经过 gameRowToApi），直接喂给卡片和详情页链接
      pool: items,
    })
  } catch (e) {
    res.status(503).json({ error: 'signal lost' })
  }
})

/**
 * TV 首页的「大磁贴墙」：每个平台各取一页热门，一次请求全给。
 *
 * ⚠️ 以前这一屏是前端对每个平台各打一次 `/api/page?path=/games&platform=…`
 * （16 个平台 = 16 个请求），而那条路每次都会 `await loadFacets()` ——
 * 平台/类型/开发商三个聚合查询，其中开发商那份还要带「代表作」窗口函数。
 * 等于 16×(1 次列表 + 3 次聚合)，还要把整份 facets 重复传 16 遍，
 * 而且 Promise.all 必须等最慢的那个平台返回才渲染整屏。
 *
 * 这里只查列表、不查 facets（这一屏根本不用 facets），并且整份结果进内容缓存。
 * 平台清单走 platformCounts()：库里有游戏的平台才会出现，不用在前台/后台各维护一份启用列表。
 */
tvRouter.get('/wall', async (req, res) => {
  try {
    const per = Math.min(24, Math.max(1, Math.trunc(Number(req.query.per)) || 12))
    const rows = await cached(`tv:wall:${per}`, async () => {
      const counts = await platformCounts()
      const built = await Promise.all(
        counts.map(async (r) => {
          const { items } = await listGames({ platform: r.platform, sort: 'popular', pageSize: per })
          return items.length ? { id: r.platform, items } : null
        }),
      )
      return built.filter(Boolean)
    })
    publicApi(res)
    res.json({ rows })
  } catch (e) {
    res.status(503).json({ error: 'signal lost' })
  }
})
