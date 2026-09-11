import { useEffect, useState } from 'react'

/**
 * 系统的「减少动态效果」开关。
 *
 * 原来这段在 HomeBanner 和 CollectionCard 里**各抄了一份**，2026-09-11 抽出来 ——
 * 弹幕那边要用是第三处，再抄一份就该有人写歪了。
 *
 * ⚠️ 初值恒为 false、挂载之后才同步（不在 useState 的初始化里读 matchMedia）：
 * SSR 那边没有 matchMedia，而首帧要和服务端渲染的 HTML 对得上。
 * 代价是开了这个开关的用户会先看到一帧动画 —— 比整页 hydration 不匹配好得多。
 */
export function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(false)
  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)')
    const sync = () => setReduced(mq.matches)
    sync()
    mq.addEventListener('change', sync)
    return () => mq.removeEventListener('change', sync)
  }, [])
  return reduced
}
