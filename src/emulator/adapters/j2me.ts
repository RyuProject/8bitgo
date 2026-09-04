/**
 * J2ME 运行时：Java 手机游戏 (.jar)。
 *
 * 用 freej2me-web（FreeJ2ME + CheerpJ）在独立 iframe 里跑。
 * 安装：npm run j2me   （拉取到 public/j2me/，仓库自带预构建 jar，不需要 Docker）
 * 启用：.env 设置 VITE_J2ME_PATH=/j2me/
 *
 * ── 加载契约（读 freej2me-web 的 web/src/main.js 得来，非文档推测）──────
 *
 *   run.html?jar=<文件名>     直接跑 jar，实际取 <J2ME_PATH>jar/<文件名>
 *   run.html?app=<app_id>     跑预打包的存档包，实际取 <J2ME_PATH>apps/<app_id>.zip
 *   run.html?fractionScale=1  只匹配宽高比，不整数倍缩放
 *   run.html?mobile=1         显示虚拟键盘
 *
 * 源码里的关键两行（main.js:328-334）：
 *   if (sp.get('app')) { ... args = ['app', sp.get('app')] }
 *   else { args = ['jar', cheerpjWebRoot + "/jar/" + (sp.get('jar') || "game.jar")] }
 *
 * ⚠️ jar 必须由服务器提供，且位于 <J2ME_PATH>jar/ 下 —— 路径是
 *    cheerpjWebRoot + "/jar/" + 名字 拼出来的，塞完整 URL 或 blob: 都会拼坏。
 *    所以玩家上传的本地 .jar 会先 POST 到后端临时目录，拿到随机文件名后再加载。
 *
 *    临时文件的清理是双保险：
 *      - 切换游戏 / 关闭页面时通知后端删除（pagehide + sendBeacon，尽力而为）
 *      - 后端按 TTL 定时清扫兜底 —— 浏览器崩溃、断网、强杀进程时不会有通知，
 *        只靠前端通知一定会漏，磁盘迟早被占满
 *
 * ⚠️ CheerpJ 从 leaningtech 的 CDN 加载，离线环境跑不了。
 */
import type { Capability, CaptureSources, MountOptions, Runtime, RuntimeHandle } from '../types'
import { getT, fmt } from '@/services/i18n'
import { apiBase, apiEnabled } from '@/services/api'
import { canvasToBlob } from '../recorder'
import { GP, hasGamepadApi, startGamepadBridge, type GamepadBridge } from '../gamepad'
import { assertJar } from '@/lib/romValidation'
import { focusFrame, frameGamepads } from '../frameFocus'

/* ---------------- 从 freej2me-web 源码里挖出来的接入点 ---------------- */

/**
 * 画面：run.html 里那个 id=display 的 canvas，拿的是 2D 上下文
 * （web/src/main.js：`display = document.getElementById('display'); screenCtx = display.getContext('2d')`）。
 * 是 2D 不是 WebGL，所以截图直接 toBlob 就行，录像 captureStream 也能拿到帧。
 */
const DISPLAY_ID = 'display'
/** 轮询 CheerpJ 是否已经把画面亮出来的间隔 */
const J2ME_POLL_MS = 250
/** 兜底放行时间。CheerpJ 冷启动本来就慢，给足两分钟 */
const J2ME_READY_TIMEOUT_MS = 120_000

/**
 * 手柄：iframe 是同源的，而 main.js 把 keydown / keyup 监听挂在 display 上，
 * 里面按 e.code 查 codeMap、按 e.key 算 symbol，再交给它自己的
 * KeyRepeatManager 处理长按重复。所以我们直接给 display 派发合成的
 * KeyboardEvent 就够了 —— 比去戳 window.evtQueue 稳，长按重复也是它自己管。
 *
 * 键位按诺基亚那套来：方向键 + 摇杆，A 是 Enter（确定 / 开火），
 * L1 / R1 是左右软键（F1 / F2），X / Y / START 给数字键。
 */
interface J2meKey {
  code: string
  key: string
}
const J2ME_PAD_MAP: Record<number, J2meKey> = {
  [GP.UP]: { code: 'ArrowUp', key: 'ArrowUp' },
  [GP.DOWN]: { code: 'ArrowDown', key: 'ArrowDown' },
  [GP.LEFT]: { code: 'ArrowLeft', key: 'ArrowLeft' },
  [GP.RIGHT]: { code: 'ArrowRight', key: 'ArrowRight' },
  [GP.A]: { code: 'Enter', key: 'Enter' },
  [GP.B]: { code: 'Digit0', key: '0' },
  [GP.X]: { code: 'Digit1', key: '1' },
  [GP.Y]: { code: 'Digit3', key: '3' },
  [GP.L1]: { code: 'F1', key: 'F1' },
  [GP.R1]: { code: 'F2', key: 'F2' },
  [GP.START]: { code: 'Digit5', key: '5' },
}

interface J2meAudio {
  /** 每个 AudioContext 一个总音量节点 */
  masters: Map<AudioContext, GainNode>
  apply: (volume: number) => void
  /** 录像用：挑一个还活着的总音量节点 */
  primary: () => { node: GainNode; context: AudioContext } | null
}

/**
 * 在 iframe 里插一个总音量节点。
 *
 * FreeJ2ME 的声音有好几路：MIDI 音乐（libmidi 的 MIDIPlayer）、
 * 采样音效（libmedia 的 FFPlayer，走 AudioWorklet）、还有 video 元素。
 * 每一路都自带一个 gainNode 直连 ctx.destination，外面既没有总音量也没法录。
 *
 * 做法是劫持这个 iframe 里的 AudioNode.prototype.connect：谁想连到扬声器
 * （dest 是 AudioDestinationNode），就改成连到我们插在中间的总音量节点上，
 * 由它再连扬声器。这样音量能统一调，录像也有地方接。
 *
 * ⚠️ 这是「改道」不是「旁路」，前提是没人会用 disconnect(某个具体节点) 去断开 ——
 * 断的对象对不上会抛 InvalidAccessError。我翻过 libmidi.js 和 libmedia.js，
 * 两边都只写了不带参数的 node.disconnect() / gainNode.disconnect()，所以是安全的。
 * 补一句：各路播放器都是播放时才现建节点，所以 iframe load 之后再打补丁也来得及。
 */
function installJ2meAudio(win: Window, getVolume: () => number): J2meAudio | null {
  const w = win as unknown as {
    AudioNode?: { prototype: AudioNode }
    AudioDestinationNode?: new () => AudioDestinationNode
  }
  const NodeProto = w.AudioNode?.prototype
  const Destination = w.AudioDestinationNode
  if (!NodeProto || typeof Destination !== 'function') return null

  const masters = new Map<AudioContext, GainNode>()

  const origConnect = NodeProto.connect
  NodeProto.connect = function (this: AudioNode, dest: AudioNode | AudioParam, ...rest: unknown[]) {
    try {
      if (dest instanceof Destination) {
        const ctx = dest.context as AudioContext
        // 离线上下文（OfflineAudioContext）不能碰：它是用来「渲染出一段音频数据」的，
        // 在那里乘一次音量，播放时再乘一次，等于音量被平方了。
        // 而且它没有 createMediaStreamDestination，录像也接不上。
        if (typeof ctx.createMediaStreamDestination !== 'function') {
          return (origConnect as (...a: unknown[]) => unknown).call(this, dest, ...rest) as AudioNode
        }
        let master = masters.get(ctx)
        if (!master) {
          master = ctx.createGain()
          master.gain.value = getVolume()
          ;(origConnect as (...a: unknown[]) => unknown).call(master, dest)
          masters.set(ctx, master)
        }
        return (origConnect as (...a: unknown[]) => unknown).call(this, master, ...rest) as AudioNode
      }
    } catch {
      // 插不进去就原样放行，声音照出，只是没有总音量
    }
    return (origConnect as (...a: unknown[]) => unknown).call(this, dest, ...rest) as AudioNode
  } as AudioNode['connect']

  return {
    masters,
    apply: (volume) => {
      for (const master of masters.values()) {
        try {
          master.gain.value = volume
        } catch {
          /* ignore */
        }
      }
      // video / audio 元素那一路不过 WebAudio，单独设
      const doc = win.document
      for (const el of Array.from(doc.querySelectorAll('video, audio'))) {
        ;(el as HTMLMediaElement).volume = volume
      }
    },
    // 不能记住「第一个见到的」：FreeJ2ME 换曲子时会 close 掉旧的 AudioContext
    // （libmidi 里有 closeContext），录像接在关掉的上下文上只会得到一段空文件。
    // 每次现挑一个还活着的，顺手把关掉的清出去。
    primary: () => {
      for (const [ctx, node] of masters) {
        if (ctx.state === 'closed') {
          masters.delete(ctx)
          continue
        }
        return { node, context: ctx }
      }
      return null
    },
  }
}

export const J2ME_PATH: string = (() => {
  const p = import.meta.env.VITE_J2ME_PATH || ''
  if (!p) return ''
  return p.endsWith('/') ? p : `${p}/`
})()

/** 从 URL / 对象存储 key 里取出文件名 */
function fileNameOf(url: string): string {
  const clean = url.split(/[?#]/)[0]
  return clean.slice(clean.lastIndexOf('/') + 1)
}

/**
 * 拼出 run.html 的地址。
 * .zip 走 app 模式（预打包存档包），其余按 jar 模式。
 */
function buildUrl(name: string): string {
  const base = `${J2ME_PATH}run.html`
  if (name.toLowerCase().endsWith('.zip')) {
    return `${base}?app=${encodeURIComponent(name.replace(/\.zip$/i, ''))}`
  }
  return `${base}?jar=${encodeURIComponent(name)}`
}


/* ---------------- 玩家上传的临时 jar ---------------- */

/** 把本地 jar 传到后端临时目录，返回服务器给的随机文件名 */
async function uploadTempJar(data: ArrayBuffer): Promise<string> {
  const res = await fetch(`${apiBase()}/api/j2me/upload`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/java-archive' },
    body: data,
  })
  const result = (await res.json().catch(() => null)) as { name?: string; error?: string } | null
  if (!res.ok || !result?.name) throw new Error(result?.error || `HTTP ${res.status}`)
  return result.name
}

/** 告诉后端「还在玩」，给临时文件续期 */
function keepaliveTempJar(name: string) {
  void fetch(`${apiBase()}/api/j2me/keepalive`, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain' },
    body: JSON.stringify({ name }),
  }).catch(() => {})
}

/**
 * 通知后端删除临时 jar。
 * 优先用 sendBeacon —— 页面正在关闭时普通 fetch 常常发不出去。
 */
function releaseTempJar(name: string) {
  const url = `${apiBase()}/api/j2me/release`
  const body = JSON.stringify({ name })
  try {
    if (navigator.sendBeacon?.(url, new Blob([body], { type: 'text/plain' }))) return
  } catch {
    /* 退回 fetch */
  }
  void fetch(url, { method: 'POST', body, keepalive: true, headers: { 'Content-Type': 'text/plain' } }).catch(() => {})
}

/** 出错早退时的空句柄：没有任何能力，工具栏整排隐藏 */
function deadHandle(): RuntimeHandle {
  return { destroy: () => {}, caps: new Set<Capability>() }
}

function mount(container: HTMLElement, options: MountOptions): RuntimeHandle {
  const rt = getT().runtime

  if (!J2ME_PATH) {
    options.onError?.(rt.j2meNotConfigured)
    return deadHandle()
  }

  const isFile = typeof options.game !== 'string'
  // 本地文件要先传到后端才能被 freej2me-web 取到，这需要后端存在
  if (isFile && !apiEnabled()) {
    options.onError?.(rt.j2meLocalUnsupported)
    return deadHandle()
  }

  // FreeJ2ME 没有暂停和存档：Java 那边是阻塞在 evtQueue.waitForEvent() 上跑的，
  // 没有对外的暂停接口，存档也归 MIDlet 自己（RMS）管，外面碰不到。
  const caps = new Set<Capability>()
  let volume = 1
  let audio: J2meAudio | null = null
  let pad: GamepadBridge | null = null

  const iframe = document.createElement('iframe')
  iframe.title = fmt(rt.emulatorTitle, { name: options.gameName })
  iframe.style.cssText = 'width:100%;height:100%;border:0;display:block;background:#000'
  iframe.setAttribute('allow', 'fullscreen; gamepad; autoplay; midi')
  // 只认「设过 src 之后」的那次 load。
  // iframe 刚 append 时浏览器会为初始的 about:blank 触发一次 load —— 那时候
  // jar 还没开始上传，却已经把状态改成「运行中」，「正在加载 FreeJ2ME…」的提示
  // 瞬间消失，而 CheerpJ 实际还要几十秒才起得来。销毁时把 src 设回 about:blank
  // 同样会再触发一次，也要挡掉。
  const displayOf = (): HTMLCanvasElement | null =>
    (iframe.contentDocument?.getElementById(DISPLAY_ID) as HTMLCanvasElement | null) ?? null

  /* ---------------- 就绪判定 ---------------- */

  /**
   * ⚠️ iframe 的 load **不是**「可以玩了」。
   *
   * 它只代表 run.html 解析完了，CheerpJ 还要几十秒才把 JVM 和 FreeJ2ME 跑起来。
   * 以前直接在 load 里调 onReady，播放器立刻撤掉加载遮罩，露出来的是 CheerpJ
   * 自己那个带文字的加载框 —— 既让玩家对着不能玩的画面乱按，也破坏了
   * 「所有模拟器统一只显示一条进度条」。
   *
   * 就绪信号是从 freej2me-web 源码里确认的，不是猜的：
   *   run.html:190    <canvas tabindex="0" id="display" style="display: none;"></canvas>
   *   src/main.js:269 setCanvasSize() 里，MIDlet 第一次报画面尺寸时才执行：
   *                     document.getElementById('loading').hidden = true
   *                     display.style.display = ''
   * 也就是说 #display 从隐藏变可见 == 游戏开始出画面；而且同一时刻 CheerpJ
   * 那个带文字的加载框被藏起来 —— 遮罩接在这一刻撤，正好无缝。
   *
   * 跨源读不到（有人把 VITE_J2ME_PATH 指到别的域名）就退回老行为，
   * 再加超时兜底，免得 CheerpJ 挂了让玩家永远卡在遮罩后面。
   */
  let poll: ReturnType<typeof setInterval> | null = null
  let readySent = false
  /** 起不来的兜底计时器，销毁时要收掉 */
  let readyTimer = 0

  const stopPoll = () => {
    if (poll) {
      clearInterval(poll)
      poll = null
    }
  }
  const sendReady = () => {
    stopPoll()
    if (readySent || destroyed) return
    readySent = true
    options.onReady?.()
  }

  /** true=画面已亮起 false=还没 null=跨源读不到 */
  const displayShown = (): boolean | null => {
    try {
      const doc = iframe.contentDocument
      if (!doc) return false // 文档还没建好，下一轮再看
      const el = doc.getElementById(DISPLAY_ID) as HTMLElement | null
      // 标签一直都在（静态写在 run.html 里），关键看它还是不是 display:none
      return el ? el.style.display !== 'none' : false
    } catch {
      return null // 跨源
    }
  }

  let srcSet = false
  iframe.addEventListener('load', () => {
    if (!srcSet || destroyed) return

    if (displayShown() === null) {
      sendReady() // 跨源，读不到内部状态，退回老行为
    } else {
      stopPoll()
      poll = setInterval(() => {
        if (destroyed) return stopPoll()
        const shown = displayShown()
        if (shown === null || shown === true) sendReady()
        else options.onProgress?.({ phase: 'engine' })
      }, J2ME_POLL_MS)
      /**
       * 两分钟还没亮画面 = 起不来了，**不能**当成「可以玩了」。
       * 以前这里 sendReady()：遮罩撤掉、状态变「运行中」、还记了一次游玩，玩家对着黑屏
       * 完全不知道发生了什么，而且 ready 之后播放器那次自动重试的机会也一并作废。
       * CheerpJ 是第三方 CDN，连不上是常事（公司网络、国内网络），报出来才有得救。
       */
      readyTimer = window.setTimeout(() => {
        if (destroyed || readySent) return
        stopPoll()
        options.onError?.(rt.j2meStartTimeout)
      }, J2ME_READY_TIMEOUT_MS)
    }

    const win = iframe.contentWindow
    if (!win) return
    audio = installJ2meAudio(win, () => volume)
    if (audio) caps.add('volume')
    // 画面是普通 2D canvas，截图和录像都没有 WebGL 那些麻烦
    caps.add('screenshot')
    caps.add('record')
    if (hasGamepadApi()) {
      caps.add('gamepad')
      pad = startGamepadBridge<J2meKey>(
        J2ME_PAD_MAP,
        (k, pressed) => {
          const display = displayOf()
          if (!display) return
          const win2 = iframe.contentWindow as (Window & { KeyboardEvent?: typeof KeyboardEvent }) | null
          const Ctor = win2?.KeyboardEvent ?? KeyboardEvent
          display.dispatchEvent(new Ctor(pressed ? 'keydown' : 'keyup', { code: k.code, key: k.key, bubbles: true }))
        },
        {
          /**
           * 从**拿着焦点的那个文档**读手柄。
           *
           * 这里的焦点是我们自己交进 iframe 的（下面 focus: () => focusFrame(iframe)，
           * 而且插手柄时播放器还会再交一次），此后父页面 navigator.getGamepads() 读到的
           * 全是 null —— 桥每帧都判定「手柄拔了」，玩家插着手柄却一个键都不生效，
           * 工具栏的手柄面板也报「没检测到」。iframe 同源，直接问它。
           */
          getPads: () => {
            try {
              const nav = iframe.contentWindow?.navigator
              const inner = nav?.getGamepads ? Array.from(nav.getGamepads()) : []
              if (inner.some(Boolean)) return inner
            } catch {
              /* 跨源就退回父页面 */
            }
            return navigator.getGamepads ? Array.from(navigator.getGamepads()) : []
          },
        },
      )
    }
    options.onCaps?.(caps)
  })
  iframe.addEventListener('error', () => {
    if (!destroyed) options.onError?.(fmt(rt.j2meLoadFailed, { path: J2ME_PATH }))
  })
  container.appendChild(iframe)

  let destroyed = false
  /** 本次上传的临时文件名，销毁时要通知后端删掉 */
  let tempName: string | null = null
  /** 心跳：玩的时间超过服务端 TTL 时，防止文件被清扫掉 */
  let heartbeat: ReturnType<typeof setInterval> | null = null

  // 页面关闭时也要删：unmount 在这种情况下不会执行。
  // 但 pagehide 也会在页面进 bfcache 时触发（手机上切个 App、点外链再返回），
  // 那种情况页面稍后还会复活、游戏还在跑，删了就变成 404「临时文件已过期」。
  // event.persisted 为 true 就是进 bfcache，不能删。
  const onPageHide = (e: PageTransitionEvent) => {
    if (e.persisted) return
    if (tempName) releaseTempJar(tempName)
  }
  window.addEventListener('pagehide', onPageHide)

  void (async () => {
    try {
      let name: string
      if (isFile) {
        // 本地 jar 要先传到后端才能被 freej2me-web 取到。fetch 拿不到上传进度
        // （只有 XHR 的 upload.onprogress 有），所以这里只报阶段，UI 转不确定态。
        options.onProgress?.({ phase: 'rom' })
        const data = await (options.game as File).arrayBuffer()
        options.onProgress?.({ phase: 'rom', loaded: data.byteLength, total: data.byteLength, ratio: 1 })
        // 后端还会独立再验一次；前端先验是为了不上传明显损坏的包，也能立刻给玩家准确提示。
        assertJar(data)
        name = await uploadTempJar(data)
        if (destroyed) {
          // 上传期间已经被卸载了，直接把刚传上去的删掉
          releaseTempJar(name)
          return
        }
        tempName = name
        // 每 2 分钟续一次期。服务端默认 TTL 30 分钟，留足余量。
        heartbeat = setInterval(() => {
          if (tempName) keepaliveTempJar(tempName)
        }, 120_000)
      } else {
        name = fileNameOf(options.game as string)
      }
      srcSet = true
      options.onProgress?.({ phase: 'engine' })
      iframe.src = buildUrl(name)
      options.onStart?.()
    } catch (e) {
      if (destroyed) return
      const msg = e instanceof Error ? e.message : String(e)
      options.onError?.(fmt(rt.j2meUploadFailed, { msg }))
    }
  })()

  const destroy = () => {
    destroyed = true
    window.clearTimeout(readyTimer)
    stopPoll()
    pad?.stop()
    pad = null
    audio = null
    window.removeEventListener('pagehide', onPageHide)
    if (heartbeat) clearInterval(heartbeat)
    if (tempName) {
      releaseTempJar(tempName)
      tempName = null
    }
    try {
      iframe.src = 'about:blank'
    } catch {
      /* ignore */
    }
    iframe.remove()
  }

  return {
    caps,
    destroy,
    volume,
    /*
      物理手柄这一路会从拿着焦点的那个文档读（见上面 startGamepadBridge 的 getPads），
      所以交焦点不会把它读没。键盘更是要靠它：
      FreeJ2ME 的按键监听挂在 iframe 内部。
    */
    focus: () => focusFrame(iframe),
    // 手柄面板要报「检测到哪些手柄」，同样得问 iframe 那个文档
    gamepads: () => frameGamepads(iframe),
    setVolume(next: number) {
      volume = Math.max(0, Math.min(1, next))
      audio?.apply(volume)
    },
    async screenshot() {
      const display = displayOf()
      return display ? await canvasToBlob(display) : null
    },
    captureSources(): CaptureSources | null {
      const display = displayOf()
      if (!display) return null
      const src = audio?.primary()
      return { canvas: display, audioNode: src?.node ?? null, audioContext: src?.context ?? null }
    },
  }
}

export const j2meRuntime: Runtime = {
  id: 'j2me',
  name: 'FreeJ2ME',
  get description() {
    return getT().runtime.j2meDesc
  },
  extensions: ['jar', 'jad'],
  priority: 10,
  // 没装 / 没配置就当作不存在，解析阶段直接跳过
  available: () => Boolean(J2ME_PATH),
  supports: (platform) => platform === 'java',
  engineLabel: () => 'FreeJ2ME',
  mount,
}
