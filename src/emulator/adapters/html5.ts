/**
 * HTML5 网页游戏运行时。
 *
 * 和主机模拟器不同，这类游戏本身就是一个网站：入口可能是 R2 上的 index.html，
 * 也可能是单独部署的完整应用。这里负责把入口放进播放器 iframe，不搬运也不补齐
 * 游戏资源；脚本、WASM、音频等相对路径仍由游戏自己的部署目录提供。
 */
import type { Capability, CaptureSources, MountOptions, Runtime, RuntimeHandle } from '../types'
import { focusFrame, frameGamepads } from '../frameFocus'

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

  let loaded = false
  iframe.addEventListener('load', () => {
    if (destroyed) return
    loaded = true
    options.onReady?.()
    // 焦点交给 iframe，否则里面的游戏收不到键盘和手柄（见 frameFocus.ts）
    focusFrame(iframe)
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

  /**
   * 从 iframe 里把游戏画布找出来。
   *
   * 只找得到**同源**的：跨源时 contentDocument 直接是 null（读它还会抛），
   * 这不是可以绕过去的限制。
   *
   * 取面积最大的那块 —— 不少游戏除了主画布还挂着几张 1×1 或者小尺寸的
   * （预乘纹理、字体度量、离屏合成用的），按 DOM 顺序取第一个经常取到它们。
   * 同源的子 iframe 也往下找一层：门户式的 HTML5 游戏常常是「壳套一层真正的游戏页」。
   */
  function findCanvas(doc: Document | null, depth = 0): HTMLCanvasElement | null {
    if (!doc) return null
    let best: HTMLCanvasElement | null = null
    let bestArea = 0
    for (const c of Array.from(doc.querySelectorAll<HTMLCanvasElement>('canvas'))) {
      const area = c.width * c.height
      if (area > bestArea) {
        best = c
        bestArea = area
      }
    }
    if (best) return best
    if (depth >= 2) return null
    for (const nested of Array.from(doc.querySelectorAll('iframe'))) {
      let inner: Document | null = null
      try {
        inner = nested.contentDocument
      } catch {
        continue // 跨源的子框架，跳过
      }
      const found = findCanvas(inner, depth + 1)
      if (found) return found
    }
    return null
  }

  return {
    caps,
    /**
     * 直播 / 录像的画面来源。
     *
     * HTML5 游戏跑在 iframe 里，能不能抓到画面完全取决于**同不同源**：
     *
     *   同源（游戏部署在自家域名下，或走 server/src/routes/play.js 那条整页路由）
     *     → 能读到 iframe 的文档，把里面的 <canvas> 拿出来交给上层 captureStream，
     *       和别的引擎走的是同一条路。
     *   跨源（游戏是第三方独立部署的）
     *     → 浏览器不让读 contentDocument。真要抓只剩 getDisplayMedia，
     *       那需要玩家点一次并亲手选中标签页 —— 和「玩就是播」的静默前提冲突，
     *       所以这里老实返回 null，上层重试几次拿不到就安静地不开播。
     *
     * **只给画面不给声音**：游戏的 AudioContext 是在 iframe 自己的 realm 里 new 出来的，
     * 想接一根线出来必须赶在它的脚本跑起来**之前**把 AudioContext 构造函数换掉，
     * 而我们拿到 contentWindow 的时候游戏早就在加载了。和 Ruffle 是同一个坑
     * （见 adapters/ruffle.ts 里的长注释），先按静音处理。
     *
     * 纯 DOM/CSS 做的游戏（压根没有 canvas）同样抓不到 —— 这类占比很小，
     * 不值得为它上 html2canvas 那种逐帧重绘的方案。
     */
    focus: () => focusFrame(iframe),
    gamepads: () => frameGamepads(iframe),
    /**
     * 跨源就是永远抓不到，没必要让直播那边再等九秒：加载完之后 contentDocument 读不出来
     * （null 或者直接抛）就是跨源。加载完之前先说「不知道」，别误判。
     */
    captureBlocked(): boolean {
      if (destroyed || !loaded) return false
      try {
        return iframe.contentDocument === null
      } catch {
        return true
      }
    },
    captureSources(): CaptureSources | null {
      if (destroyed) return null
      let doc: Document | null = null
      try {
        doc = iframe.contentDocument
      } catch {
        return null // 跨源
      }
      const canvas = findCanvas(doc)
      return canvas ? { canvas } : null
    },
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
