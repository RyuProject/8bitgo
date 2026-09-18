/**
 * 「等浏览器空闲再做这件事」的统一实现。
 *
 * 站内有两类活儿不属于首屏、但迟早都得干：IM 登录后在空闲时连腾讯 SDK、
 * 侧边栏那两个计数徽标要把联机房间栈拉下来。它们共同的问题是不能在首屏跟
 * 字体 / 封面抢带宽和主线程，但也不能永远不做 —— 所以 rIC 的 timeout 是
 * 「最晚什么时候也得执行」的保证，而不是建议。
 *
 * Safari 长期不支持 requestIdleCallback，退回一个 setTimeout：比首屏抢带宽晚，
 * 比用户真的要用到它早。
 */

export interface IdleOptions {
  /** requestIdleCallback 的 timeout：主线程一直不空闲时，最晚多久也要执行 */
  timeout: number
  /** 没有 requestIdleCallback 时的兜底延时 */
  fallbackMs: number
}

/** 返回一个取消函数：组件卸载时调用，免得已经没人要了还去加载 chunk */
export function whenIdle(cb: () => void, { timeout, fallbackMs }: IdleOptions): () => void {
  if (typeof window === 'undefined') return () => {}

  const ric = (window as unknown as {
    requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => void
    cancelIdleCallback?: (handle: number) => void
  }).requestIdleCallback

  if (typeof ric === 'function') {
    const handle = ric(cb, { timeout }) as unknown as number
    return () => {
      const cancel = (window as unknown as { cancelIdleCallback?: (h: number) => void }).cancelIdleCallback
      cancel?.(handle)
    }
  }

  const timer = window.setTimeout(cb, fallbackMs)
  return () => window.clearTimeout(timer)
}
