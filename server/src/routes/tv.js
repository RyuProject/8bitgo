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
import { listGames } from '../games-repo.js'

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
    const { items } = await listGames({ platform, sort: 'popular', pageSize: 60 })
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
