/**
 * 数据访问层。
 * 目前从本地模拟数据读取；接入真实后端时只需把这里的函数改成 fetch，
 * 页面与组件无需改动。
 */
import { loadGames } from './store'
import { isPlatformEnabled } from '@/config/platforms'
import { platforms, platformMap } from '@/data/platforms'
import { isPlayable } from '@/runtimes/registry'
import { genres, genreMap } from '@/data/genres'
import { liveStreams } from '@/data/streams'
import type {
  Game,
  GameQuery,
  Genre,
  GenreId,
  LiveStream,
  Platform,
  PlatformId,
  SortKey,
} from '@/types'

export const DEFAULT_PAGE_SIZE = 24

/** 前台可见的游戏（排除后台下架的、以及未开放平台的） */
function games(): Game[] {
  return loadGames().filter((g) => !g.hidden && isPlatformEnabled(g.platform))
}

function findGame(slug: string): Game | undefined {
  return games().find((g) => g.slug === slug)
}

export interface PagedResult<T> {
  items: T[]
  total: number
  page: number
  pageSize: number
  totalPages: number
}

const sorters: Record<SortKey, (a: Game, b: Game) => number> = {
  popular: (a, b) => b.plays - a.plays,
  newest: (a, b) => (a.addedAt < b.addedAt ? 1 : a.addedAt > b.addedAt ? -1 : 0),
  rating: (a, b) => b.rating - a.rating || b.ratingCount - a.ratingCount,
  name: (a, b) => a.title.localeCompare(b.title, 'en'),
}

function normalize(text: string) {
  return text.toLowerCase().replace(/[\s\-_:'’.!]/g, '')
}

export function queryGames(query: GameQuery = {}): PagedResult<Game> {
  const {
    q,
    platform,
    genre,
    developer,
    multiplayer,
    coin,
    sort = 'popular',
    page = 1,
    pageSize = DEFAULT_PAGE_SIZE,
  } = query

  let list = games().slice()

  if (platform) list = list.filter((g) => g.platform === platform)
  if (genre) list = list.filter((g) => g.genres.includes(genre))
  if (developer) list = list.filter((g) => g.developer === developer)
  if (multiplayer) list = list.filter((g) => g.multiplayer)
  if (coin) list = list.filter((g) => g.coinReward > 0)
  if (q && q.trim()) {
    const needle = normalize(q)
    list = list.filter((g) => {
      const p = platformMap[g.platform]
      const hay = [g.title, g.titleZh ?? '', g.developer, p.name, p.nameZh, ...(g.tags ?? [])]
        .map(normalize)
        .join(' ')
      return hay.includes(needle)
    })
  }

  list.sort(sorters[sort])

  const total = list.length
  const totalPages = Math.max(1, Math.ceil(total / pageSize))
  const safePage = Math.min(Math.max(1, page), totalPages)
  const start = (safePage - 1) * pageSize

  return {
    items: list.slice(start, start + pageSize),
    total,
    page: safePage,
    pageSize,
    totalPages,
  }
}

export function getGame(slug: string): Game | undefined {
  return findGame(slug)
}

export function getGamesBySlugs(slugs: string[]): Game[] {
  return slugs.map((s) => findGame(s)).filter((g): g is Game => Boolean(g))
}

export function getPopularGames(limit = 12): Game[] {
  return queryGames({ sort: 'popular', pageSize: limit }).items
}

export function getNewestGames(limit = 12): Game[] {
  return queryGames({ sort: 'newest', pageSize: limit }).items
}

export function getTopRatedGames(limit = 12): Game[] {
  return queryGames({ sort: 'rating', pageSize: limit }).items
}

export function getMultiplayerGames(limit = 12): Game[] {
  return queryGames({ multiplayer: true, sort: 'popular', pageSize: limit }).items
}

export function getCoinGames(limit = 12): Game[] {
  return games()
    .filter((g) => g.coinReward > 0)
    .sort((a, b) => b.coinReward - a.coinReward || b.plays - a.plays)
    .slice(0, limit)
}

export function getGamesByGenre(genre: GenreId, limit = 4): Game[] {
  return queryGames({ genre, sort: 'popular', pageSize: limit }).items
}

export function getRelatedGames(game: Game, limit = 8): Game[] {
  const score = (other: Game) => {
    let s = 0
    if (other.platform === game.platform) s += 2
    s += other.genres.filter((g) => game.genres.includes(g)).length * 3
    if (other.developer === game.developer) s += 2
    return s
  }
  return games()
    .filter((g) => g.slug !== game.slug)
    .map((g) => ({ g, s: score(g) }))
    .filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s || b.g.plays - a.g.plays)
    .slice(0, limit)
    .map((x) => x.g)
}

export interface PlatformWithCount extends Platform {
  count: number
}

export function getPlatforms(): PlatformWithCount[] {
  return platforms
    .filter((p) => isPlatformEnabled(p.id))
    .map((p) => ({ ...p, count: games().filter((g) => g.platform === p.id).length }))
    .sort((a, b) => b.count - a.count)
}

export function getPlatform(id: string): Platform | undefined {
  return platformMap[id]
}

export interface GenreWithCount extends Genre {
  count: number
}

export function getGenres(): GenreWithCount[] {
  return genres.map((g) => ({
    ...g,
    count: games().filter((x) => x.genres.includes(g.id)).length,
  }))
}

export function getGenre(id: string): Genre | undefined {
  return genreMap[id]
}

export interface DeveloperInfo {
  name: string
  count: number
  platforms: PlatformId[]
  topGame: Game
}

export function getDevelopers(): DeveloperInfo[] {
  const byName = new Map<string, Game[]>()
  for (const g of games()) {
    const list = byName.get(g.developer) ?? []
    list.push(g)
    byName.set(g.developer, list)
  }
  return [...byName.entries()]
    .map(([name, list]) => ({
      name,
      count: list.length,
      platforms: [...new Set(list.map((g) => g.platform))],
      topGame: list.slice().sort((a, b) => b.plays - a.plays)[0],
    }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name))
}

export interface LiveStreamWithGame extends LiveStream {
  game: Game
}

export function getLiveStreams(): LiveStreamWithGame[] {
  return liveStreams
    .map((s) => ({ ...s, game: findGame(s.gameSlug) as Game }))
    .filter((s) => Boolean(s.game))
    .sort((a, b) => b.viewers - a.viewers)
}

/**
 * 随机挑一款可在线运行的游戏（平台已有模拟器核心）。
 * 传入 excludeSlug 可避免连续两次抽到同一款。
 */
export function getRandomGame(excludeSlug?: string): Game {
  const pool = games().filter((g) => isPlayable(g.platform) && g.slug !== excludeSlug)
  const list = pool.length ? pool : games()
  return list[Math.floor(Math.random() * list.length)]
}

export function getStats() {
  return {
    games: games().length,
    platforms: platforms.length,
    plays: games().reduce((sum, g) => sum + g.plays, 0),
    multiplayer: games().filter((g) => g.multiplayer).length,
    liveStreams: liveStreams.length,
    liveViewers: liveStreams.reduce((sum, s) => sum + s.viewers, 0),
    /** 近两周新增游戏数（相对数据中最新的上线日期计算） */
    addedRecently: (() => {
      const newest = games().reduce((m, g) => (g.addedAt > m ? g.addedAt : m), '')
      const cutoff = new Date(newest)
      cutoff.setDate(cutoff.getDate() - 14)
      const cutoffStr = cutoff.toISOString().slice(0, 10)
      return games().filter((g) => g.addedAt >= cutoffStr).length
    })(),
  }
}
