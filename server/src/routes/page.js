import { Router } from 'express'
import { loadForRoute } from '../content.js'
import { publicApi } from '../cache.js'

export const pageRouter = Router()

/**
 * 「这个页面需要什么数据」的统一入口。
 *
 *   GET /api/page?path=/games&platform=nes&page=2
 *
 * SSR 在进程内直接调 loadForRoute()，浏览器端路由跳转时走这个接口 ——
 * 两边用的是**同一个函数**，不会出现「服务端渲染出来一套、客户端跳过去又是另一套」。
 *
 * path 必须是站内路径（已剥掉语言前缀），其余查询参数原样透传给 loadForRoute。
 */
pageRouter.get('/', async (req, res, next) => {
  try {
    const raw = String(req.query.path || '/')
    // 只接受站内绝对路径，挡掉 //evil.com 这类会被当成协议相对 URL 的写法
    if (!raw.startsWith('/') || raw.startsWith('//')) {
      return res.status(400).json({ error: 'path 必须是站内路径' })
    }
    const [pathname, qs] = raw.split('?')
    // 查询条件既可以跟在 path 里，也可以平铺在外层；外层优先
    const params = new URLSearchParams(qs ?? '')
    for (const [k, v] of Object.entries(req.query)) {
      if (k !== 'path' && typeof v === 'string') params.set(k, v)
    }
    const data = await loadForRoute(pathname, params)
    // 页面数据对所有访客一样（登录态不参与），可以让浏览器和边缘缓存一小会儿
    publicApi(res)
    res.json(data)
  } catch (e) {
    next(e)
  }
})
