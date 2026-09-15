/**
 * Play! 运行时：PlayStation 2。**实验性**。
 *
 * ── 先把话说清楚 ─────────────────────────────────────────────
 * 这不是一个「和 PS1 一样能玩」的平台。EmulatorJS 的系统列表到 PSP 为止，没有 PS2 核心；
 * 浏览器里能跑 PS2 的只有 Play!（jpd002/Play- 的 emscripten 构建），而它有两条
 * **结构性**限制 —— 是浏览器沙箱造成的，不是移植没做完，短期内也不会消失：
 *
 *   1. 拿不到内存页的写保护，于是 JIT cache 没法失效。
 *      在 EE 上动态加载模块的游戏会跑错（这类游戏不少）。
 *   2. 没法控制浮点舍入模式，只能用默认的。
 *      一部分游戏的画面和物理会不对。
 *
 * 作者自己给这个 web 版的定性是 "only an experiment"。而 Play! 桌面版的兼容性本来就
 * 远落后 PCSX2，web 版还要再差一层。所以站上一律标注实验性，
 * **别把它当成一个正常能玩的平台去运营**。真要 PS2 的兼容性，路只有一条：
 * 游戏跑在服务器上、画面串流（cloud-game + LRPS2）。
 *
 * ── 部署 ────────────────────────────────────────────────────
 * 官方 Web 部署的 `Play.js` / `Play.wasm` 连同许可证、自身长度和 SHA-256 一起提交在
 * `public/play/`，`.env.production` 与 `.env.development` 都把 `VITE_PLAY_PATH` 指到这里。
 * prebuild 的 `scripts/check-play.mjs` 会阻止漏文件或 JS / wasm 分批升级。
 * 上游 React 壳（js/play_browser）不使用，UI、远程读盘和输入由这个适配器接管。
 *
 * ── 盘不整份下载 ─────────────────────────────────────────────
 * PS2 是 DVD，一张 1~4.7GB，整份下下来既等不起也存不下。
 * Play! 的读盘口子（DiscImageDevice）只用到 `file.size` 和 `file.slice(a,b).arrayBuffer()`
 * 这两样，所以我们塞一个 HTTP Range 驱动的对象进去就行 —— 只下游戏真正读到的扇区。
 * 见 ../remoteDisc.ts。这是 PS2 能上网页的唯一前提，别改回整份下载。
 */
import type { Capability, CaptureSources, MountOptions, PadButton, RuntimeHandle } from '../types'
import { PLAY_PATH } from '../paths'
import { getT, fmt } from '@/services/i18n'
import { RemoteDisc, httpRangeFetcher, probeRange, type DiscSource } from '../remoteDisc'
import { GP, hasGamepadApi, startGamepadBridge, type GamepadBridge } from '../gamepad'
import { canvasToBlob } from '../recorder'

/** Emscripten 模块工厂（MODULARIZE 构建）。只列我们真正调到的那几样 */
interface PlayModule {
  HEAPU8: Uint8Array
  FS: {
    mkdir(path: string): void
    writeFile(path: string, data: Uint8Array): void
  }
  canvas?: HTMLCanvasElement
  discImageDevice?: unknown
  ccall(name: string, ret: string | null, argTypes: string[], args: unknown[]): unknown
  bootDiscImage(fileName: string): void
  bootElf(fileName: string): void
  getFrames?: () => number
  clearStats?: () => void
  pauseMainLoop?: () => void
  resumeMainLoop?: () => void
}

type PlayFactory = (overrides: Record<string, unknown>) => Promise<PlayModule>

/**
 * Play! 那边的读盘接口。我们自己实现一份，而不是用上游 React 壳里的
 * DiscImageDevice —— 那一份只认 File，我们要塞的是远程盘。
 *
 * ⚠️ `read()` 是**发起**读取、立刻返回；wasm 随后轮询 `isDone()` 等数据到位。
 * 所以这里绝不能把 doneFlag 提前置 true，也不能在 read 里 await ——
 * 提前置真的话 wasm 会去读一块还没填上的内存，表现是随机花屏或者直接崩，
 * 而且每次不一样，基本没法查。
 */
class StreamingDiscDevice {
  private doneFlag = false
  // tsconfig 开了 erasableSyntaxOnly（产物必须是「把类型删掉就等于 JS」），
  // 所以不能用构造函数参数属性那种糖，只能老老实实写字段 + 赋值
  private readonly module: () => PlayModule | null
  private readonly source: DiscSource
  private readonly onFail: (e: Error) => void

  constructor(module: () => PlayModule | null, source: DiscSource, onFail: (e: Error) => void) {
    this.module = module
    this.source = source
    this.onFail = onFail
  }

  read(dstPtr: number, offset: number, size: number): void {
    this.doneFlag = false
    this.source
      .slice(offset, offset + size)
      .arrayBuffer()
      .then((value) => {
        const m = this.module()
        // 会话已经拆了（玩家退出 / 换游戏）就什么都不做。往一个已销毁模块的
        // HEAPU8 里写会抛 detached buffer，而那时候已经没人接得住这个异常了
        if (!m) return
        m.HEAPU8.set(new Uint8Array(value), dstPtr)
        this.doneFlag = true
      })
      .catch((e: unknown) => {
        // 读盘失败不能就这么算了：doneFlag 永远不翻，wasm 会一直轮询下去，
        // 玩家看到的是画面定格、没有任何提示。这里把它报上去让播放器收场。
        this.onFail(e instanceof Error ? e : new Error(String(e)))
      })
  }

  getFileSize(): number {
    return this.source.size
  }

  isDone(): boolean {
    return this.doneFlag
  }

  /** 上游接口的一部分：我们的盘在构造时就定好了，这里只做兼容 */
  setFile(): void {
    /* 远程盘不支持中途换盘 */
  }
}

/** 这台机器 / 这个部署能不能跑 PS2 */
export function playAvailable(): boolean {
  return Boolean(PLAY_PATH) && typeof WebAssembly !== 'undefined'
}

/** 盘的文件名：Play! 用它判断容器格式（.iso / .chd / .cso …），必须带对扩展名 */
function discNameOf(game: File | string, fallback: string): string {
  if (typeof game !== 'string') return game.name
  try {
    const path = new URL(game, location.href).pathname
    const base = path.slice(path.lastIndexOf('/') + 1)
    if (base) return decodeURIComponent(base)
  } catch {
    /* 相对地址解析不了就用兜底名 */
  }
  return fallback
}

const ELF_RE = /\.elf$/i

interface PlayKey {
  code: string
  key: string
}

const key = (code: string, value: string): PlayKey => ({ code, key: value })

/**
 * Play! 当前 Web 版只读键盘。物理手柄和屏幕手柄都在这里翻成它官方写死的键位，
 * 否则桌面上只有键盘能玩、手机上则一颗能按的键都没有。
 */
const PLAY_GAMEPAD_MAP: Record<number, PlayKey> = {
  [GP.A]: key('KeyZ', 'z'),
  [GP.B]: key('KeyX', 'x'),
  [GP.X]: key('KeyA', 'a'),
  [GP.Y]: key('KeyS', 's'),
  // 上游绑定名确实写的是 Key1…Key0，不是浏览器物理键盘通常上报的 Digit1…Digit0。
  [GP.L1]: key('Key1', '1'),
  [GP.R1]: key('Key8', '8'),
  [GP.L2]: key('Key2', '2'),
  [GP.R2]: key('Key9', '9'),
  [GP.L3]: key('Key3', '3'),
  [GP.R3]: key('Key0', '0'),
  [GP.SELECT]: key('Backspace', 'Backspace'),
  [GP.START]: key('Enter', 'Enter'),
  [GP.UP]: key('ArrowUp', 'ArrowUp'),
  [GP.DOWN]: key('ArrowDown', 'ArrowDown'),
  [GP.LEFT]: key('ArrowLeft', 'ArrowLeft'),
  [GP.RIGHT]: key('ArrowRight', 'ArrowRight'),
}

const PLAY_TOUCH_MAP: Record<PadButton, PlayKey> = {
  up: PLAY_GAMEPAD_MAP[GP.UP],
  down: PLAY_GAMEPAD_MAP[GP.DOWN],
  left: PLAY_GAMEPAD_MAP[GP.LEFT],
  right: PLAY_GAMEPAD_MAP[GP.RIGHT],
  // 屏幕上的 A / B 对应 PS2 最常用的确认（×）/ 返回（○）。
  a: PLAY_GAMEPAD_MAP[GP.A],
  b: PLAY_GAMEPAD_MAP[GP.B],
  select: PLAY_GAMEPAD_MAP[GP.SELECT],
  start: PLAY_GAMEPAD_MAP[GP.START],
}

function dispatchKey(canvas: HTMLCanvasElement, value: PlayKey, down: boolean): void {
  canvas.dispatchEvent(
    new KeyboardEvent(down ? 'keydown' : 'keyup', {
      code: value.code,
      key: value.key,
      bubbles: true,
      cancelable: true,
    }),
  )
}

/**
 * Play! 上游把数字行绑定成了 `Key1`…`Key0`，而浏览器标准事件实际叫 `Digit1`…`Digit0`。
 * 这里补发一份上游能识别的事件，让实体键盘的肩键也能用；合成事件本身不会再次进入这个分支。
 */
function normalizeNumberKey(event: KeyboardEvent): void {
  const match = /^Digit([0-9])$/.exec(event.code)
  if (!match || !(event.currentTarget instanceof HTMLCanvasElement)) return
  dispatchKey(event.currentTarget, key(`Key${match[1]}`, match[1]), event.type === 'keydown')
}

export function mount(container: HTMLElement, options: MountOptions): RuntimeHandle {
  const rt = getT().runtime
  let destroyed = false
  let module: PlayModule | null = null
  let disc: RemoteDisc | null = null
  let pad: GamepadBridge | null = null
  let readyPoll = 0
  let readyTimeout = 0
  let readyFired = false
  const caps = new Set<Capability>()

  const canvas = document.createElement('canvas')
  canvas.width = 640
  canvas.height = 480
  // 上游 Main.cpp 把 WebGL 目标写死成 #outputCanvas；没有这个 id，initVm 会直接 assert。
  canvas.id = 'outputCanvas'
  canvas.style.cssText = 'width:100%;height:100%;object-fit:contain;background:#000;display:block'
  // 键盘要能落到画布上，否则手柄输入全废（同 frameFocus.ts 里 iframe 那套的道理）
  canvas.tabIndex = 0
  canvas.addEventListener('keydown', normalizeNumberKey, true)
  canvas.addEventListener('keyup', normalizeNumberKey, true)
  container.appendChild(canvas)

  /**
   * 引擎自己那条线上的失败。
   *
   * onReady 之后再报错**不能**拆会话 —— 那时候玩家正在玩，一次读盘超时把整局掀掉
   * 比让他自己退出更糟（见 项目记忆「模拟器适配器体检」的第一条）。
   */
  const fail = (message: string) => {
    if (destroyed) return
    if (readyFired) {
      console.warn('[play] 运行中出错：', message)
      return
    }
    window.clearInterval(readyPoll)
    window.clearTimeout(readyTimeout)
    options.onError?.(message)
  }

  const boot = async () => {
    if (!PLAY_PATH) {
      options.onError?.(rt.playNotDeployed)
      return
    }
    if (!globalThis.crossOriginIsolated || typeof SharedArrayBuffer === 'undefined') {
      // 官方构建固定创建两个 pthread；普通详情页没有 COOP/COEP，创建共享内存时必崩。
      options.onError?.(rt.playNeedsIsolation)
      return
    }

    /* ---- 1. 盘：先探 Range ---- */
    let source: DiscSource | null = null
    let elfBytes: Uint8Array | null = null
    const discName = discNameOf(options.game, 'game.iso')
    const isElf = ELF_RE.test(discName)
    if (typeof options.game === 'string') {
      options.onProgress?.({ phase: 'rom', loaded: 0 })
      if (isElf) {
        const res = await fetch(options.game)
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        elfBytes = new Uint8Array(await res.arrayBuffer())
        options.onProgress?.({ phase: 'rom', loaded: elfBytes.byteLength, total: elfBytes.byteLength, ratio: 1 })
      } else {
        const probe = await probeRange(options.game)
        if (destroyed) return
        if (!probe.rangeSupported || !probe.size) {
          // 整份下载不是退路：PS2 一张盘几 GB，下不下来也存不下。
          // 与其让玩家等十分钟再失败，不如现在就说清楚是服务器不支持 Range。
          options.onError?.(rt.playNoRange)
          return
        }
        disc = new RemoteDisc({ size: probe.size, fetchRange: httpRangeFetcher(options.game) })
        source = disc
        // 盘是按需读的，没有「下载完成」这一说 —— 直接把 rom 阶段推满，
        // 后面的时间都花在引擎启动上，进度条不该卡在 40% 装死
        options.onProgress?.({ phase: 'rom', loaded: probe.size, total: probe.size, ratio: 1, cached: true })
      }
    } else {
      if (isElf) elfBytes = new Uint8Array(await options.game.arrayBuffer())
      else source = options.game
      // 玩家自己选的本地光盘：File 本来就支持 slice，直接当盘用，零拷贝
      options.onProgress?.({ phase: 'rom', loaded: options.game.size, total: options.game.size, ratio: 1, cached: true })
    }

    /* ---- 2. 引擎 ---- */
    options.onProgress?.({ phase: 'engine', loaded: 0 })
    const scriptUrl = `${PLAY_PATH}Play.js`
    let factory: PlayFactory
    try {
      /**
       * 2026-09 的官方产物是 ES module（末尾 `export default Play`），已经不是 UMD。
       * 把源码塞进 CommonJS 包装器会直接 SyntaxError；按模块导入也让 pthread Worker
       * 能用同一份 URL 重新加载自己，这是 Emscripten 当前生成代码要求的形态。
       */
      const imported = (await import(/* @vite-ignore */ scriptUrl)) as { default?: PlayFactory }
      if (destroyed) return
      if (typeof imported.default !== 'function') throw new Error('Play.js 没有导出模块工厂')
      factory = imported.default
    } catch (e) {
      if (!destroyed) options.onError?.(fmt(rt.playLoadFailed, { msg: e instanceof Error ? e.message : String(e) }))
      return
    }

    /* ---- 3. 起 VM ---- */
    try {
      const instance = await factory({
        canvas,
        // Play.wasm 和 Play.js 放在一起。不给这个的话 emscripten 会按**当前页面**的
        // 地址去找 wasm —— 站点是 SPA，任何一个 /games/xxx 路径下都会 404
        locateFile: (file: string) => `${PLAY_PATH}${file}`,
        mainScriptUrlOrBlob: scriptUrl,
        printErr: (msg: string) => console.warn('[play]', msg),
      })
      if (destroyed) return
      module = instance
      try {
        instance.FS.mkdir('/work')
      } catch {
        /* 已存在 */
      }
      if (source) {
        instance.discImageDevice = new StreamingDiscDevice(
          () => module,
          source,
          (e) => fail(fmt(rt.playDiscFailed, { msg: e.message })),
        )
      }
      instance.ccall('initVm', null, [], [])

      options.onProgress?.({ phase: 'starting', loaded: 0 })
      if (isElf && elfBytes) {
        const path = `/work/${discName}`
        instance.FS.writeFile(path, elfBytes)
        instance.bootElf(path)
      } else {
        instance.bootDiscImage(discName)
      }

      // 截图、录像和触屏键由本站接上；暂停 / 存档 Play! 这版没有稳定接口，不谎报。
      for (const c of ['screenshot', 'record', 'touchpad'] as Capability[]) caps.add(c)
      if (hasGamepadApi()) {
        caps.add('gamepad')
        pad = startGamepadBridge(PLAY_GAMEPAD_MAP, (button, down) => dispatchKey(canvas, button, down), {
          // 十字键和左摇杆在 PS2 是两套输入；把摇杆当十字键会让许多 3D 游戏无法走动。
          stickAsDpad: false,
          axisBindings: [
            { axis: 0, negative: key('KeyF', 'f'), positive: key('KeyH', 'h') },
            { axis: 1, negative: key('KeyT', 't'), positive: key('KeyG', 'g') },
            { axis: 2, negative: key('KeyJ', 'j'), positive: key('KeyL', 'l') },
            { axis: 3, negative: key('KeyI', 'i'), positive: key('KeyK', 'k') },
          ],
        })
      }
      options.onCaps?.(caps)
      canvas.focus()

      const markReady = () => {
        if (destroyed || readyFired) return
        readyFired = true
        window.clearInterval(readyPoll)
        window.clearTimeout(readyTimeout)
        options.onGeometry?.({ width: 640, height: 480 })
        options.onReady?.()
        options.onStart?.()
      }
      if (typeof instance.getFrames !== 'function') {
        markReady()
      } else {
        // bootDiscImage() 只代表命令交给 VM；等到真的画出第一帧再撤加载遮罩。
        instance.clearStats?.()
        readyPoll = window.setInterval(() => {
          if ((instance.getFrames?.() ?? 0) > 0) markReady()
        }, 250)
        readyTimeout = window.setTimeout(() => {
          if (!readyFired) fail(rt.playStartTimeout)
        }, 90_000)
      }
    } catch (e) {
      window.clearInterval(readyPoll)
      window.clearTimeout(readyTimeout)
      if (!destroyed) options.onError?.(fmt(rt.playLoadFailed, { msg: e instanceof Error ? e.message : String(e) }))
    }
  }

  // 读远程 ELF / Range 探测也在引擎 try 之前，必须收住整个 boot 的拒绝；
  // 否则网络错误只会变成控制台里的 unhandled rejection，玩家一直看到加载中。
  void boot().catch((e: unknown) => {
    window.clearInterval(readyPoll)
    window.clearTimeout(readyTimeout)
    if (!destroyed) options.onError?.(fmt(rt.playLoadFailed, { msg: e instanceof Error ? e.message : String(e) }))
  })

  return {
    destroy: () => {
      destroyed = true
      window.clearInterval(readyPoll)
      window.clearTimeout(readyTimeout)
      pad?.stop()
      pad = null
      // 先断开读盘回调再拆模块：StreamingDiscDevice 里那几个 then 可能还在飞，
      // module 置空之后它们会自己什么都不做（见那边的注释）
      module?.pauseMainLoop?.()
      module = null
      disc?.dispose()
      disc = null
      canvas.removeEventListener('keydown', normalizeNumberKey, true)
      canvas.removeEventListener('keyup', normalizeNumberKey, true)
      canvas.remove()
    },
    caps,
    sendButton(button, down) {
      const value = PLAY_TOUCH_MAP[button]
      if (value) dispatchKey(canvas, value, down)
    },
    focus: () => canvas.focus(),
    screenshot: () => canvasToBlob(canvas),
    captureSources: (): CaptureSources => ({ canvas }),
  }
}
