/**
 * SSR 用的内容缓存。
 *
 * 服务端渲染每个页面都要用到「全部游戏 / 全部文章」，每次请求都查库太浪费，
 * 所以在内存里缓存一份，按 SSR_CACHE_MS（默认 60 秒）过期。
 * 后台改完数据最多 60 秒后生效；想立刻生效可以调用 invalidateContent()。
 */
import { query } from './db.js'
import { gameRowToApi, postRowToApi } from './mappers.js'

const TTL = Number(process.env.SSR_CACHE_MS || 60_000)

let cache = { at: 0, games: [], posts: [] }
let inflight = null

async function fetchAll() {
  const [gameRows, postRows] = await Promise.all([
    query('SELECT * FROM games WHERE hidden = 0'),
    query('SELECT * FROM posts WHERE published = 1'),
  ])
  return {
    at: Date.now(),
    games: gameRows.map(gameRowToApi),
    posts: postRows.map(postRowToApi),
  }
}

/** 拿到渲染用的数据；库连不上时返回上一次的缓存（哪怕是空的），不让页面 500 */
export async function getContent() {
  if (Date.now() - cache.at < TTL && cache.at > 0) return cache
  if (inflight) return inflight
  inflight = fetchAll()
    .then((fresh) => {
      cache = fresh
      return fresh
    })
    .catch((e) => {
      console.warn('[ssr] 读取数据库失败，用上一次的缓存渲染：', e.message)
      return cache
    })
    .finally(() => {
      inflight = null
    })
  return inflight
}

export function invalidateContent() {
  cache = { ...cache, at: 0 }
}
