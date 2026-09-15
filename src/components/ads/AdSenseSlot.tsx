import { useEffect, useRef } from 'react'

// AdSense 的发布商 ID，全站共用，记在这里避免散落到各处
const PUBLISHER_ID = 'ca-pub-9765778307056404'
const SCRIPT_SRC = `https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js?client=${PUBLISHER_ID}`

// 脚本只需往页面里塞一次。用模块级标记锁住，组件卸载再挂载也不会重复注入。
let scriptInjected = false

declare global {
  interface Window {
    adsbygoogle?: unknown[]
  }
}

interface AdSenseSlotProps {
  /** 广告位 ID（data-ad-slot） */
  slot: string
  className?: string
  /**
   * 广告形状。默认 auto 会按容器自适应，竖屏容器里可能长得很高；
   * 夹在文案 / 进度条之间时用 horizontal（横幅式），高度可控不喧宾夺主。
   */
  format?: 'auto' | 'horizontal' | 'rectangle'
  /** full-width-responsive。horizontal 时建议关掉，否则自适应又会把高度撑开 */
  responsive?: boolean
}

/**
 * 一个 AdSense 广告位。渲染 <ins> 后在挂载时调用 adsbygoogle.push({}) 触发填充。
 *
 * push 早于官方脚本加载也是安全的：脚本没到位时 window.adsbygoogle 还不存在，
 * 这行会先建一个数组当队列，等脚本就绪后由官方库自行消费。
 */
export function AdSenseSlot({ slot, className, format = 'auto', responsive = true }: AdSenseSlotProps) {
  const pushedRef = useRef(false)

  useEffect(() => {
    if (!scriptInjected) {
      const s = document.createElement('script')
      s.async = true
      s.crossOrigin = 'anonymous'
      s.src = SCRIPT_SRC
      document.head.appendChild(s)
      scriptInjected = true
    }
    if (pushedRef.current) return
    pushedRef.current = true
    try {
      ;(window.adsbygoogle = window.adsbygoogle || []).push({})
    } catch {
      // 被广告拦截器拦掉时静默失败，不影响播放器其余功能
    }
  }, [slot])

  return (
    <ins
      className={['adsbygoogle', className].filter(Boolean).join(' ')}
      style={{ display: 'block' }}
      data-ad-client={PUBLISHER_ID}
      data-ad-slot={slot}
      data-ad-format={format}
      data-full-width-responsive={responsive ? 'true' : 'false'}
    />
  )
}
