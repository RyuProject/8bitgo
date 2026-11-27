/**
 * 前台空闲时限：标签页隐藏时暂停，回到前台后只剩余之前没用完的时间。
 *
 * 浏览器会节流后台标签的计时器，部分 WebView 却仍会在后台触发长时限回调。启动超时因此必须
 * 和播放器外层看门狗采用同一口径：玩家看不见页面的时间不应被当作模拟器卡死时间。
 */
export interface VisibilityTimeout {
  /** 有可观测进展时重新给足一段时限。 */
  reset(): void
  /** 成功、失败或会话销毁后停止计时并解除可见性监听。 */
  dispose(): void
}

export interface VisibilityTimeoutEnvironment {
  now?: () => number
  setTimeout?: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>
  clearTimeout?: (timer: ReturnType<typeof setTimeout>) => void
  isVisible?: () => boolean
  subscribeVisibility?: (callback: () => void) => () => void
}

/** 只累计前台时间的空闲截止；计时到期前会复核可见状态，避免后台延迟回调误杀启动。 */
export function createVisibilityTimeout(
  durationMs: number,
  onTimeout: () => void,
  environment: VisibilityTimeoutEnvironment = {},
): VisibilityTimeout {
  const duration = Math.max(0, Number.isFinite(durationMs) ? durationMs : 0)
  const now = environment.now ?? (() =>
    typeof performance !== 'undefined' && typeof performance.now === 'function' ? performance.now() : Date.now())
  const scheduleTimer = environment.setTimeout ?? ((callback, delayMs) => setTimeout(callback, delayMs))
  const cancelTimer = environment.clearTimeout ?? ((timer) => clearTimeout(timer))
  const visible = environment.isVisible ?? (() =>
    typeof document === 'undefined' || document.visibilityState !== 'hidden')
  const subscribe = environment.subscribeVisibility ?? ((callback) => {
    if (typeof document === 'undefined') return () => {}
    document.addEventListener('visibilitychange', callback)
    return () => document.removeEventListener('visibilitychange', callback)
  })

  let remaining = duration
  let timer: ReturnType<typeof setTimeout> | null = null
  let segmentStartedAt = 0
  let disposed = false
  let unsubscribe = () => {}

  const clearScheduled = (accountElapsed: boolean) => {
    if (timer === null) return
    cancelTimer(timer)
    timer = null
    if (accountElapsed) remaining = Math.max(0, remaining - Math.max(0, now() - segmentStartedAt))
  }

  const finish = () => {
    if (disposed) return
    disposed = true
    clearScheduled(false)
    unsubscribe()
    onTimeout()
  }

  const schedule = () => {
    if (disposed || timer !== null || !visible()) return
    segmentStartedAt = now()
    timer = scheduleTimer(() => {
      timer = null
      remaining = Math.max(0, remaining - Math.max(0, now() - segmentStartedAt))
      if (!visible()) return
      if (remaining === 0) finish()
      else schedule()
    }, remaining)
  }

  const onVisibilityChange = () => {
    if (visible()) schedule()
    else clearScheduled(true)
  }

  try {
    unsubscribe = subscribe(onVisibilityChange)
  } catch {
    unsubscribe = () => {}
  }
  schedule()

  return {
    reset() {
      if (disposed) return
      clearScheduled(false)
      remaining = duration
      schedule()
    },
    dispose() {
      if (disposed) return
      disposed = true
      clearScheduled(false)
      unsubscribe()
    },
  }
}
