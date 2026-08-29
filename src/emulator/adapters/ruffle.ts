/**
 * Ruffle 运行时：Flash（.swf）。
 *
 * Ruffle 是用 Rust 编写、编译为 WebAssembly 的开源 Flash 播放器（MIT / Apache-2.0）。
 * 同样放进独立 iframe 里运行，便于销毁与隔离。
 *
 * 资源路径：默认 /ruffle/（由 scripts/copy-ruffle.mjs 从 npm 包复制到 public/ruffle/），
 * 也可设置 VITE_RUFFLE_PATH 指向 CDN，例如 https://unpkg.com/@ruffle-rs/ruffle/
 */
import type { CaptureSources, Capability, MountOptions, Runtime, RuntimeHandle } from '../types'
import { loadGameBytes } from '../romLoader'
import { assertSwf } from '@/lib/romValidation'
import { canvasToBlob } from '../recorder'
import { getT, fmt } from '@/services/i18n'

export const RUFFLE_PATH: string = (() => {
  const p = import.meta.env.VITE_RUFFLE_PATH || '/ruffle/'
  return p.endsWith('/') ? p : `${p}/`
})()

/* ---------------- 设备字体（中文不显示的根因）---------------- */

/**
 * Flash 里的文字分两种：**嵌入字体**（字形打包在 SWF 里）和**设备字体**
 * （只写一个字体名，播放时用系统里的字）。当年的中文 Flash 几乎都用设备字体 ——
 * 一套中文字库上万个字形，嵌进去 SWF 会大到没法在拨号网络上传播。
 *
 * Ruffle 的 deviceFontRenderer 默认是 'embedded'，它自己的说明写得很清楚：
 *   "It cannot access device fonts and uses fonts provided in the configuration
 *    and the default Noto Sans font as a fallback."
 * Noto Sans 是纯拉丁字库，**一个汉字都没有** —— 所以中文菜单直接渲染成空白，
 * 而标题那种做成图形/嵌入字体的反而正常。这就是「网页版文字不见了」的全部原因。
 *
 * 换成 'canvas' 之后，Ruffle 用一块离屏画布走浏览器的字体栈来画字，
 * 系统里有的中文字就能出来。官方标它为 experimental（字形按位图渲染，
 * 极端缩放 / 旋转下可能不如矢量锐利），但对「有字」和「没字」来说这个代价很划算。
 *
 * 想退回官方默认：VITE_RUFFLE_FONT_RENDERER=embedded
 */
const FONT_RENDERER: string = import.meta.env.VITE_RUFFLE_FONT_RENDERER || 'canvas'

/**
 * 可选：自带字体，不靠访客机器上有没有中文字库。
 *
 * Ruffle 的 fontSources 只认 **SWF**（官方原话 "Currently only SWFs are supported"），
 * 里面嵌的每个字体都会被当作设备字体。所以要用的话得先把 ttf 打成一个字体 SWF。
 * 代价是体积：一套中文字库动辄几 MB，除非做子集化，否则每个 Flash 游戏都要先下这一坨。
 *
 *   VITE_RUFFLE_FONT_SOURCES=/ruffle/fonts/noto-sans-sc.swf
 *   VITE_RUFFLE_FONT_SANS=Noto Sans SC
 *
 * 配了 FONT_SOURCES 就说明是想要确定性的排版，这时默认切回 'embedded' 渲染器
 * （矢量、跨机器一致），除非显式指定了 VITE_RUFFLE_FONT_RENDERER。
 */
const FONT_SOURCES: string[] = (import.meta.env.VITE_RUFFLE_FONT_SOURCES || '')
  .split(',')
  .map((u: string) => u.trim())
  .filter(Boolean)

const FONT_SANS: string = import.meta.env.VITE_RUFFLE_FONT_SANS || ''

/** 拼出这次加载要用的字体相关配置 */
function fontConfig(): Record<string, unknown> {
  const renderer = import.meta.env.VITE_RUFFLE_FONT_RENDERER || (FONT_SOURCES.length ? 'embedded' : FONT_RENDERER)
  const cfg: Record<string, unknown> = { deviceFontRenderer: renderer }
  if (FONT_SOURCES.length) {
    cfg.fontSources = FONT_SOURCES
    if (FONT_SANS) {
      const names = FONT_SANS.split(',').map((n) => n.trim()).filter(Boolean)
      // _sans / _serif / _等幅 都指向同一套中文字体：中文 Flash 基本只用 _sans，
      // 但偶尔有写 _serif 的，与其让它掉回没有汉字的 Noto Sans，不如都指过去
      cfg.defaultFonts = { sans: names, serif: names, typewriter: names, japaneseGothic: names }
    }
  }
  return cfg
}

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

/**
 * 等一个 <video> 真的拿到一帧。
 *
 * captureStream 出来的流挂到 video 上之后，videoWidth 要等第一帧解码完才有值，
 * 这之前 drawImage 画出来是空的。有 requestVideoFrameCallback 就用它（最准），
 * 没有就退回 loadeddata + 一小段安置时间。无论如何 1.5 秒后放行 —— 截图不能卡死。
 */
function waitForFrame(video: HTMLVideoElement): Promise<void> {
  return new Promise((resolve) => {
    let done = false
    const finish = () => {
      if (done) return
      done = true
      window.clearTimeout(timer)
      resolve()
    }
    const timer = window.setTimeout(finish, 1500)
    const rvfc = (video as HTMLVideoElement & { requestVideoFrameCallback?: (cb: () => void) => number })
      .requestVideoFrameCallback
    if (typeof rvfc === 'function') rvfc.call(video, finish)
    else video.addEventListener('loadeddata', () => window.setTimeout(finish, 120), { once: true })
  })
}

function mount(container: HTMLElement, options: MountOptions): RuntimeHandle {
  const rt = getT().runtime
  /** 加载成功后才知道能不能暂停 / 调音量，先空着，等 load() 回来再报 */
  const caps = new Set<Capability>()
  /** 播放器元素与它的 API 门面（两者都可能带 volume / pause） */
  let player: RufflePlayerElement | null = null
  let api: RufflePlayerApi | null = null
  let volume = 1

  /**
   * 取 Ruffle 的画布。
   *
   * ⚠️ 它在 <ruffle-player> 的 **shadow DOM** 里（Ruffle 内部 attachShadow({mode:'open'})，
   *    画布挂在 shadow 里的 #container 上），所以 iframe.contentDocument.querySelector('canvas')
   *    **永远返回 null** —— 这条路我实测过，走不通。必须从 player.shadowRoot 找。
   *    srcdoc iframe 继承父页面的源，加上 shadow 是 open 模式，所以这里拿得到。
   *
   * 每次现查、不缓存：读档会调 player.reload()，画布会被换掉。
   */
  const stageCanvas = (): HTMLCanvasElement | null => {
    try {
      return player?.shadowRoot?.querySelector('canvas') ?? null
    } catch {
      return null
    }
  }

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
          // 中文 / 日文这类设备字体文本要靠它才画得出来，见文件顶部的说明
          ...fontConfig(),
        }
        const isFile = typeof options.game !== 'string'
        let loadOptions: Record<string, unknown>
        if (isFile) {
          const loaded = await loadGameBytes(options.game, options.onProgress)
          assertSwf(loaded.data)
          loadOptions = { ...base, data: loaded.data, swfFileName: loaded.name }
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
          const loaded = await loadGameBytes(url, options.onProgress)
          assertSwf(loaded.data)
          loadOptions = {
            ...base,
            data: loaded.data,
            swfFileName: loaded.name,
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
        // 录像 / 开播 / 截图都靠画布，画布是在 load() 完成的那一刻出现的（实测），
        // 所以在这儿判断刚好，早一步查是 null
        if (stageCanvas()) {
          caps.add('record')
          caps.add('screenshot')
        }
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
    captureSources(): CaptureSources | null {
      const canvas = stageCanvas()
      if (!canvas) return null
      /**
       * 只给画面，不给声音。
       *
       * Ruffle 的音频跑在它自己 new 出来的 AudioContext 里，没有任何公开接口把
       * AudioNode 交出来，所以录出来的视频和推出去的直播都是**静音**的。
       *
       * 要声音只有一条路（我实测过是通的）：在 ruffle.js 加载**之前**把 iframe 里的
       * AudioContext 构造函数和 AudioNode.prototype.connect 换掉，凡是接到 destination
       * 的节点顺手再接一份到我们自己的 GainNode 上，再把这个 Gain 当 audioNode 交出去。
       * 但那是在替换所有 Flash 游戏的公共音频通路，patch 一旦有闪失就是全站 Flash 没声音，
       * 比「直播没声音」严重得多，所以先不动。
       */
      return { canvas }
    },
    async screenshot() {
      const canvas = stageCanvas()
      if (!canvas || typeof canvas.captureStream !== 'function') return null
      /**
       * 为什么不直接 canvas.toBlob()：
       * Ruffle 用 WebGL 渲染且没开 preserveDrawingBuffer，绘制之外的时刻读回来是
       * **全透明**的 —— 实测 toDataURL / drawImage 拿到的中心像素是 rgba(0,0,0,0)，
       * 放在 requestAnimationFrame 里读也一样。
       * 绕一圈走 captureStream：合成器交出来的帧是有内容的（实测像素与 SWF 舞台底色一致），
       * 落到一个隐藏 <video> 上再画一次就拿到真画面。代价是多等一帧。
       */
      let stream: MediaStream | null = null
      const video = document.createElement('video')
      try {
        stream = canvas.captureStream()
        video.muted = true
        video.playsInline = true
        video.srcObject = stream
        video.style.cssText = 'position:fixed;left:-9999px;top:0;width:1px;height:1px;opacity:0;pointer-events:none'
        document.body.appendChild(video)
        await video.play().catch(() => {})
        await waitForFrame(video)
        if (!video.videoWidth) return null
        const out = document.createElement('canvas')
        out.width = video.videoWidth
        out.height = video.videoHeight
        const ctx = out.getContext('2d')
        if (!ctx) return null
        ctx.drawImage(video, 0, 0)
        return await canvasToBlob(out)
      } catch {
        return null
      } finally {
        stream?.getTracks().forEach((t) => t.stop())
        video.srcObject = null
        video.remove()
      }
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
