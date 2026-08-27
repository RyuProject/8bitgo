/**
 * 「我有几个 slug，要对应的游戏对象」——首页轮播、侧边栏「稍后玩」、
 * 联机房间卡片都是这种需求。
 *
 * v1 里这些地方直接从全量 store 里 find，因为整个游戏库本来就在内存里。
 * v2 不再全量加载，所以改成按需向后端批量取，并在内存里缓存一份，
 * 避免同一款游戏被不同组件反复请求。
 *
 * 缓存只在当前页面会话内有效，刷新即清空 —— 不写 localStorage：
 * 那会在下次打开时抢在请求前面显示过期数据，正是 v1 的老毛病。
 */
import { useEffect, useState } from 'react'
import type { Game } from '@/types'
import { api, apiEnabled } from './api'

const cache = new Map<string, Game>()
/** 正在飞的请求，按 slug 记，避免同一批 slug 被并发请求多次 */
const inflight = new Map<string, Promise<void>>()
const listeners = new Set<() => void>()

function notify() {
  for (const l of listeners) l()
}

/** 已经缓存的部分，按传入顺序返回；没缓存的跳过 */
function readCached(slugs: string[]): Game[] {
  return slugs.map((s) => cache.get(s)).filter((g): g is Game => Boolean(g))
}

async function fetchMissing(slugs: string[]) {
  const missing = slugs.filter((s) => !cache.has(s) && !inflight.has(s))
  if (!missing.length) return
  const p = api
    .get<Game[]>(`/api/games/by-slugs?slugs=${encodeURIComponent(missing.join(','))}`)
    .then((games) => {
      for (const g of games) cache.set(g.slug, g)
      // 后端没返回的（不存在或已下架）也要记一笔，否则会无限重试。
      // 用 undefined 占位不行（cache.has 要为 true），所以记进 missing 集合。
      for (const s of missing) if (!cache.has(s)) notFound.add(s)
      notify()
    })
    .catch(() => {
      // 失败就让它失败，下次进页面还有机会
    })
    .finally(() => {
      for (const s of missing) inflight.delete(s)
    })
  for (const s of missing) inflight.set(s, p)
  return p
}

/** 后端明确没有的 slug（不存在或已下架），记下来免得反复请求 */
const notFound = new Set<string>()

/**
 * 按 slug 取一组游戏。返回的是**已经拿到的那部分**，按传入顺序排列；
 * 还没拿到的会自动去取，取到后组件重渲染。
 */
export function useGamesBySlugs(slugs: string[]): Game[] {
  const key = slugs.join(',')
  const [, force] = useState(0)

  useEffect(() => {
    const rerender = () => force((n) => n + 1)
    listeners.add(rerender)
    return () => {
      listeners.delete(rerender)
    }
  }, [])

  useEffect(() => {
    if (!apiEnabled() || !slugs.length) return
    const need = slugs.filter((s) => !cache.has(s) && !notFound.has(s))
    if (need.length) void fetchMissing(need)
    // key 变了才重新取；slugs 是新数组但内容相同时不该触发
  }, [key]) // eslint-disable-line react-hooks/exhaustive-deps

  return readCached(slugs)
}

/** 取单款游戏（房间卡片用） */
export function useGameBySlug(slug: string | undefined): Game | undefined {
  const games = useGamesBySlugs(slug ? [slug] : [])
  return games[0]
}

/** 服务端渲染时把已经取到的游戏灌进缓存，客户端首帧就不用再请求 */
export function seedGames(games: Game[] | undefined) {
  for (const g of games ?? []) cache.set(g.slug, g)
}
