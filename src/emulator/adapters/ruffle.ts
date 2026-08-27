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
import { fetchWithProgress } from '../loadProgress'
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

/* ---------------- Flash 存档（SharedObject）---------------- */

/**
 * Flash 游戏的「存档」不是模拟器快照，而是游戏自己通过 SharedObject 写下的进度
 * （当年俗称 Flash cookie）。Ruffle 把它落在 localStorage 里，一条一个键。
 *
 * ⚠️ 我们的 iframe 是 srcdoc，srcdoc 继承父页面的源，所以这些存档其实就写在
 *    8bitgo 自己的 localStorage 里 —— 也就是说存档**本来就在生效**，
 *    玩家关掉页面下次再来进度还在。这里补的是导出 / 导入的口子。
 *
 * 判定一条 localStorage 是不是 Flash 存档，用的是 SOL 文件头（和 Ruffle 自己
 * 的判定完全一致，见 ruffle.js 里的那个 base64 校验函数）：
 *   00 BF <4 字节长度> "TCSO" 00 04 00 00 00 00
 * 按内容认而不是按键名认，所以不会误伤本站自己的 localStorage 键。
 */
function isSolBase64(value: string): boolean {
  try {
    const raw = atob(value)
    return (
      raw.charCodeAt(0) === 0 &&
      raw.charCodeAt(1) === 0xbf &&
      raw.slice(6, 10) === 'TCSO' &&
      [0, 4, 0, 0, 0, 0].every((b, i) => raw.charCodeAt(10 + i) === b)
    )
  } catch {
    return false
  }
}

/** 导出文件的格式标记，导入时要认 */
const FLASH_SAVE_FORMAT = '8bitgo-flash-save'

interface FlashSaveFile {
  format: string
  version: number
  game?: string
  savedAt?: string
  /** localStorage 键 -> base64 的 SOL 内容 */
  entries: Record<string, string>
}

/**
 * 找出属于这个 SWF 的存档键。
 *
 * Ruffle 的键长这样：`<域名>/<swf 路径的各段>/<存档名>`。它自己在删除/替换存档时
 * 也是这么核对归属的：键要以域名开头，且中间那段路径要能在 swf 的 pathname 里找到。
 * 这里照抄同一套规则，免得把别的 Flash 游戏的存档一起打包走。
 *
 * 本地文件（走 data 加载）没有 swf URL，Ruffle 那边会退回页面域名，
 * 我们也只能按域名筛 —— 会把同域下别的 Flash 存档带上，所以只在拿不到 URL 时用。
 */
function flashSaveKeys(swfUrl: URL | null): string[] {
  const host = swfUrl?.hostname || location.hostname
  const keys: string[] = []
  let store: Storage
  try {
    store = localStorage
  } catch {
    return keys // 隐私模式下读不到就算了
  }
  for (let i = 0; i < store.length; i++) {
    const key = store.key(i)
    if (!key || !key.startsWith(host)) continue
    const value = store.getItem(key)
    if (!value || !isSolBase64(value)) continue
    if (swfUrl) {
      const middle = key.split('/').slice(1, -1).join('/')
      // middle 为空说明这条键是「域名/槽名」两段式（存在站点根目录的 SOL）。
      // 空串的话 includes('') 恒为真，会把同域下**所有**游戏的存档都算进来，
      // 导出一个游戏的存档能把别的游戏一起带走。宁可漏掉这种也不能多带。
      if (!middle || !swfUrl.pathname.includes(middle)) continue
    }
    keys.push(key)
  }
  return keys
}

function mount(container: HTMLElement, options: MountOptions): RuntimeHandle {
  const rt = getT().runtime
  /** 加载成功后才知道能不能暂停 / 调音量，先空着，等 load() 回来再报 */
  const caps = new Set<Capability>()
  /** 播放器元素与它的 API 门面（两者都可能带 volume / pause） */
  let player: RufflePlayerElement | null = null
  let api: RufflePlayerApi | null = null
  let volume = 1

  /** 远程 ROM 才有 URL；本地文件走 data 加载，拿不到 */
  const swfUrl: URL | null = (() => {
    if (typeof options.game !== 'string') return null
    try {
      return new URL(options.game, location.href)
    } catch {
      return null
    }
  })()

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
          /**
           * ⚠️ 千万别在这里填颜色。
           *
           * Ruffle 的 backgroundColor **不是**「没有背景色时的兜底」，而是**强行覆盖**
           * SWF 自己的舞台背景色（官方文档原话：specify a color … it will override the
           * SWF file's native background color；默认 null 才是用 SWF 自己的）。
           * 以前这里填了 #0b0b0f，于是每一个 Flash 游戏的舞台底色都被涂成近黑 ——
           * 当年大量 Flash 游戏是「白底 + 黑线稿」或者靠舞台底色当背景画的，
           * 一涂就变成整片黑屏，看起来像模拟器没跑起来。
           *
           * 播放器周围留白的深色由 iframe 和 #host 的 CSS 负责，和这里无关。
           */
          backgroundColor: null,
          splashScreen: false,
          warnOnUnsupportedContent: false,
          publicPath: RUFFLE_PATH,
        }
        const isFile = typeof options.game !== 'string'
        let loadOptions: Record<string, unknown>
        if (isFile) {
          const data = await (options.game as File).arrayBuffer()
          options.onProgress?.({ phase: 'rom', loaded: data.byteLength, total: data.byteLength, ratio: 1 })
          loadOptions = { ...base, data, swfFileName: (options.game as File).name }
        } else {
          /**
           * 远程 SWF 自己下，而不是把 url 丢给 Ruffle —— 这样才拿得到真实的下载字节数。
           *
           * 代价是 Ruffle 不再知道这个 SWF 是从哪来的，而当年不少 Flash 游戏会用
           * loadMovie / XML 之类去取同目录的外部素材，相对路径会从「SWF 所在目录」
           * 变成「当前页面」，素材全 404。所以必须显式把 base 设回 SWF 的目录 ——
           * base 是 Ruffle 的正式配置项（DEFAULT_CONFIG 里 base:null），给了 url 时
           * 它本来也是这么推的，这里只是把同一件事写明白。
           */
          const url = options.game as string
          const data = await fetchWithProgress(url, { phase: 'rom', onProgress: options.onProgress })
          loadOptions = {
            ...base,
            data,
            swfFileName: url.split(/[?#]/)[0].split('/').pop() || 'game.swf',
            base: new URL('.', new URL(url, location.href)).href,
          }
        }

        api = typeof player.ruffle === 'function' ? player.ruffle() : typeof player.load === 'function' ? (player as RufflePlayerApi) : null
        if (!api) throw new Error(rt.ruffleNoApi)
        // 上面一连串 await（等自定义元素注册、读文件）之间玩家可能已经换了 ROM，
        // 这里要重新确认一次，别把旧会话的结果算到新会话头上
        if (destroyed) return
        options.onProgress?.({ phase: 'starting', ratio: 1 })
        await api.load(loadOptions)
        if (destroyed) return
        // onReady 必须在 load 完成之后 —— 以前放在 load 之前，播放器会在 SWF 还没解析完
        // 就把加载遮罩撤掉，玩家对着空白舞台点半天
        options.onReady?.()

        // 能力要等实例真的建起来才作数：SWF 加载之前 volume 的 setter 是空转的
        if (canPause()) caps.add('pause')
        // 存档能力恒定有：导出时再看有没有内容
        caps.add('saveState')
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
    saveExt: 'flashsave.json',
    async saveState() {
      const keys = flashSaveKeys(swfUrl)
      if (!keys.length) throw new Error(rt.flashNoSave)
      const entries: Record<string, string> = {}
      for (const key of keys) {
        const value = localStorage.getItem(key)
        if (value) entries[key] = value
      }
      // 带上键名一起导出：SOL 文件本身不含「它属于哪个存档槽」这个信息，
      // 只导出裸 .sol 的话，导入时没有已存在的存档就无从下手
      const file: FlashSaveFile = {
        format: FLASH_SAVE_FORMAT,
        version: 1,
        game: options.gameName,
        savedAt: new Date().toISOString(),
        entries,
      }
      return new Blob([JSON.stringify(file, null, 2)], { type: 'application/json' })
    },
    async loadState(data: ArrayBuffer) {
      let file: FlashSaveFile
      try {
        file = JSON.parse(new TextDecoder().decode(data)) as FlashSaveFile
      } catch {
        throw new Error(rt.flashSaveBad)
      }
      if (file?.format !== FLASH_SAVE_FORMAT || !file.entries) throw new Error(rt.flashSaveBad)
      let written = 0
      for (const [key, value] of Object.entries(file.entries)) {
        // 再校验一遍：别把任意内容塞进 localStorage
        if (typeof value !== 'string' || !isSolBase64(value)) continue
        localStorage.setItem(key, value)
        written++
      }
      if (!written) throw new Error(rt.flashSaveBad)
      // SWF 是在启动时读 SharedObject 的，写完必须重载一次才生效 ——
      // Ruffle 自带的存档管理器替换存档时也是这么做的（destroy + reload）
      for (const target of [api, player] as (RufflePlayerApi | RufflePlayerElement | null)[]) {
        const reload = (target as { reload?: () => Promise<void> } | null)?.reload
        if (typeof reload === 'function') {
          await reload.call(target)
          break
        }
      }
      return rt.flashSaveImported
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
