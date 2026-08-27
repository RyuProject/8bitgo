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
/**
 * 缓存代数。invalidateContent() 会 +1；正在飞的那次查询回来时如果代数已经变了，
 * 说明它读到的是写库**之前**的数据，直接丢弃，不能拿它覆盖缓存 ——
 * 否则后台明明改完了，前台还会再拿旧数据顶满一个 TTL。
 */
let generation = 0

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
  const startedAt = generation
  inflight = fetchAll()
    .then((fresh) => {
      if (startedAt !== generation) {
        // 查询期间有人写库并调了 invalidateContent()，这份结果已经过时，别写进缓存
        return fresh
      }
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
  generation += 1
  cache = { ...cache, at: 0 }
}
