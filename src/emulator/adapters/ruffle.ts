/**
 * Ruffle 运行时：Flash（.swf）。
 *
 * Ruffle 是用 Rust 编写、编译为 WebAssembly 的开源 Flash 播放器（MIT / Apache-2.0）。
 * 同样放进独立 iframe 里运行，便于销毁与隔离。
 *
 * 资源路径：默认 /ruffle/（由 scripts/copy-ruffle.mjs 从 npm 包复制到 public/ruffle/），
 * 也可设置 VITE_RUFFLE_PATH 指向 CDN，例如 https://unpkg.com/@ruffle-rs/ruffle/
 */
import type { MountOptions, Runtime } from '../types'
import { getT, fmt } from '@/services/i18n'

export const RUFFLE_PATH: string = (() => {
  const p = import.meta.env.VITE_RUFFLE_PATH || '/ruffle/'
  return p.endsWith('/') ? p : `${p}/`
})()

const FRAME_HTML = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
  html, body { margin: 0; height: 100%; background: #0b0b0f; overflow: hidden; }
  #host { width: 100%; height: 100%; }
  #host > * { width: 100%; height: 100%; display: block; }
</style>
</head>
<body><div id="host"></div></body>
</html>`

interface RufflePlayerApi {
  load: (options: Record<string, unknown>) => Promise<void> | void
}
/** 新版通过 player.ruffle() 取 API，旧版直接在元素上调用 load() */
interface RufflePlayerElement extends HTMLElement, Partial<RufflePlayerApi> {
  ruffle?: () => RufflePlayerApi
}
interface RuffleSource {
  createPlayer: () => RufflePlayerElement
}
interface RuffleGlobal {
  newest: () => RuffleSource | null
}

function mount(container: HTMLElement, options: MountOptions): () => void {
  const rt = getT().runtime
  const iframe = document.createElement('iframe')
  iframe.title = fmt(rt.flashTitle, { name: options.gameName })
  iframe.style.cssText = 'width:100%;height:100%;border:0;display:block;background:#0b0b0f'
  iframe.setAttribute('allow', 'fullscreen; autoplay; clipboard-write')
  iframe.srcdoc = FRAME_HTML

  let destroyed = false

  iframe.addEventListener('load', () => {
    if (destroyed) return
    const win = iframe.contentWindow as (Window & { RufflePlayer?: RuffleGlobal }) | null
    const doc = iframe.contentDocument
    if (!win || !doc) {
      options.onError?.(rt.flashInitFailed)
      return
    }

    const script = doc.createElement('script')
    script.src = `${RUFFLE_PATH}ruffle.js`
    script.onerror = () => {
      if (!destroyed) options.onError?.(fmt(rt.ruffleLoadFailed, { path: RUFFLE_PATH }))
    }
    script.onload = async () => {
      if (destroyed) return
      try {
        const source = win.RufflePlayer?.newest()
        if (!source) throw new Error(rt.ruffleNotInit)
        let player = source.createPlayer()
        const host = doc.getElementById('host')
        host?.appendChild(player)
        // ruffle.js 只是加载器，核心与自定义元素是按需异步注册的，需等元素升级完成
        await win.customElements.whenDefined(player.tagName.toLowerCase())
        // 极少数情况下（例如浏览器 locale 异常导致构造函数抛错）元素不会被升级，重建一次
        if (typeof player.ruffle !== 'function' && typeof player.load !== 'function') {
          player.remove()
          player = source.createPlayer()
          host?.appendChild(player)
        }

        const base = {
          autoplay: 'on',
          unmuteOverlay: 'visible',
          letterbox: 'on',
          backgroundColor: '#0b0b0f',
          splashScreen: false,
          warnOnUnsupportedContent: false,
          publicPath: RUFFLE_PATH,
        }
        const isFile = typeof options.game !== 'string'
        const loadOptions = isFile
          ? { ...base, data: await (options.game as File).arrayBuffer(), swfFileName: (options.game as File).name }
          : { ...base, url: options.game as string }

        const api: RufflePlayerApi | undefined = typeof player.ruffle === 'function' ? player.ruffle() : typeof player.load === 'function' ? (player as RufflePlayerApi) : undefined
        if (!api) throw new Error(rt.ruffleNoApi)
        // 上面一连串 await（等自定义元素注册、读文件）之间玩家可能已经换了 ROM，
        // 这里要重新确认一次，别把旧会话的结果算到新会话头上
        if (destroyed) return
        options.onReady?.()
        await api.load(loadOptions)
        if (destroyed) return
        options.onStart?.()
      } catch (err) {
        // 销毁之后的报错不再上报：否则玩家刚拖进来的新游戏会被上一个的错误顶掉，
        // 画面消失、只剩一条红色提示，而新的模拟器其实还在后台出声
        if (destroyed) return
        options.onError?.(fmt(rt.flashLoadFailed, { msg: err instanceof Error ? err.message : String(err) }))
      }
    }
    doc.head.appendChild(script)
  })

  container.appendChild(iframe)

  return () => {
    destroyed = true
    try {
      iframe.srcdoc = ''
      iframe.src = 'about:blank'
    } catch {
      /* ignore */
    }
    iframe.remove()
  }
}

export const ruffleRuntime: Runtime = {
  id: 'ruffle',
  name: 'Ruffle',
  get description() {
    return getT().runtime.ruffleDesc
  },
  extensions: ['swf'],
  priority: 20,
  available: () => true,
  supports: (platform) => platform === 'flash',
  engineLabel: () => 'swf',
  mount,
}
