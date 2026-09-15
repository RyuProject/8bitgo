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
      /*
        w-full 不能少。广告位常常落在 flex 的 items-center 容器里，此时子项在交叉轴上的
        宽度由**内容**决定 —— <ins> 是空的，量出来就是 0，AdSense 读 offsetWidth=0 直接不填，
        控制台报 "No slot size for availableWidth=0"，页面上就是一片空白（踩过）。
        给一个确定的宽度，宽度上限交给调用方用 max-w-* 收。
      */
      className={['adsbygoogle', 'w-full', className].filter(Boolean).join(' ')}
      style={{ display: 'block' }}
      data-ad-client={PUBLISHER_ID}
      data-ad-slot={slot}
      data-ad-format={format}
      data-full-width-responsive={responsive ? 'true' : 'false'}
    />
  )
}
