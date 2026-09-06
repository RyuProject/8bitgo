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
 * ── 部署（没做这一步 PS2 平台不会出现）────────────────────────
 * 上游没有发布任何预编译产物，也没有 CDN 和 npm 包，只能自己构建：
 *
 *   git clone https://github.com/jpd002/Play-.git && cd Play- && git submodule update --init --recursive
 *   mkdir build && cd build
 *   emcmake cmake .. -DCMAKE_BUILD_TYPE=Release -DBUILD_TESTS=OFF -DBUILD_PLAY=ON -DBUILD_PSFPLAYER=ON -DUSE_QT=OFF
 *   cmake --build . --config Release
 *
 * 把产物里的 `Play.js` 和 `Play.wasm` 放到同一个可公开访问的目录下，
 * 然后 `VITE_PLAY_PATH=/play/`（或完整 URL）。**只要这两个文件**——
 * 上游那个 React 壳（js/play_browser）我们不用，UI 是这个适配器自己搭的。
 *
 * ── 盘不整份下载 ─────────────────────────────────────────────
 * PS2 是 DVD，一张 1~4.7GB，整份下下来既等不起也存不下。
 * Play! 的读盘口子（DiscImageDevice）只用到 `file.size` 和 `file.slice(a,b).arrayBuffer()`
 * 这两样，所以我们塞一个 HTTP Range 驱动的对象进去就行 —— 只下游戏真正读到的扇区。
 * 见 ../remoteDisc.ts。这是 PS2 能上网页的唯一前提，别改回整份下载。
 */
import type { Capability, CaptureSources, MountOptions, RuntimeHandle } from '../types'
import { PLAY_PATH } from '../paths'
import { getT, fmt } from '@/services/i18n'
import { RemoteDisc, httpRangeFetcher, probeRange, type DiscSource } from '../remoteDisc'
import { runAsCommonJs } from '@/lib/umd'

/** Emscripten 模块工厂（MODULARIZE 构建）。只列我们真正调到的那几样 */
interface PlayModule {
  HEAPU8: Uint8Array
  FS: { mkdir(path: string): void }
  canvas?: HTMLCanvasElement
  discImageDevice?: unknown
  ccall(name: string, ret: string | null, argTypes: string[], args: unknown[]): unknown
  bootDiscImage(fileName: string): void
  bootElf(fileName: string): void
  getFrames?: () => number
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

export function mount(container: HTMLElement, options: MountOptions): RuntimeHandle {
  const rt = getT().runtime
  let destroyed = false
  let module: PlayModule | null = null
  let disc: RemoteDisc | null = null
  let readyFired = false
  const caps = new Set<Capability>()

  const canvas = document.createElement('canvas')
  canvas.width = 640
  canvas.height = 448
  canvas.style.cssText = 'width:100%;height:100%;object-fit:contain;background:#000;display:block'
  // 键盘要能落到画布上，否则手柄输入全废（同 frameFocus.ts 里 iframe 那套的道理）
  canvas.tabIndex = 0
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
    options.onError?.(message)
  }

  const boot = async () => {
    if (!PLAY_PATH) {
      options.onError?.(rt.playNotDeployed)
      return
    }

    /* ---- 1. 盘：先探 Range ---- */
    let source: DiscSource
    let discName: string
    if (typeof options.game === 'string') {
      options.onProgress?.({ phase: 'rom', loaded: 0 })
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
      discName = discNameOf(options.game, 'game.iso')
      // 盘是按需读的，没有「下载完成」这一说 —— 直接把 rom 阶段推满，
      // 后面的时间都花在引擎启动上，进度条不该卡在 40% 装死
      options.onProgress?.({ phase: 'rom', loaded: probe.size, total: probe.size, ratio: 1, cached: true })
    } else {
      // 玩家自己选的本地文件：File 本来就支持 slice，直接当盘用，零拷贝
      source = options.game
      discName = options.game.name
      options.onProgress?.({ phase: 'rom', loaded: options.game.size, total: options.game.size, ratio: 1, cached: true })
    }

    /* ---- 2. 引擎 ---- */
    options.onProgress?.({ phase: 'engine', loaded: 0 })
    const scriptUrl = `${PLAY_PATH}Play.js`
    let factory: PlayFactory
    try {
      const src = await fetch(scriptUrl).then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`)
        return r.text()
      })
      if (destroyed) return
      /**
       * 走 runAsCommonJs 而不是插 <script>：Emscripten 的 MODULARIZE 产物也是一段 UMD，
       * 页面上只要有别的脚本占了 module/exports/define，它就会往 window 上挂一个 `Play`。
       * 这个仓库被全局名字坑过两次（js-dos 泄漏 io 顶掉 socket.io），不再走那条路。
       */
      const exported = runAsCommonJs(src)
      if (typeof exported !== 'function') throw new Error('Play.js 没有导出模块工厂')
      factory = exported as PlayFactory
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
      instance.discImageDevice = new StreamingDiscDevice(
        () => module,
        source,
        (e) => fail(fmt(rt.playDiscFailed, { msg: e.message })),
      )
      instance.ccall('initVm', null, [], [])

      options.onProgress?.({ phase: 'starting', loaded: 0 })
      if (ELF_RE.test(discName)) instance.bootElf(discName)
      else instance.bootDiscImage(discName)

      readyFired = true
      // 截图和录制要 canvas，这两个是白给的；暂停 / 存档 Play! 这版没有稳定接口，不谎报
      for (const c of ['screenshot', 'record'] as Capability[]) caps.add(c)
      options.onCaps?.(caps)
      options.onReady?.()
      options.onStart?.()
      canvas.focus()
    } catch (e) {
      if (!destroyed) options.onError?.(fmt(rt.playLoadFailed, { msg: e instanceof Error ? e.message : String(e) }))
    }
  }

  void boot()

  return {
    destroy: () => {
      destroyed = true
      // 先断开读盘回调再拆模块：StreamingDiscDevice 里那几个 then 可能还在飞，
      // module 置空之后它们会自己什么都不做（见那边的注释）
      module = null
      disc?.dispose()
      disc = null
      canvas.remove()
    },
    caps,
    captureSources: (): CaptureSources => ({ canvas }),
  }
}
