/**
 * Ruffle 运行时：Flash（.swf）。
 *
 * Ruffle 是用 Rust 编写、编译为 WebAssembly 的开源 Flash 播放器（MIT / Apache-2.0）。
 * 同样放进独立 iframe 里运行，便于销毁与隔离。
 *
 * 资源路径：默认 /ruffle/（由 scripts/copy-ruffle.mjs 从 npm 包复制到 public/ruffle/），
 * 也可设置 VITE_RUFFLE_PATH 指向 CDN，例如 https://unpkg.com/@ruffle-rs/ruffle/
 */
import type { Capability, MountOptions, Runtime, RuntimeHandle } from '../types'
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

/**
 * Ruffle 的播放器接口。
 *
 * 注意这里有两套命名并存：老的门面叫 play() / pause()，
 * 新的 PlayerV1 门面叫 resume() / suspend()（对应的只读属性也从 isPlaying 变成 suspended）。
 * 发行包里两套都可能拿到，所以全部写成可选，调用时挨个试。
 */
interface RufflePlayerApi {
  load: (options: Record<string, unknown>) => Promise<void> | void
  play?: () => void
  resume?: () => void
  pause?: () => void
  suspend?: () => void
  isPlaying?: boolean
  volume?: number
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

function mount(container: HTMLElement, options: MountOptions): RuntimeHandle {
  const rt = getT().runtime
  /** 加载成功后才知道能不能暂停 / 调音量，先空着，等 load() 回来再报 */
  const caps = new Set<Capability>()
  /** 播放器元素与它的 API 门面（两者都可能带 volume / pause） */
  let player: RufflePlayerElement | null = null
  let api: RufflePlayerApi | null = null
  let volume = 1

  /** 元素和门面上都可能有这些成员，挨个找第一个有的 */
  const canPause = (): boolean =>
    [api, player].some((x) => x && (typeof x.pause === 'function' || typeof x.suspend === 'function'))
  const hasVolume = (): boolean => [api, player].some((x) => x && typeof x.volume === 'number')
  const applyVolume = () => {
    for (const target of [api, player]) {
      if (!target || typeof target.volume !== 'number') continue
      try {
        target.volume = volume
      } catch {
        /* 换下一个门面 */
      }
    }
  }

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
        player = source.createPlayer()
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

        api = typeof player.ruffle === 'function' ? player.ruffle() : typeof player.load === 'function' ? (player as RufflePlayerApi) : null
        if (!api) throw new Error(rt.ruffleNoApi)
        // 上面一连串 await（等自定义元素注册、读文件）之间玩家可能已经换了 ROM，
        // 这里要重新确认一次，别把旧会话的结果算到新会话头上
        if (destroyed) return
        options.onReady?.()
        await api.load(loadOptions)
        if (destroyed) return

        // 能力要等实例真的建起来才作数：SWF 加载之前 volume 的 setter 是空转的
        if (canPause()) caps.add('pause')
        if (hasVolume()) {
          caps.add('volume')
          applyVolume()
        }
        options.onCaps?.(caps)
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
  options.onCaps?.(caps)

  return {
    caps,
    volume,
    setPaused(next: boolean) {
      // 两套门面轮流试：老的 play/pause，新的 resume/suspend
      for (const target of [api, player]) {
        if (!target) continue
        try {
          const fn = next ? (target.pause ?? target.suspend) : (target.play ?? target.resume)
          if (typeof fn === 'function') {
            fn.call(target)
            return
          }
        } catch {
          /* 换下一个门面 */
        }
      }
    },
    setVolume(next: number) {
      volume = Math.max(0, Math.min(1, next))
      applyVolume()
    },
    destroy() {
      destroyed = true
      player = null
      api = null
      try {
        iframe.srcdoc = ''
        iframe.src = 'about:blank'
      } catch {
        /* ignore */
      }
      iframe.remove()
    },
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
