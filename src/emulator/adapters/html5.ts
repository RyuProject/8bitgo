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
  iframe.referrerPolicy = 'strict-origin-when-cross-origin'
  /**
   * 全屏只声明在 allow 里。再写一个 allowfullscreen 属性会让 Chrome 报
   * 「Allow attribute will take precedence over 'allowfullscreen'」—— 两者并存时
   * 现代浏览器只读 allow，老属性纯属噪音。其余 adapter（ruffle / j2me /
   * emulatorjs / webretro）本来就只写 allow，这里跟它们保持一致。
   */
  /**
   * cross-origin-isolated 是给「游戏要 SharedArrayBuffer」那类构建准备的（reVC、
   * Unity 的多线程构建等）：这个权限策略默认只给 self，**跨源子框架不会自动继承**，
   * 不在这里授出去，iframe 里就永远拿不到 SharedArrayBuffer。
   *
   * ⚠️ 光授权不够。SharedArrayBuffer 还要求**顶层文档**发
   * COOP: same-origin + COEP: require-corp，且整条祖先链都隔离 —— 详情页做不到这件事
   * （require-corp 会掐掉 Google Fonts、收录脚本和跨源封面图）。所以这类游戏走
   * server/src/routes/play.js 那条独立整页路由，登记表在 shared/isolated-embeds.js。
   * 这里授权只是把该给的给到位，让那条路径能用同一个运行时。
   */
  iframe.setAttribute('allow', 'fullscreen; autoplay; gamepad; cross-origin-isolated; clipboard-read; clipboard-write')
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
