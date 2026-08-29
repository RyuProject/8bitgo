/**
 * HTML5 网页游戏运行时。
 *
 * 和主机模拟器不同，这类游戏本身就是一个网站：入口可能是 R2 上的 index.html，
 * 也可能是单独部署的完整应用。这里负责把入口放进播放器 iframe，不搬运也不补齐
 * 游戏资源；脚本、WASM、音频等相对路径仍由游戏自己的部署目录提供。
 */
import type { Capability, MountOptions, Runtime, RuntimeHandle } from '../types'

function mount(container: HTMLElement, options: MountOptions): RuntimeHandle {
  const caps = new Set<Capability>()
  let destroyed = false
  let objectUrl = ''

  const iframe = document.createElement('iframe')
  iframe.title = `${options.gameName} · HTML5`
  iframe.style.cssText = 'width:100%;height:100%;border:0;display:block;background:#000'
  iframe.allowFullscreen = true
  iframe.referrerPolicy = 'strict-origin-when-cross-origin'
  iframe.setAttribute('allow', 'fullscreen; autoplay; gamepad; clipboard-read; clipboard-write')
  /**
   * 游戏需要脚本、存储、手柄和全屏，但不应借嵌入页直接改写 8BitGo 顶层窗口。
   * 不给 allow-top-navigation；这样第三方页面即使被攻破，也不能把玩家整页带走。
   */
  iframe.setAttribute(
    'sandbox',
    'allow-scripts allow-same-origin allow-forms allow-modals allow-pointer-lock allow-popups allow-downloads',
  )

  iframe.addEventListener('load', () => {
    if (destroyed) return
    options.onReady?.()
  })
  iframe.addEventListener('error', () => {
    if (destroyed) return
    options.onError?.('HTML5 游戏页面加载失败。请检查入口地址，以及目标站点是否允许被 iframe 嵌入。')
  })

  options.onCaps?.(caps)
  options.onProgress?.({ phase: 'starting' })
  container.replaceChildren(iframe)

  if (typeof options.game === 'string') {
    iframe.src = options.game
  } else {
    // 单文件 HTML 可以直接运行；需要其它素材的项目应部署完整目录并绑定 index.html。
    objectUrl = URL.createObjectURL(options.game)
    iframe.src = objectUrl
  }

  return {
    caps,
    destroy() {
      destroyed = true
      try {
        iframe.src = 'about:blank'
      } catch {
        /* ignore */
      }
      iframe.remove()
      if (objectUrl) URL.revokeObjectURL(objectUrl)
    },
  }
}

export const html5Runtime: Runtime = {
  id: 'html5',
  name: 'HTML5 / WebAssembly',
  description: '直接运行已部署的 HTML5 或 WebAssembly 网页游戏',
  extensions: ['html', 'htm'],
  priority: 100,
  available: () => true,
  supports: (platform) => platform === 'html5',
  engineLabel: () => 'HTML5 / WASM',
  mount,
}
