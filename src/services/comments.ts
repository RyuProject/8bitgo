/**
 * 游戏评论的前端数据层。
 *
 * 刻意不做全局 store：评论只在详情页侧栏这一处用，而且是「随时在变」的数据 ——
 * 缓存起来的收益远小于「用户发完看不到自己那条」的代价。组件自己持有列表状态，
 * 发表 / 编辑 / 删除后就地更新那一条。
 *
 * 没配后端（VITE_API_URL 为空）时全部退化成空列表和「不可用」——
 * 评论必须有服务端，不像稍后玩那样能在浏览器里凑一份。
 */
import type { CommentPage, GameComment } from '@/types'
import { api, apiEnabled } from './api'
import { getLang } from './lang'
import { getT, fmt } from './i18n'

/** 和后端 comments.js 的 MAX_LEN / EDIT_WINDOW_MS 对齐（服务端仍然会再卡一道） */
export const COMMENT_MAX_LENGTH = 2000
export const COMMENT_EDIT_WINDOW_MS = 5 * 60 * 1000
export const COMMENT_PAGE_SIZE = 20

const EMPTY: CommentPage = { total: 0, page: 1, pageSize: COMMENT_PAGE_SIZE, items: [] }

export function commentsAvailable(): boolean {
  return apiEnabled()
}

export async function fetchComments(gameSlug: string, page = 1): Promise<CommentPage> {
  if (!apiEnabled()) return EMPTY
  const qs = `game=${encodeURIComponent(gameSlug)}&page=${page}&pageSize=${COMMENT_PAGE_SIZE}`
  const r = await api.get<CommentPage>(`/api/comments?${qs}`)
  // 后端理论上一定给全，但前端不该因为少一个字段整块崩掉
  return { ...EMPTY, ...r, items: Array.isArray(r?.items) ? r.items : [] }
}

export async function postComment(gameSlug: string, content: string, parentId?: string): Promise<GameComment> {
  return api.post<GameComment>('/api/comments', { gameSlug, content, parentId })
}

export async function editComment(id: string, content: string): Promise<GameComment> {
  return api.patch<GameComment>(`/api/comments/${encodeURIComponent(id)}`, { content })
}

export async function deleteComment(id: string): Promise<void> {
  await api.del(`/api/comments/${encodeURIComponent(id)}`)
}

/** 还在可编辑窗口里吗（前端先判一次，省得点进编辑态才被服务端拒） */
export function canStillEdit(comment: GameComment): boolean {
  const t = new Date(comment.createdAt).getTime()
  if (!Number.isFinite(t)) return false
  return Date.now() - t < COMMENT_EDIT_WINDOW_MS
}

/* ---------------- 国家 ---------------- */

/**
 * 两位国家码 -> 国旗 emoji。
 *
 * 办法是把 'CN' 的两个字母换成对应的「区域指示符号」码点（U+1F1E6 起），
 * 系统字体自己会把它们组合成国旗 —— 不需要任何图片资源，也不用引国旗图标库。
 *
 * 'XX'（未知）和 'T1'（Cloudflare 对 Tor 出口的标记）不是国家，回一个地球。
 */
export function countryFlag(code: string): string {
  const c = String(code || '').toUpperCase()
  if (!/^[A-Z]{2}$/.test(c) || c === 'XX' || c === 'T1') return '🌐'
  return String.fromCodePoint(...[...c].map((ch) => 0x1f1e6 + ch.charCodeAt(0) - 65))
}

/**
 * 两位国家码 -> 当前站点语言下的国家名。
 *
 * Intl.DisplayNames 是浏览器内置的，八种语言的国家名不用我们自己维护一份。
 * 老浏览器没有它、或者传进来的不是合法国家码时，退回显示那两个字母本身。
 */
export function countryName(code: string): string {
  const c = String(code || '').toUpperCase()
  if (!/^[A-Z]{2}$/.test(c) || c === 'XX' || c === 'T1') return getT().comments.unknownRegion
  try {
    return new Intl.DisplayNames([getLang()], { type: 'region' }).of(c) || c
  } catch {
    return c
  }
}

/* ---------------- 时间 ---------------- */

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

/**
 * 相对时间（「3 分钟前」/「3 minutes ago」）。
 *
 * 用 Intl.RelativeTimeFormat 而不是自己拼字符串：八种语言的复数和词序各不相同，
 * 手写必然出「1 minutes ago」这种。超过 30 天就直接显示日期 ——
 * 「11 个月前」对一条评论来说信息量太低。
 */
export function timeAgo(iso: string): string {
  const then = new Date(iso).getTime()
  if (!Number.isFinite(then)) return ''
  const diff = Date.now() - then
  if (diff < MINUTE) return getT().comments.justNow
  const lang = getLang()
  if (diff > 30 * DAY) {
    try {
      return new Intl.DateTimeFormat(lang, { year: 'numeric', month: 'short', day: 'numeric' }).format(then)
    } catch {
      return iso.slice(0, 10)
    }
  }
  try {
    const rtf = new Intl.RelativeTimeFormat(lang, { numeric: 'always' })
    if (diff < HOUR) return rtf.format(-Math.floor(diff / MINUTE), 'minute')
    if (diff < DAY) return rtf.format(-Math.floor(diff / HOUR), 'hour')
    return rtf.format(-Math.floor(diff / DAY), 'day')
  } catch {
    // Intl.RelativeTimeFormat 不可用时的兜底：不追求语法正确，只求别是空白
    return fmt(getT().comments.daysAgo, { n: Math.max(1, Math.floor(diff / DAY)) })
  }
}

/* ---------------- 后台 ---------------- */

export type CommentStatusFilter = 'all' | 'visible' | 'hidden' | 'deleted'

export interface AdminCommentQuery {
  status?: CommentStatusFilter
  q?: string
  game?: string
  page?: number
  pageSize?: number
}

/** 后台列表：含被隐藏和被删除的，带原文、邮箱和所属游戏 */
export async function fetchAdminComments(query: AdminCommentQuery = {}): Promise<CommentPage> {
  if (!apiEnabled()) return EMPTY
  const p = new URLSearchParams()
  if (query.status && query.status !== 'all') p.set('status', query.status)
  if (query.q?.trim()) p.set('q', query.q.trim())
  if (query.game?.trim()) p.set('game', query.game.trim())
  p.set('page', String(query.page ?? 1))
  p.set('pageSize', String(query.pageSize ?? 30))
  const r = await api.get<CommentPage>(`/api/comments/admin/list?${p.toString()}`, true)
  return { ...EMPTY, ...r, items: Array.isArray(r?.items) ? r.items : [] }
}

/** 隐藏 / 恢复。恢复不会把作者自己删掉的评论捞回来（那是另一件事） */
export async function setCommentHidden(id: string, hidden: boolean): Promise<void> {
  await api.patch(`/api/comments/admin/${encodeURIComponent(id)}`, { hidden }, true)
}

/** 后台彻底删除：数据库里真删掉，引用它的回复只会失去引用关系，不会被连坐 */
export async function purgeComment(id: string): Promise<void> {
  await api.del(`/api/comments/admin/${encodeURIComponent(id)}`, true)
}
