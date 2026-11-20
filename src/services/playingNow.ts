/**
 * 详情页「正在玩」：这款游戏此刻有几个人在直播 / 联机玩（服务端口径见 server/src/playing-now.js）。
 *
 * 三条约束，都是为了「不拖慢首屏」：
 *   1. **不进 SSR**：这是实时数字，烘进 HTML 会被边缘缓存几分钟，显示的就是假数。
 *   2. **等页面空闲再拉**：首屏的图片、播放器 chunk、ROM 探测更要紧，这个数晚一两秒出现没人在意。
 *   3. **只在标签页可见时每分钟刷新一次**：切到后台就停，回来立刻补一次；拉失败不重试也不报错，
 *      保留上一次的数（第一次就失败则保持 null，界面显示「—」）。
 */
import { useEffect, useState } from 'react'
import { api, apiEnabled } from './api'

const REFRESH_MS = 60_000
/** 页面空闲回调的最长等待：浏览器一直忙也不能让这个数永远不出来 */
const IDLE_TIMEOUT_MS = 3_000

type IdleWindow = Window & {
  requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => number
  cancelIdleCallback?: (id: number) => void
}

export function usePlayingNow(gameSlug: string | undefined, enabled = true): number | null {
  const [state, setState] = useState<{ slug: string; n: number } | null>(null)

  useEffect(() => {
    if (!gameSlug || !enabled || !apiEnabled() || typeof window === 'undefined') return
    let disposed = false
    let timer = 0
    let idle = 0
    let controller: AbortController | null = null
    const w = window as IdleWindow

    const fetchOnce = async () => {
      controller?.abort()
      const ctl = new AbortController()
      controller = ctl
      try {
        const r = await api.get<{ playing: number }>(`/api/live/playing?game=${encodeURIComponent(gameSlug)}`, false, ctl.signal)
        const n = Number(r?.playing)
        if (!disposed && !ctl.signal.aborted && Number.isFinite(n) && n >= 0) setState({ slug: gameSlug, n: Math.floor(n) })
      } catch {
        /* 装饰性数字：失败就保留上一次的结果 */
      }
    }
    const schedule = () => {
      window.clearTimeout(timer)
      timer = window.setTimeout(() => {
        if (document.visibilityState === 'visible') void fetchOnce()
        schedule()
      }, REFRESH_MS)
    }
    const onVisible = () => {
      if (document.visibilityState !== 'visible') return
      void fetchOnce()
      schedule()
    }

    const start = () => {
      if (disposed) return
      void fetchOnce()
      schedule()
    }
    if (w.requestIdleCallback) idle = w.requestIdleCallback(start, { timeout: IDLE_TIMEOUT_MS })
    else timer = window.setTimeout(start, 1_000)
    document.addEventListener('visibilitychange', onVisible)

    return () => {
      disposed = true
      controller?.abort()
      window.clearTimeout(timer)
      if (idle && w.cancelIdleCallback) w.cancelIdleCallback(idle)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [gameSlug, enabled])

  // 换游戏时不把上一款的数挂到下一款上
  return state && state.slug === gameSlug ? state.n : null
}
