/**
 * 「游戏库里一共有多少款」—— 侧边栏「全部游戏」右边那个数字。
 *
 * 列表接口本来就返回 total，所以这里只发一个 pageSize=1 的最小请求（后端是
 * COUNT(*) + 一行数据），拿到数字后缓存在模块作用域里：整个页面会话只问一次，
 * 切路由、开合抽屉都不会重复请求。
 *
 * 没配后端（VITE_API_URL 留空）时退回代码里自带的种子目录长度，跟站点其它
 * 「本地存储模式」的行为保持一致。
 */
import { useEffect, useState } from 'react'
import { games } from '@/data/games'
import { api, apiEnabled } from './api'

let cached: number | undefined
let inflight: Promise<void> | undefined
const listeners = new Set<() => void>()

/** 服务端渲染时若已经知道总数（首页数据里带 total），可以先灌进来省一次请求 */
export function seedGamesTotal(n: number | undefined) {
  if (typeof n === 'number' && Number.isFinite(n) && n >= 0) cached = n
}

function load() {
  if (inflight) return inflight
  inflight = api
    .get<{ total: number }>('/api/games?pageSize=1')
    .then((r) => {
      if (typeof r?.total !== 'number') return
      cached = r.total
      for (const l of listeners) l()
    })
    .catch(() => {
      // 取不到就不显示数字，下次进页面还有机会
    })
    .finally(() => {
      inflight = undefined
    })
  return inflight
}

/** 游戏总数；还没拿到时返回 undefined（调用方自行决定不渲染） */
export function useGamesTotal(): number | undefined {
  const [, force] = useState(0)

  useEffect(() => {
    const rerender = () => force((n) => n + 1)
    listeners.add(rerender)
    return () => {
      listeners.delete(rerender)
    }
  }, [])

  useEffect(() => {
    if (!apiEnabled()) return
    if (cached === undefined) void load()
  }, [])

  return apiEnabled() ? cached : games.length
}
