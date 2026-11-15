/**
 * 「对冲」请求：先发第一条线路，等一会儿还没结果就同时发第二条，谁先成功用谁，另一条立刻中止。
 *
 * 为什么（2026-11-14《僵尸盒子 2：双人版》CN / Android Chrome 109）：8BG 的数据密钥只有 113 字节，
 * 在 cn.8bitgo.com（EdgeOne）上却走了 17.3 秒，ROM 0.4 秒就下完了，整局卡在等密钥。
 * 服务端这条接口是即时返回的，慢在那条线路上；单发、没有时限，玩家只能干等。
 *
 * - 第一条网络层失败或回了错误，立即发下一条，不等 `hedgeDelayMs`；
 * - 成功的判定由 `attempt` 自己做（内容校验失败就抛错），坏响应不会赢；
 * - 全部失败时抛**第一条**线路的错误：那是原本就会报给玩家的那一个。
 */
export interface HedgeOptions {
  /** 第一条发出后多久还没结果就发第二条 */
  hedgeDelayMs: number
  /** 每一条的时限，到点中止这一条（不影响其它线路） */
  attemptTimeoutMs?: number
  /** 中止整组请求 */
  signal?: AbortSignal
}

export function hedgedRequest<T>(
  urls: readonly string[],
  attempt: (url: string, signal: AbortSignal) => Promise<T>,
  options: HedgeOptions,
): Promise<T> {
  const list = urls.filter((u, i) => u && urls.indexOf(u) === i)
  if (!list.length) return Promise.reject(new Error('没有可用的请求地址'))
  return new Promise<T>((resolve, reject) => {
    const controllers: AbortController[] = []
    const errors: unknown[] = []
    let started = 0
    let finished = 0
    let settled = false
    let hedgeTimer: ReturnType<typeof setTimeout> | null = null

    const cleanup = () => {
      if (hedgeTimer) clearTimeout(hedgeTimer)
      hedgeTimer = null
      options.signal?.removeEventListener('abort', onAbort)
    }
    const settle = (fn: () => void, winner?: AbortController) => {
      if (settled) return
      settled = true
      cleanup()
      for (const c of controllers) if (c !== winner) c.abort()
      fn()
    }
    function onAbort() {
      settle(() => reject(options.signal?.reason ?? new DOMException('Aborted', 'AbortError')))
    }
    const scheduleNext = () => {
      if (hedgeTimer || started >= list.length) return
      hedgeTimer = setTimeout(() => {
        hedgeTimer = null
        launch()
      }, options.hedgeDelayMs)
    }
    const launch = () => {
      if (settled || started >= list.length) return
      const index = started++
      const controller = new AbortController()
      controllers.push(controller)
      const timer = options.attemptTimeoutMs
        ? setTimeout(() => controller.abort(new DOMException('请求超时', 'TimeoutError')), options.attemptTimeoutMs)
        : null
      attempt(list[index], controller.signal).then(
        (value) => settle(() => resolve(value), controller),
        (error) => {
          errors[index] = error
          finished++
          if (settled) return
          if (started < list.length) {
            // 这条已经失败：不必再等对冲延时
            if (hedgeTimer) clearTimeout(hedgeTimer)
            hedgeTimer = null
            launch()
          } else if (finished >= list.length) {
            settle(() => reject(errors[0]))
          }
        },
      ).finally(() => {
        if (timer) clearTimeout(timer)
      })
      scheduleNext()
    }

    if (options.signal?.aborted) return onAbort()
    options.signal?.addEventListener('abort', onAbort, { once: true })
    launch()
  })
}
