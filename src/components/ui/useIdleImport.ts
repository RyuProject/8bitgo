import { useEffect, useRef, useState } from 'react'
import { whenIdle } from '@/lib/idle'

/**
 * 等浏览器空闲再把一个模块拉下来，拿到之前返回 null。
 *
 * ## 和 React.lazy 的区别（不是重复造轮子）
 *
 * 这里刻意**不用** lazy + Suspense，因为这个 shell 里的组件很多都在 SSR 的
 * 同步渲染路径上（`entry-server.tsx` 用的是 renderToString，侧边栏、顶栏
 * 这些外壳每个页面都要出 HTML）。lazy 在服务端会挂起、退回 fallback，
 * 到了客户端一旦 chunk 命中缓存就立刻出内容 —— 两帧结构对不上，水合会报错。
 *
 * 这个 hook 在服务端**和客户端首帧**都返回 null：两边渲染的东西完全一致，
 * 水合不会错位；之后（空闲时）chunk 到货，effect 里 setState 才把真实组件
 * 挂上去。代价是这类组件会「晚一拍」出现，所以只适合徽标这种装饰性内容。
 *
 * ⚠️ `load` 必须是**模块级稳定引用**（写成 `() => import('./x')` 常量）。
 * 内部用 ref 存它、effect 只跑一次，别在调用处现造箭头函数指望它变化。
 */
export function useIdleImport<M>(
  load: () => Promise<M>,
  { timeout = 1500, fallbackMs = 400 }: { timeout?: number; fallbackMs?: number } = {},
): M | null {
  const loadRef = useRef(load)
  loadRef.current = load
  const [mod, setMod] = useState<M | null>(null)

  useEffect(() => {
    let alive = true
    const cancel = whenIdle(
      () => {
        // 加载失败就算了：徽标少一个数字，比在控制台里抛一个没人处理的 rejection 强
        loadRef.current()
          .then((m) => {
            if (alive) setMod(m)
          })
          .catch(() => {})
      },
      { timeout, fallbackMs },
    )
    return () => {
      alive = false
      cancel()
    }
  }, [timeout, fallbackMs])

  return mod
}
