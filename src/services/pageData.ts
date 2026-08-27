/**
 * 按路由取数。
 *
 * v1 是「把整个游戏库拉到浏览器，再用 JS 过滤分页」。上千款游戏时，
 * 光是首屏 HTML 就要塞进整个目录 —— 这一层就是为了终结那种做法。
 *
 * 数据从哪来：
 *   - 首屏：服务端渲染时已经把本页数据写进了 window.__8BITGO__.data，直接用，
 *     不发请求、也不闪一下 loading（而且这样客户端首帧才和服务端 HTML 完全一致，
 *     否则 hydration 会不匹配）。
 *   - 之后的站内跳转：调 /api/page?path=…，服务端仍然走 loadForRoute()，
 *     和 SSR 用的是同一个函数。
 */
import { useEffect, useRef, useState } from 'react'
import type { Game, Post } from '@/types'
import { api, apiEnabled } from './api'
import { startPageLoad } from './progress'

/* ---------------- 各路由的数据形状 ---------------- */

export interface Paged<T> {
  items: T[]
  total: number
  page: number
  pageSize: number
  totalPages: number
}

/** 开发商列表页用来做封面的「代表作」：该开发商游玩次数最高的那款 */
export interface DeveloperTopGame {
  slug: string
  title: string
  titleZh?: string
  icon: string
  cover?: string
  platform: string
}

export interface Facets {
  platforms: Array<{ id: string; count: number }>
  genres: Array<{ id: string; count: number }>
  developers: Array<{ name: string; count: number; topGame?: DeveloperTopGame }>
}

export interface HomeData {
  route: 'home'
  popular: Game[]
  newest: Game[]
  multiplayer: Game[]
  /** 分类网格下方各栏的样例，键是 genreId。一款游戏都没有的类型服务端不会建键，所以取值可能是 undefined */
  genreSamples: Record<string, Game[]>
  facets: Facets
  total: number
}
export interface GamesData { route: 'games'; list: Paged<Game>; facets: Facets }
export interface GameData { route: 'game'; game: Game | null; related?: Game[] }
export interface PlatformsData { route: 'platforms'; facets: Facets }
export interface PlatformData { route: 'platform'; id: string; list: Paged<Game> }
export interface GenresData { route: 'genres'; facets: Facets }
export interface GenreData { route: 'genre'; id: string; list: Paged<Game> }
export interface DevelopersData { route: 'developers'; facets: Facets }
export interface BlogData { route: 'blog'; posts: Post[] }
export interface OtherData { route: 'other'; facets: Facets }

export type PageData =
  | HomeData | GamesData | GameData | PlatformsData | PlatformData
  | GenresData | GenreData | DevelopersData | BlogData | OtherData

/* ---------------- 首屏数据 ---------------- */

interface Bootstrap {
  data?: PageData
  lang?: string
}

/**
 * 服务端注入的首屏数据。**只能用一次** —— 用掉之后就清空，
 * 否则站内跳到别的页面时会把上一页的数据当成本页的直接渲染出来。
 */
let bootstrapped: PageData | null = null
export function takeBootstrap(): PageData | null {
  const d = bootstrapped
  bootstrapped = null
  return d
}
export function setBootstrap(data: PageData | null) {
  bootstrapped = data
}

if (typeof window !== 'undefined') {
  const boot = (window as unknown as { __8BITGO__?: Bootstrap }).__8BITGO__
  if (boot?.data) bootstrapped = boot.data
}

/** 服务端渲染时由 entry-server 灌进来 */
let ssrData: PageData | null = null
export function setSsrData(data: PageData | null) {
  ssrData = data
}

/* ---------------- 取数 ---------------- */

/** 把当前路由拼成 /api/page 的查询串 */
function pageUrl(path: string, params?: Record<string, string | number | undefined>): string {
  const sp = new URLSearchParams({ path })
  for (const [k, v] of Object.entries(params ?? {})) {
    if (v !== undefined && v !== '' && v !== null) sp.set(k, String(v))
  }
  return `/api/page?${sp.toString()}`
}

export function fetchPageData(path: string, params?: Record<string, string | number | undefined>) {
  return api.get<PageData>(pageUrl(path, params))
}

export type PageState<T> =
  | { status: 'ready'; data: T }
  | { status: 'loading'; data: T | null }
  | { status: 'error'; data: T | null; error: string }

/**
 * 取当前路由的数据。
 *
 * @param path   站内路径（不带语言前缀），如 '/games'
 * @param params 额外查询条件，如 { platform: 'nes', page: 2 }
 * @param expect 期望的 route 标识；服务端注入的数据对不上时会重新拉，
 *               避免把上一页的数据错当本页用
 */
export function usePageData<T extends PageData>(
  path: string,
  params?: Record<string, string | number | undefined>,
  expect?: T['route'],
): PageState<T> {
  // 服务端渲染：直接用 entry-server 灌进来的那份，不发请求
  if (typeof window === 'undefined') {
    const d = ssrData as T | null
    return d && (!expect || d.route === expect)
      ? { status: 'ready', data: d }
      : { status: 'loading', data: null }
  }

  const key = pageUrl(path, params)
  // 首帧：如果服务端注入的数据正是本页的，直接同步用掉，不闪 loading
  const [state, setState] = useState<PageState<T>>(() => {
    const boot = takeBootstrap()
    if (boot && (!expect || boot.route === expect)) return { status: 'ready', data: boot as T }
    return { status: 'loading', data: null }
  })
  // 记住上一次真正取过的 key：路由或筛选条件变了才重新拉
  const loadedKey = useRef<string | null>(state.status === 'ready' ? key : null)

  useEffect(() => {
    if (loadedKey.current === key) return
    if (!apiEnabled()) {
      setState({ status: 'error', data: null, error: '未配置后端（VITE_API_URL）' })
      return
    }
    let cancelled = false
    loadedKey.current = key
    setState((prev) => ({ status: 'loading', data: prev.data }))
    // 顶部进度条：这一下就是站内跳转真正花时间的地方。
    // 注意 done 必须走 finally —— 只挂在 then 上的话，一次失败就会把计数永远留在 1，
    // 那根条会一直卡在 90% 不下来
    const done = startPageLoad()
    api
      .get<T>(key)
      .then((data) => {
        if (!cancelled) setState({ status: 'ready', data })
      })
      .catch((e: unknown) => {
        if (cancelled) return
        // 失败要把 loadedKey 清掉，否则同一个页面再也不会重试
        loadedKey.current = null
        setState({ status: 'error', data: null, error: e instanceof Error ? e.message : '加载失败' })
      })
      .finally(done)
    return () => {
      cancelled = true
    }
  }, [key])

  return state
}
