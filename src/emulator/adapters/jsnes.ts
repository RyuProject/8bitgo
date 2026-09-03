/**
 * jsnes 运行时：只跑 NES (.nes)。
 *
 * jsnes 是纯 JavaScript 的 NES 模拟器（Apache-2.0），比 EmulatorJS 的 RetroArch 核心轻得多
 * —— 不用下载 WebAssembly 核心，打开就能玩。代价是 mapper 覆盖面较窄、精度略低，
 * 冷门卡带可能跑不起来；想换回 EmulatorJS 只要删掉 config/emulators.ts 里的 nes 那行。
 *
 * 这里用 jsnes 自带的高层 Browser 类：它负责 canvas、WebAudio、键盘与手柄，
 * 并提供 destroy() 做彻底清理，正好对上 Runtime.mount 的「返回销毁函数」约定。
 */
import type { Capability, CaptureSources, LoadProgress, MountOptions, PadButton, Runtime, RuntimeHandle } from '../types'
import { canvasToBlob } from '../recorder'
import { getT, fmt } from '@/services/i18n'
import { extractRomFromZip, isZip } from '@/lib/unzip'
import { assertNesRom } from '@/lib/romValidation'
import { loadGameBytes } from '../romLoader'

/**
 * 手柄键 → jsnes 的按键编号（node_modules/jsnes/src/controller.js 的静态常量）。
 * 抄成字面量而不是 import Controller：那是包的内部模块，路径随版本变，
 * 而这几个数字是 NES 硬件的移位寄存器顺序，二十年不会动。
 */
const NES_BUTTON: Record<PadButton, number> = {
  a: 0,
  b: 1,
  select: 2,
  start: 3,
  up: 4,
  down: 5,
  left: 6,
  right: 7,
}

/** 一次 rAF 最多追几帧。掉出去太多就别硬追了，直接对齐，免得补帧风暴把页面拖死 */
const MAX_CATCHUP_FRAMES = 4
/** 超过这么久没等到 rAF，就认为浏览器把它停了（页面切到后台 / 窗口最小化） */
const RAF_STALE_MS = 250
/** 音频缓冲垫的目标长度。取 64ms —— 和 RetroArch 的 audio_latency 默认值一样 */
const AUDIO_CUSHION_MS = 64
/** 静音垫最多这么频繁补一次，避免抖动时刷成一串 postMessage */
const CUSHION_REFILL_MS = 250

/** 把二进制转成 jsnes 需要的「binary string」（每个字符一个字节） */
function toBinaryString(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf)
  let out = ''
  // 分块拼接，避免超大 ROM 触发 apply 的参数上限
  const CHUNK = 0x8000
  for (let i = 0; i < bytes.length; i += CHUNK) {
    out += String.fromCharCode(...bytes.subarray(i, i + CHUNK))
  }
  return out
}

/**
 * 读取 ROM 字节。
 *
 * 这里做两件 jsnes 自己不会做的事：
 *
 * 1. **认出「取到的不是 ROM」**。ROM 根地址配错时（比如少写 https://），
 *    请求会落到本站的 SSR 兜底路由上，返回 200 + 一个 HTML 页面。
 *    直接喂给 jsnes 的话只会得到一句「Not a valid NES ROM.」，
 *    完全看不出真正的原因是地址配错了。这里提前说清楚。
 *
 * 2. **解压**。站点允许 .zip 格式的 ROM，EmulatorJS 内部会自己解压，jsnes 不会。
 *    这里按**内容**判断（zip 的 PK 魔数），文件名叫什么无关 ——
 *    实际见过把 zip 存成 .nes 的情况。
 */
async function readRom(game: File | string, onProgress?: (p: LoadProgress) => void): Promise<ArrayBuffer> {
  const loaded = await loadGameBytes(game, onProgress)
  let buf = loaded.data

  if (isZip(buf)) {
    const { data } = await extractRomFromZip(buf, ['nes', 'unf', 'unif', 'fds'])
    buf = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer
  }
  assertNesRom(buf)
  return buf
}

/**
 * jsnes 的 Browser 实例，比它的类型声明多不少东西。
 * 下划线开头的是它的实现细节，用之前都做了存在性判断。
 */
interface JsnesNes {
  toJSON: () => unknown
  fromJSON: (state: unknown) => void
  /** 构造时传进去的选项。papu.reset() 会重新读 sampleRate，所以改这里才能长期生效 */
  opts?: { sampleRate?: number }
  /** 音频处理单元。sampleTimerMax 决定「每多少 CPU 周期产一个采样」 */
  papu?: { sampleRate?: number }
  /** 公开接口，内部就是 papu.setFrameRate(rate) —— 会按当前 sampleRate 重算 sampleTimerMax */
  setFramerate?: (rate: number) => void
  /** 按下 / 松开手柄键。第一个参数是手柄编号（1 / 2），第二个是 NES_BUTTON 里的编号 */
  buttonDown?: (controller: number, button: number) => void
  buttonUp?: (controller: number, button: number) => void
}

/**
 * jsnes 的帧时钟。它有两条驱动源，而**只有 rAF 那条是按真实时间走的**：
 *
 *   1. requestAnimationFrame —— 按 wall clock 算「该跑几帧」，正确
 *   2. 音频欠载回调 —— 缓冲区一空就补两帧，用的是声卡的时钟
 *
 * 两条线都会调 generateFrame()，而 generateFrame() 会把 lastFrameTime 往前推。
 * 见 installClock 与 attachAudio 里对这两条线的处理。
 */
interface JsnesFrameTimer {
  /** 一帧多少毫秒（1000 / 60.098） */
  interval: number
  /** 上一帧对应的时间戳，已对齐到 interval 的整数倍；stop() 会置回 false */
  lastFrameTime: number | false
  /** 跑一帧模拟（nes.frame() + speakers.flush()），不碰帧时钟 */
  onGenerateFrame: () => void
  /** 把上一帧的像素真正画到 canvas 上 */
  onWriteFrame: () => void
  /** rAF 回调。是实例属性，所以可以整个换掉 —— installClock 就是这么修的 */
  onAnimationFrame: (time: number) => void
  requestAnimationFrame: () => void
  /** onGenerateFrame() + lastFrameTime += interval */
  generateFrame: () => void
}

/** jsnes 的扬声器。node 是 AudioWorkletNode，能直接往 port 里灌样本 */
interface JsnesSpeakers {
  audioCtx?: AudioContext | null
  node?: AudioWorkletNode | null
  /** worklet 报缓冲区见底时调的回调。构造时装的那个会补两帧模拟，我们要换掉它 */
  onBufferUnderrun?: () => void
}

interface JsnesBrowser {
  destroy: () => void
  loadROM: (data: string) => void
  fitInParent?: () => void
  start?: () => void
  stop?: () => void
  nes?: JsnesNes
  _screen?: { canvas?: HTMLCanvasElement }
  _speakers?: JsnesSpeakers
  _frameTimer?: JsnesFrameTimer
}

/** jsnes 只在 localStorage 里存在配置时才认手柄，没有的话插了也没反应 —— 给个标准布局的默认值 */
const GAMEPAD_CONFIG_KEY = 'gamepadConfig'
function ensureGamepadConfig() {
  try {
    if (localStorage.getItem(GAMEPAD_CONFIG_KEY)) return
    localStorage.setItem(
      GAMEPAD_CONFIG_KEY,
      JSON.stringify([
        { buttons: { BUTTON_A: 1, BUTTON_B: 0, BUTTON_SELECT: 8, BUTTON_START: 9, BUTTON_UP: 12, BUTTON_DOWN: 13, BUTTON_LEFT: 14, BUTTON_RIGHT: 15 } },
        { buttons: {} },
      ]),
    )
  } catch {
    /* 隐私模式下写不了就算了 */
  }
}

function mount(container: HTMLElement, options: MountOptions): RuntimeHandle {
  const rt = getT().runtime
  let destroyed = false
  let browser: JsnesBrowser | null = null
  /** 自己插进去的音量节点：jsnes 的 AudioWorklet 是直连 destination 的，中间没有增益 */
  let gain: GainNode | null = null
  let volume = 1
  const caps = new Set<Capability>()

  // 容器：jsnes 会把 canvas 塞进来
  const host = document.createElement('div')
  host.style.cssText = 'width:100%;height:100%;display:flex;align-items:center;justify-content:center;background:#000'
  container.appendChild(host)

  const onResize = () => browser?.fitInParent?.()

  /** 上一次 rAF 到达的时刻；音频那条线靠它判断 rAF 是不是被浏览器停了 */
  let lastRafAt = 0
  /** 上一次补静音垫的时刻，用来限流 */
  let lastCushionAt = 0

  /**
   * 接管 jsnes 的 rAF 回调 —— 「NES 跑太快」的第二个病根，也是高刷屏上最要命的那个。
   *
   * 原版 frame-timer 的逻辑是：把当前时间对齐到 60fps 的格子上，算出距上一帧过了几帧，
   * 然后跑那么多帧。高刷屏上一拍还没到一帧，算出来是 0，直接 return —— 这一步是对的。
   * 问题在于它**只挡了 `numFrames === 0`**：
   *
   *   if (numFrames === 0) return
   *
   * 而 numFrames 是会变成负数的。音频欠载回调每次补帧都把 lastFrameTime 往前推
   * （见 attachAudio），开局缓冲区是空的，第一个欠载就把帧时钟推到 33ms 之后的未来。
   * 从这一刻起 `now - lastFrameTime` 一直是负的，负数漏过那道判断落到下面，
   * 于是**每个 rAF 都老老实实跑一帧**，而且每跑一帧又把 lastFrameTime 再推 16.6ms，
   * 时钟只会越推越远，再也回不来。结果就是帧率等于显示器刷新率：
   *
   *     60Hz  屏 → 60fps，正常，所以这个 bug 一直没被发现
   *     120Hz 屏（MacBook 的 ProMotion）→ 120fps，**整整两倍速**
   *     144Hz 屏 → 2.4 倍速
   *
   * 这里换成自己的一份：负数不再放行，而是把时钟拉回现在并只补一帧；
   * 追帧也加了上限。配合 attachAudio 里「前台不让音频推帧时钟」，
   * 速度就只由真实时间决定，与刷新率无关。
   */
  const installClock = (ft: JsnesFrameTimer) => {
    lastRafAt = performance.now()
    ft.onAnimationFrame = (time: number) => {
      // 先续上下一拍，后面无论走哪条分支都不会断链
      ft.requestAnimationFrame()
      lastRafAt = performance.now()

      const interval = ft.interval
      // 对齐到 60fps 的格子上，和原版一致
      const excess = time % interval
      const aligned = time - excess

      if (ft.lastFrameTime === false) {
        ft.lastFrameTime = aligned
        return
      }

      let numFrames = Math.round((aligned - ft.lastFrameTime) / interval)

      if (numFrames === 0) return // 高刷屏上很常见：这一拍还没够一帧
      if (numFrames < 0) {
        // 帧时钟被推到了未来（音频补帧干的）。把它拉回来，这一拍只走一帧。
        ft.lastFrameTime = aligned - interval
        numFrames = 1
      } else if (numFrames > MAX_CATCHUP_FRAMES) {
        // 卡了很久（切后台回来、长时间 GC）。补满历史没有意义，直接对齐。
        ft.lastFrameTime = aligned - MAX_CATCHUP_FRAMES * interval
        numFrames = MAX_CATCHUP_FRAMES
      }

      ft.generateFrame()
      ft.onWriteFrame()

      // 多出来的帧摊到下一拍之前跑完，只算不画（和原版一样）
      const timeToNextFrame = interval - excess
      for (let i = 1; i < numFrames; i++) {
        window.setTimeout(() => ft.generateFrame(), (i * timeToNextFrame) / numFrames)
      }
    }
  }

  /**
   * 往 worklet 里灌一段静音，把缓冲区垫到 AUDIO_CUSHION_MS。
   *
   * jsnes 的 worklet 缓冲区开局是空的，而生产是「每帧一次、一次约 800 个样本」的脉冲，
   * 消费是「每 2.67ms 拿 128 个」的匀速 —— 占用量常年贴着 0，稍微抖一下就见底。
   * 垫上 64ms 之后欠载基本不再发生，帧时钟也就不会被音频推着走。
   */
  const fillCushion = (sp: JsnesSpeakers) => {
    const ctx = sp.audioCtx
    const node = sp.node
    if (!ctx || !node) return
    const n = Math.round((ctx.sampleRate * AUDIO_CUSHION_MS) / 1000)
    const silence = new Float32Array(n)
    node.port.postMessage({ type: 'samples', left: silence, right: silence })
    lastCushionAt = performance.now()
  }

  /** 等 AudioWorklet 就绪最多等这么久；等不到就放弃（没声音也得让游戏能玩） */
  const AUDIO_READY_TIMEOUT_MS = 5000

  /**
   * 等 jsnes 的音频节点就绪，然后做两件事。**两件都不能同步做**：
   * `Speakers.start()` 里 `audioCtx` 是同步建的，但 `node` 要等
   * `await audioWorklet.addModule()` 之后才赋值 —— loadROM() 一返回就去读，必然是 null。
   *
   * 一、把真实采样率补给模拟器核心（「跑太快」的病根之一，另一个在 installClock）
   *
   *   jsnes 的 Browser 在构造 NES 时写的是 `sampleRate: this._speakers.getSampleRate()`，
   *   而那一刻 audioCtx 还没建，getSampleRate() 只能返回兜底值 44100。
   *   等 AudioContext 真起来，用的是声卡的原生采样率，绝大多数机器是 48000。
   *
   *   于是核心按 44100 产样本（每帧约 734 个），worklet 按 48000 消费 ——
   *   永远产不够，缓冲区一直空，worklet 每个渲染块都报 underrun，
   *   而 Browser 对 underrun 的处理是「连跑两帧追音频」。这些补出来的帧会把
   *   FrameTimer.lastFrameTime 往前推，requestAnimationFrame 那条线算出 numFrames === 0
   *   就直接 return —— 画面时钟让位给音频时钟，最后稳定在
   *
   *       60.098 × 48000 / 44100 ≈ 65.4 fps    （快约 9%）
   *
   *   外接 96kHz 的声卡就是 2.18 倍速。有意思的是 jsnes 核心自己的默认值就是 48000，
   *   是 Browser 这层包装把它改坏了。
   *
   * 二、插一个 gain 节点，音量才调得动、录像才有声音
   *
   * 三、把「缓冲区见底」的处理从「补两帧模拟」改成「补一段静音」
   *
   *   jsnes 原来的欠载回调是 generateFrame() 两次，而 generateFrame() 会把帧时钟往前推
   *   —— 等于把模拟速度从「真实时间」交给「声卡采样率」。页面切到后台、rAF 被浏览器
   *   停掉时这么做是对的（不然声音会断），但在前台它只会和 rAF 那条线打架，
   *   还会把 lastFrameTime 推到未来，触发 installClock 里说的那个负数 bug。
   *   所以这里按「rAF 还活着没」分流：活着就只补静音垫，停了才让音频接管。
   *
   * 暂停会把整个 AudioContext 关掉（Speakers.stop()），恢复播放时重建一个新的，
   * 所以恢复之后要再调一次 —— 旧的 gain 挂在已经关闭的 context 上，是死的。
   */
  const attachAudio = async () => {
    const deadline = Date.now() + AUDIO_READY_TIMEOUT_MS
    let speakers = browser?._speakers
    while (!destroyed && (!speakers?.audioCtx || !speakers.node)) {
      if (Date.now() > deadline) return
      await new Promise((r) => setTimeout(r, 50))
      speakers = browser?._speakers
    }
    const ctx = speakers?.audioCtx
    const node = speakers?.node
    if (destroyed || !speakers || !ctx || !node) return

    // 一、采样率
    const nes = browser?.nes
    if (nes?.papu && nes.opts && ctx.sampleRate > 0 && nes.opts.sampleRate !== ctx.sampleRate) {
      nes.opts.sampleRate = ctx.sampleRate // 之后 papu.reset() 会重新读这里
      nes.papu.sampleRate = ctx.sampleRate // 当前实例立即生效
      // 传 60 算出来的正好等于 papu.reset() 里那个公式，不用自己硬写 CPU 频率常量
      nes.setFramerate?.(60)
    }

    // 三、缓冲垫与欠载分流（放在音量之前：先把缓冲区垫起来，别让开局那几拍先欠载）
    fillCushion(speakers)
    speakers.onBufferUnderrun = () => {
      const sp = browser?._speakers
      if (destroyed || !sp) return
      if (performance.now() - lastRafAt > RAF_STALE_MS) {
        // rAF 真的停了（页面在后台）。这时让音频接管时钟 —— 和 jsnes 原来的行为一致，
        // 否则声音会一直断。回到前台后 installClock 会把帧时钟拉回来。
        const ft = browser?._frameTimer
        ft?.generateFrame()
        ft?.generateFrame()
        return
      }
      // 前台的欠载只是抖动：补静音，不动帧时钟
      if (performance.now() - lastCushionAt > CUSHION_REFILL_MS) fillCushion(sp)
    }

    // 二、音量：把 worklet -> destination 的直连改成 worklet -> gain -> destination
    try {
      gain?.disconnect()
    } catch {
      /* 旧的挂在已关闭的 context 上，断不开也无所谓 */
    }
    gain = null
    try {
      const g = ctx.createGain()
      g.gain.value = volume
      node.disconnect()
      node.connect(g).connect(ctx.destination)
      gain = g
      caps.add('volume')
      options.onCaps?.(caps)
    } catch {
      gain = null
    }
  }

  void (async () => {
    try {
      options.onProgress?.({ phase: 'engine' })
      const [{ Browser }, buf] = await Promise.all([import('jsnes'), readRom(options.game, options.onProgress)])
      options.onProgress?.({ phase: 'starting', ratio: 1 })
      if (destroyed) return

      // ⚠️ 刻意不传 romData。
      // jsnes 的构造函数是「先把 document 级键盘监听挂上、启动手柄轮询，最后才 loadROM」，
      // 而 loadROM 会对非法 ROM 或不支持的 mapper 抛错。一旦在构造函数里抛出来，
      // 我们拿不到实例，也就调不到 destroy() —— 那三个 keydown/keyup/keypress 监听会永久
      // 留在 document 上，把全站的方向键和 Z/X/A/S 全部 preventDefault 掉：
      // 搜索框打不出字、页面没法用方向键滚动，只能刷新页面。
      // 分两步来，loadROM 抛错时实例已经在手上，可以正常清理干净。
      ensureGamepadConfig()
      browser = new Browser({
        container: host,
        onError: (err: Error) => options.onError?.(fmt(rt.jsnesRunFailed, { msg: err.message })),
      }) as unknown as JsnesBrowser

      try {
        browser.loadROM(toBinaryString(buf))
      } catch (e) {
        const inst = browser
        browser = null
        try {
          inst.destroy()
        } catch {
          /* 清理失败就算了，至少监听已经摘掉 */
        }
        throw e
      }

      // 帧时钟要在 loadROM() 之后接管：loadROM() 内部会调 start()，那之前 _frameTimer
      // 还没开始跑。换掉的是实例属性 onAnimationFrame，而 requestAnimationFrame() 每次
      // 都重新读它，所以从下一拍起就走我们这份（原版最多再跑一拍，无害）。
      if (browser._frameTimer) installClock(browser._frameTimer)

      window.addEventListener('resize', onResize)

      for (const c of ['pause', 'screenshot', 'record', 'gamepad', 'touchpad'] as Capability[]) caps.add(c)
      if (browser.nes) caps.add('saveState')
      options.onCaps?.(caps)

      // 音频要等 AudioWorklet 加载完才能接，不能在这里同步做（见 attachAudio 的说明）
      void attachAudio()

      options.onReady?.()
      options.onStart?.()
    } catch (e) {
      if (destroyed) return
      const msg = e instanceof Error ? e.message : String(e)
      options.onError?.(fmt(rt.jsnesLoadFailed, { msg }))
    }
  })()

  const canvas = () => browser?._screen?.canvas ?? (host.querySelector('canvas') as HTMLCanvasElement | null)

  return {
    caps,
    volume,
    setPaused: (paused) => {
      if (paused) {
        browser?.stop?.()
        // Speakers.stop() 把 AudioContext 关了，手上这个 gain 已经是死的
        gain = null
        return
      }
      browser?.start?.()
      // 恢复播放会重建 AudioContext 和 worklet，采样率和 gain 都要重新接
      void attachAudio()
    },
    setVolume: (v) => {
      volume = Math.max(0, Math.min(1, v))
      if (gain) gain.gain.value = volume
    },
    // 屏幕手柄：直接喂给核心，不去合成键盘事件 —— jsnes 的键盘处理读的是 e.keyCode，
    // 合成事件在各浏览器上的行为都不一样，没必要冒这个风险。手柄编号固定 1（一号手柄）。
    sendButton: (button, down) => {
      const nes = browser?.nes
      const code = NES_BUTTON[button]
      if (!nes || code === undefined) return
      if (down) nes.buttonDown?.(1, code)
      else nes.buttonUp?.(1, code)
    },
    screenshot: async () => {
      const c = canvas()
      return c ? canvasToBlob(c) : null
    },
    saveState: async () => {
      const nes = browser?.nes
      if (!nes) return null
      return new Blob([JSON.stringify(nes.toJSON())], { type: 'application/json' })
    },
    loadState: async (data) => {
      const nes = browser?.nes
      if (!nes) return
      nes.fromJSON(JSON.parse(new TextDecoder().decode(data)))
    },
    // 录声音接在自己插的 gain 上：录到的就是玩家听到的
    captureSources: (): CaptureSources => ({
      canvas: canvas(),
      audioNode: gain,
      audioContext: browser?._speakers?.audioCtx ?? null,
    }),
    destroy: () => {
      destroyed = true
      window.removeEventListener('resize', onResize)
      try {
        gain?.disconnect()
      } catch {
        /* ignore */
      }
      gain = null
      try {
        browser?.destroy()
      } catch {
        /* 已经卸载过就忽略 */
      }
      host.remove()
    },
  }
}

export const jsnesRuntime: Runtime = {
  id: 'jsnes',
  name: 'jsnes',
  get description() {
    return getT().runtime.jsnesDesc
  },
  extensions: ['nes'],
  // 比 EmulatorJS 高：命中 .nes 时优先用它
  priority: 20,
  available: () => true,
  supports: (platform) => platform === 'nes',
  engineLabel: () => 'jsnes',
  mount,
}
