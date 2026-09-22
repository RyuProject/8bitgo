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

/** 后端一次最多收这么多 slug（server/src/routes/games.js 的 by-slugs）。 */
const BATCH_MAX = 60

/*
  同一份 slug 名单要**每次返回同一个数组引用**。

  readCached() 是 `slugs.map(...).filter(...)`，天然每次都是新数组。下游那些
  useMemo / useEffect 把结果写进依赖数组的话就全废了 —— 首页横幅就是这样：
  `base` 每帧重算、`pool` 每帧重算，而预取下一张封面的 effect 依赖 pool，
  于是**每次渲染都新建一个 Image 并设一次 src**。

  所以这里给每份 key 记下上次交出去的那个数组，只有缓存真的变过（version 变了）
  才重算。version 由 notify() 推进，和通知订阅者是同一条路径，不会出现
  「缓存变了但引用没换」。
*/
let version = 0
const snapshots = new Map<string, { v: number; list: Game[] }>()

function notify() {
  version++
  for (const l of listeners) l()
}

/** 按 key 取（或重算）一份稳定的数组引用 */
function stableList(key: string, slugs: string[]): Game[] {
  const hit = snapshots.get(key)
  if (hit && hit.v === version) return hit.list
  const list = readCached(slugs)
  // 名单本身没有上限（房间卡片是一批一批来的），给个粗糙的水闸就够
  if (snapshots.size > 500) snapshots.clear()
  snapshots.set(key, { v: version, list })
  return list
}

/** 已经缓存的部分，按传入顺序返回；没缓存的跳过 */
function readCached(slugs: string[]): Game[] {
  return slugs.map((s) => cache.get(s)).filter((g): g is Game => Boolean(g))
}

async function fetchMissing(slugs: string[]) {
  const missing = slugs.filter((s) => !cache.has(s) && !inflight.has(s))
  if (!missing.length) return
  // 后端按 BATCH_MAX 截断，超了会静默丢掉后面的 —— 这里自己分片，别让它丢。
  const chunks: string[][] = []
  for (let i = 0; i < missing.length; i += BATCH_MAX) chunks.push(missing.slice(i, i + BATCH_MAX))

  await Promise.all(
    chunks.map((batch) => {
      const p = api
        .get<Game[]>(`/api/games/by-slugs?slugs=${encodeURIComponent(batch.join(','))}`)
        .then((games) => {
          for (const g of games) cache.set(g.slug, g)
          // 后端没返回的（不存在或已下架）也要记一笔，否则会无限重试。
          // 用 undefined 占位不行（cache.has 要为 true），所以记进 missing 集合。
          for (const s of batch) if (!cache.has(s)) notFound.add(s)
          notify()
        })
        .catch(() => {
          // 失败就让它失败，下次进页面还有机会
        })
        .finally(() => {
          for (const s of batch) inflight.delete(s)
        })
      for (const s of batch) inflight.set(s, p)
      return p
    }),
  )
}

/** 后端明确没有的 slug（不存在或已下架），记下来免得反复请求 */
const notFound = new Set<string>()

/*
  合并窗口 —— 一个组件一个请求会让房间列表变成 N+1。

  /rooms 页一屏几十张 RoomCard，每张自己调 useGameBySlug。它们全是同一次 commit
  里挂载的，effect 顺序执行：第一张卡发请求时后面的卡还没跑到自己的 effect，
  inflight 里自然没有它们的 slug，于是 N 张卡 = N 个「只带一个 slug」的请求。

  微任务是对的粒度：React 把这一次 commit 的所有 passive effect 排在**同一个
  宏任务**里连续跑完，微任务队列要到那个回调结束才排空 —— 所以窗口一定能把
  这一整批卡片兜住，又不会像 setTimeout 那样白等一个事件循环。

  ⚠️ 别改成 setTimeout：那会给每个首屏数据多加至少 1ms（移动端常常是 4ms 以上）
  的延迟，而这里要省的是请求数，不是让请求变慢。
*/
let pending = new Set<string>()
let flushScheduled = false

function scheduleFlush() {
  if (flushScheduled) return
  flushScheduled = true
  queueMicrotask(() => {
    flushScheduled = false
    if (!pending.size) return
    const slugs = [...pending]
    pending = new Set()
    void fetchMissing(slugs)
  })
}

/** 登记「这几个 slug 我想要」。真正发请求由合并窗口统一安排。 */
function requestSlugs(slugs: string[]) {
  if (!apiEnabled()) return
  for (const s of slugs) {
    if (!s || cache.has(s) || notFound.has(s) || inflight.has(s)) continue
    pending.add(s)
  }
  if (pending.size) scheduleFlush()
}

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
    if (!slugs.length) return
    requestSlugs(slugs)
    // key 变了才重新取；slugs 是新数组但内容相同时不该触发
  }, [key]) // eslint-disable-line react-hooks/exhaustive-deps

  return stableList(key, slugs)
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
