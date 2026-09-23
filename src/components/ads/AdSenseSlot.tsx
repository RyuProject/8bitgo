import { useEffect, useRef } from 'react'

// AdSense 的发布商 ID，全站共用，记在这里避免散落到各处
const PUBLISHER_ID = 'ca-pub-9765778307056404'
const SCRIPT_SRC = `https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js?client=${PUBLISHER_ID}`

// 广告位会随播放器状态频繁卸载，不能在脚本未加载时先把 push 排进全局队列：
// 等队列被消费时，原来的 <ins> 可能早没了，官方脚本便报「所有广告位都已填充」。
let scriptReady: Promise<boolean> | null = null

function ensureScriptReady(): Promise<boolean> {
  if (scriptReady) return scriptReady
  scriptReady = new Promise<boolean>((resolve) => {
    const script = document.createElement('script')
    script.async = true
    script.crossOrigin = 'anonymous'
    script.src = SCRIPT_SRC
    script.addEventListener('load', () => resolve(true), { once: true })
    script.addEventListener('error', () => {
      script.remove()
      scriptReady = null
      resolve(false)
    }, { once: true })
    document.head.appendChild(script)
  })
  return scriptReady
}

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
 * 一个 AdSense 广告位。只为仍在 DOM 且尚未被官方脚本处理的 <ins> 请求填充。
 */
export function AdSenseSlot({ slot, className, format = 'auto', responsive = true }: AdSenseSlotProps) {
  const insRef = useRef<HTMLModElement>(null)
  const pushedRef = useRef(false)

  useEffect(() => {
    let mounted = true
    let frame = 0
    void ensureScriptReady().then((loaded) => {
      if (!loaded || !mounted) return
      // 等这一帧的 React 状态切换落到 DOM：玩家刚点开始时，空闲广告位会被卸载。
      frame = window.requestAnimationFrame(() => {
        const ins = insRef.current
        if (!mounted || !ins?.isConnected || pushedRef.current || ins.hasAttribute('data-adsbygoogle-status')) return
        pushedRef.current = true
        try {
          ;(window.adsbygoogle = window.adsbygoogle || []).push({})
        } catch {
          // 被广告拦截器拦掉时静默失败，不影响播放器其余功能
        }
      })
    })
    return () => {
      mounted = false
      if (frame) window.cancelAnimationFrame(frame)
    }
  }, [slot])

  return (
    <ins
      ref={insRef}
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
