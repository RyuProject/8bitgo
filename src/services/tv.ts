/**
 * 8BitGo TV 的取数层。
 *
 * 频道「现在播哪款、接下来轮到哪些」由服务端按时间确定性排出（见 server/src/routes/tv.js）。
 * 前端只负责：拉信号 → 播不到（503 / 网络错）就退回游戏库浏览；播到了就按时间切台。
 *
 * 切台是纯客户端算的：`Date.now()` 落在第几个时间段，就播池子里的第几款。
 * 这样不需要任何实时推送，所有访客在同一时刻看到的是同一款游戏，像真频道一样。
 */
import type { Game, PlatformId } from '@/types'
import { api, apiEnabled, ApiError } from './api'

/** 每款游戏在频道里播多久（毫秒）。必须和 server/src/routes/tv.js 的 TV_SEGMENT_MS 一致 */
export const TV_SEGMENT_MS = 8 * 60 * 1000

export interface TvSignal {
  live: boolean
  channel: string
  tagline: string
  /** 单段时长（毫秒），前端按它切台 */
  segmentMs: number
  /** 当前在看的观众数（演示值） */
  viewers: number
  /** 频道轮播的游戏池（前端 Game 形状） */
  pool: Game[]
  /** 收不到信号时附带的说明（HTTP 状态或 'net'） */
  reason?: string
}

/**
 * 拉直播信号。
 *
 * 正常：服务端回 `{ live: true, pool }`，前端进入「直播模式」。
 * 异常：服务端回 503（没游戏可播 / 信号丢失），或网络根本不通 —— 统一转成
 * `live: false` 的信号，前端据此退回游戏库。这正是「如果 503 了借鉴 /pro」的落点。
 */
export async function fetchTv(platform?: PlatformId): Promise<TvSignal> {
  if (!apiEnabled()) {
    // 没配后端：本地模式也能跑，但频道没有数据源，直接当信号丢失处理
    return { live: false, channel: '8BitGo TV', tagline: '', segmentMs: TV_SEGMENT_MS, viewers: 0, pool: [], reason: 'net' }
  }
  try {
    const url = platform ? `/api/tv?platform=${encodeURIComponent(platform)}` : '/api/tv'
    const data = await api.get<TvSignal>(url)
    return data
  } catch (e) {
    const status = e instanceof ApiError ? e.status : 0
    // 503 / 网络错都算「信号丢失」，交给前端退回游戏库
    return {
      live: false,
      channel: '8BitGo TV',
      tagline: '',
      segmentMs: TV_SEGMENT_MS,
      viewers: 0,
      pool: [],
      reason: status ? String(status) : 'net',
    }
  }
}

export interface TvRotation {
  /** 当前在播的游戏 */
  current: Game
  /** 接下来若干款（含它们各自的开始时刻，用于节目单） */
  schedule: Array<{ game: Game; startsAt: number }>
  /** 当前这一段的开始 / 结束时刻 */
  startedAt: number
  endsAt: number
}

/**
 * 按时间算出当前这一档节目和后面的节目单。
 *
 * 取 `now` 的整数段号，对池子长度取模得到当前下标 —— 池子为空时返回 null。
 * 同一时刻所有访客算出来下标一致，所以大家看到的是同一款游戏。
 */
export function computeRotation(pool: Game[], now: number = Date.now(), segmentMs: number = TV_SEGMENT_MS): TvRotation | null {
  const n = pool.length
  if (n === 0) return null
  const seg = Math.floor(now / segmentMs)
  const idx = ((seg % n) + n) % n
  const current = pool[idx]
  const schedule = Array.from({ length: Math.min(6, n) }, (_, i) => ({
    game: pool[(idx + 1 + i) % n],
    startsAt: (seg + 1 + i) * segmentMs,
  }))
  return {
    current,
    schedule,
    startedAt: seg * segmentMs,
    endsAt: (seg + 1) * segmentMs,
  }
}

/** 当前段已播进度（0~1），给进度条用 */
export function rotationProgress(rotation: TvRotation, now: number = Date.now()): number {
  const span = rotation.endsAt - rotation.startedAt
  if (span <= 0) return 0
  return Math.min(1, Math.max(0, (now - rotation.startedAt) / span))
}

/** 把毫秒数格式化成 m:ss（节目单「距开播还有多久」用） */
export function formatCountdown(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000))
  const m = Math.floor(total / 60)
  const s = total % 60
  return `${m}:${String(s).padStart(2, '0')}`
}
