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
import type { Capability, CaptureSources, LoadProgress, MountOptions, Runtime, RuntimeHandle } from '../types'
import { canvasToBlob } from '../recorder'
import { getT, fmt } from '@/services/i18n'
import { extractRomFromZip, isZip } from '@/lib/unzip'
import { assertNesRom } from '@/lib/romValidation'
import { loadGameBytes } from '../romLoader'

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
}

interface JsnesBrowser {
  destroy: () => void
  loadROM: (data: string) => void
  fitInParent?: () => void
  start?: () => void
  stop?: () => void
  nes?: JsnesNes
  _screen?: { canvas?: HTMLCanvasElement }
  _speakers?: { audioCtx?: AudioContext | null; node?: AudioNode | null }
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

  /** 等 AudioWorklet 就绪最多等这么久；等不到就放弃（没声音也得让游戏能玩） */
  const AUDIO_READY_TIMEOUT_MS = 5000

  /**
   * 等 jsnes 的音频节点就绪，然后做两件事。**两件都不能同步做**：
   * `Speakers.start()` 里 `audioCtx` 是同步建的，但 `node` 要等
   * `await audioWorklet.addModule()` 之后才赋值 —— loadROM() 一返回就去读，必然是 null。
   *
   * 一、把真实采样率补给模拟器核心（这条是「游戏跑太快」的病根）
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
    if (destroyed || !ctx || !node) return

    // 一、采样率
    const nes = browser?.nes
    if (nes?.papu && nes.opts && ctx.sampleRate > 0 && nes.opts.sampleRate !== ctx.sampleRate) {
      nes.opts.sampleRate = ctx.sampleRate // 之后 papu.reset() 会重新读这里
      nes.papu.sampleRate = ctx.sampleRate // 当前实例立即生效
      // 传 60 算出来的正好等于 papu.reset() 里那个公式，不用自己硬写 CPU 频率常量
      nes.setFramerate?.(60)
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

      window.addEventListener('resize', onResize)

      for (const c of ['pause', 'screenshot', 'record', 'gamepad'] as Capability[]) caps.add(c)
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
