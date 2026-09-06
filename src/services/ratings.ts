/**
 * 游戏评分的前端数据层。
 *
 * 和评论一样不做全局 store：评分只在详情页和评论框这两处用，而且是随时在变的数据，
 * 缓存的收益远小于「刚打完分刷新看不到」的代价。
 *
 * 匿名身份（anonId）
 * ------------------
 * 未登录也能评分，所以要有个东西认出「这还是刚才那个人」，否则同一个人点五次就是五票。
 * 这里用的是浏览器本地生成、长期保存的一串随机数。
 *
 * ⚠️ 它**不是**防刷手段 —— 前端存的东西，清一下就换一个。真正的去重底线在服务端的
 * 「同一 IP 对同一款游戏只留一张匿名票」。anonId 的作用只有一个：让同一个人**改得了自己的分**。
 * 所以这里不需要加密、不需要签名，也不值得为它做任何防篡改。
 *
 * localStorage 不可用时（隐私模式、浏览器禁用站点数据）退化成一个**内存里的**随机串：
 * 这一次会话内还能正常改分，刷新之后就换新的了 —— 比整个功能报错要好。
 */
import type { RatingSummary } from '@/types'
import { api, apiEnabled } from './api'
import { FEATURES } from '@/config/features'

const ANON_KEY = '8bitgo.rating.anon'
/** 和服务端 game_ratings.anon_id 的 CHAR(32) 对齐 */
const ANON_LEN = 32

let memoryAnonId = ''

function randomId(): string {
  const bytes = new Uint8Array(ANON_LEN / 2)
  // crypto 在所有目标浏览器上都有；真没有时退回 Math.random —— 这串只是用来认「同一个人」，
  // 不参与任何安全判断，撞了最多是两个人共用一票
  if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') {
    crypto.getRandomValues(bytes)
  } else {
    for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256)
  }
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
}

/** 拿（必要时生成）这台浏览器的匿名评分标识 */
export function anonId(): string {
  try {
    const saved = localStorage.getItem(ANON_KEY)
    if (saved && /^[a-f0-9]{32}$/i.test(saved)) return saved
    const fresh = randomId()
    localStorage.setItem(ANON_KEY, fresh)
    return fresh
  } catch {
    // 存不了就至少在这次会话里保持同一个值
    if (!memoryAnonId) memoryAnonId = randomId()
    return memoryAnonId
  }
}

export function ratingsAvailable(): boolean {
  return FEATURES.ratings && apiEnabled()
}

const EMPTY: RatingSummary = {
  average: null,
  count: 0,
  weight: 0,
  distribution: { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 },
  mine: null,
}

/** 后端理论上一定给全，但前端不该因为少一个字段整块崩掉 */
function normalize(r: Partial<RatingSummary> | null | undefined): RatingSummary {
  return {
    ...EMPTY,
    ...r,
    distribution: { ...EMPTY.distribution, ...(r?.distribution ?? {}) },
    mine: r?.mine ?? null,
  }
}

export async function fetchRating(gameSlug: string): Promise<RatingSummary> {
  if (!ratingsAvailable()) return EMPTY
  const qs = `game=${encodeURIComponent(gameSlug)}&anonId=${anonId()}`
  return normalize(await api.get<RatingSummary>(`/api/ratings?${qs}`))
}

/** 打分 / 改分。登录与否由 api 层的 Bearer 决定，这里两种情况都把 anonId 带上 */
export async function submitRating(gameSlug: string, score: number): Promise<RatingSummary> {
  return normalize(await api.post<RatingSummary>('/api/ratings', { gameSlug, score, anonId: anonId() }))
}

/** 撤销自己那一票（在星星上再点一次当前分数） */
export async function clearRating(gameSlug: string): Promise<RatingSummary> {
  const qs = `game=${encodeURIComponent(gameSlug)}&anonId=${anonId()}`
  return normalize(await api.del<RatingSummary>(`/api/ratings?${qs}`))
}
