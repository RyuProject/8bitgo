import { useEffect, useState } from 'react'

/**
 * 播放器浮层（DOS 屏幕键盘 / 触屏鼠标）该 portal 到哪里。
 *
 * 原生全屏时只有 fullscreen 元素的子树会被画出来，portal 到 <body> 的浮层直接看不见；
 * 所以全屏时挂进 fullscreenElement，否则挂 <body>。全屏切换时跟着重渲染换挂载点。
 */
export function useOverlayHost(): HTMLElement | null {
  const [host, setHost] = useState<HTMLElement | null>(() =>
    typeof document === 'undefined' ? null : ((document.fullscreenElement as HTMLElement | null) ?? document.body),
  )
  useEffect(() => {
    const sync = () => setHost((document.fullscreenElement as HTMLElement | null) ?? document.body)
    sync()
    document.addEventListener('fullscreenchange', sync)
    return () => document.removeEventListener('fullscreenchange', sync)
  }, [])
  return host
}
