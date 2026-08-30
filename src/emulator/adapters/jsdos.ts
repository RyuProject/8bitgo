/**
 * js-dos 运行时：DOS 游戏（GPL-2.0，自托管在 public/jsdos/）。
 *
 * 相比走 EmulatorJS 的 dosbox_pure 核心，js-dos 是 DOSBox 的原生浏览器移植：
 * 启动更快、DOS 兼容性更好（它本来就是干这个的），而且自带 IPX over WebRTC 的联机能力
 * —— 当年那批 DOS 局域网游戏（毁灭战士、毁灭公爵、魔兽争霸 2）真正能联机就靠它。
 *
 * ⚠️ js-dos 只认「带 .jsdos/dosbox.conf 的 zip」，普通 zip 丢进去是起不来的。
 * 所以本地文件会先经 lib/jsdosBundle.ts 现场重打一个包（不解压，只补一份配置）。
 *
 * 资源默认从 /jsdos/ 加载（由 scripts/copy-jsdos.mjs 从 npm 包复制过来）。
 * 想换成官方 CDN 就设 VITE_JSDOS_PATH=https://v8.js-dos.com/latest/
 */
import type { Capability, CaptureSources, LoadProgress, MountOptions, Runtime, RuntimeHandle } from '../types'
import { getT, fmt } from '@/services/i18n'
import { buildDosboxConf, makeJsdosBundle } from '@/lib/jsdosBundle'
import { imageDataToBlob } from '../recorder'
import { GP, startGamepadBridge, hasGamepadApi, type GamepadBridge } from '../gamepad'
import { deleteSave, pullSave, pushSave } from '@/services/saves'
import { loadGameBytes } from '../romLoader'

/** P2P 模式的撮合服务器。自建的话见 https://github.com/caiiiycuk/WebRTC-NET（Go） */
export const JSDOS_PEER_SERVER: string = import.meta.env.VITE_JSDOS_PEER_SERVER || 'https://net.dos.zone'

/** TURN / STUN 从自家后端拿（和 P2P 联机共用同一个接口） */
async function fetchIceServers(): Promise<RTCIceServer[]> {
  const base = (import.meta.env.VITE_API_URL || '').replace(/\/+$/, '')
  if (!base) return []
  try {
    const res = await fetch(`${base}/api/netplay/ice`, { cache: 'no-store' })
    if (!res.ok) return []
    const data = (await res.json()) as { iceServers?: RTCIceServer[] }
    return data.iceServers ?? []
  } catch {
    return []
  }
}

export const JSDOS_PATH: string = (() => {
  const p = import.meta.env.VITE_JSDOS_PATH || '/jsdos/'
  return p.endsWith('/') ? p : `${p}/`
})()

type DosProps = {
  stop: () => Promise<void> | void
  /** 把盘上的改动固化下来。js-dos v8 的 Player API，返回是否存成功 */
  save?: () => Promise<boolean>
  setPaused?: (paused: boolean) => void
  setVolume?: (volume: number) => void
}

/** js-dos 的底层接口，ci-ready 事件里给出来 */
interface DosCi {
  pause: () => void
  resume: () => void
  screenshot: () => Promise<ImageData>
  sendKeyEvent: (keyCode: number, pressed: boolean) => void
  exit: () => Promise<void>
}

/**
 * DOSBox 的键码（js-dos 的 KBD_* 常量）。DOS 游戏没有统一的手柄标准，
 * 这里按「方向键 + Ctrl/Alt/空格/回车」这套最通用的键位映射，
 * 大部分 DOS 动作游戏（毁灭战士、波斯王子之类）默认键位都在里面。
 */
const KBD = {
  right: 262,
  left: 263,
  down: 264,
  up: 265,
  esc: 256,
  enter: 257,
  tab: 258,
  space: 32,
  leftShift: 340,
  leftCtrl: 341,
  leftAlt: 342,
} as const

const DOS_PAD_MAP: Record<number, number> = {
  [GP.UP]: KBD.up,
  [GP.DOWN]: KBD.down,
  [GP.LEFT]: KBD.left,
  [GP.RIGHT]: KBD.right,
  [GP.A]: KBD.leftCtrl,
  [GP.B]: KBD.leftAlt,
  [GP.X]: KBD.space,
  [GP.Y]: KBD.leftShift,
  [GP.START]: KBD.enter,
  [GP.SELECT]: KBD.esc,
  [GP.L1]: KBD.tab,
}
type DosFn = (el: HTMLElement, options: Record<string, unknown>) => DosProps

/** js-dos 是全局脚本，整页只加载一次 */
let loading: Promise<DosFn> | null = null
function loadJsDos(): Promise<DosFn> {
  if (loading) return loading
  loading = new Promise<DosFn>((resolve, reject) => {
    const win = window as unknown as { Dos?: DosFn }
    if (win.Dos) return resolve(win.Dos)

    const css = document.createElement('link')
    css.rel = 'stylesheet'
    css.href = `${JSDOS_PATH}js-dos.css`
    document.head.appendChild(css)

    const script = document.createElement('script')
    script.src = `${JSDOS_PATH}js-dos.js`
    script.onload = () => (win.Dos ? resolve(win.Dos) : reject(new Error('js-dos 已加载但没有暴露 Dos()')))
    script.onerror = () => reject(new Error(`加载失败：${JSDOS_PATH}js-dos.js`))
    document.head.appendChild(script)
  }).catch((e) => {
    loading = null // 允许下次重试
    throw e
  })
  return loading
}

async function readRom(
  game: File | string,
  onProgress?: (p: LoadProgress) => void,
): Promise<{ name: string; buf: ArrayBuffer }> {
  const loaded = await loadGameBytes(game, onProgress)
  return { name: loaded.name, buf: loaded.data }
}

function mount(container: HTMLElement, options: MountOptions): RuntimeHandle {
  const rt = getT().runtime
  let destroyed = false
  let props: DosProps | null = null
  let ci: DosCi | null = null
  let pad: GamepadBridge | null = null
  let objectUrl = ''
  let volume = 1
  let paused = false
  /** onReady 的延时兜底定时器，销毁时要清掉 */
  let readyFallback = 0
  /** 存档按 slug 归档；见下面 fsChanges 那段的说明 */
  let saveKey = ''
  /** 最近一次存档落到哪儿了（云端 / 浏览器），给界面显示用 */
  let lastPush: { ok: boolean; where: 'cloud' | 'local' | null } | null = null
  /**
   * 经函数读，别直接读变量。
   * 直接读的话 TypeScript 会顺着 `lastPush = null` 一路把类型收窄成 never ——
   * 它看不出中间那个 await 期间 push 回调把值改掉了。
   */
  const readLastPush = () => lastPush

  const caps = new Set<Capability>(['pause', 'volume', 'screenshot', 'record'])
  if (hasGamepadApi()) caps.add('gamepad')

  const host = document.createElement('div')
  host.style.cssText = 'width:100%;height:100%;background:#000'
  container.appendChild(host)

  void (async () => {
    try {
      // js-dos 本体（js-dos.js + wdosbox.wasm）由 loadJsDos() 用 <script> 拉，
      // 没有进度回调可用，只能先报个阶段；ROM 那一路是我们自己 fetch 的，有真实字节数
      options.onProgress?.({ phase: 'engine' })
      const [Dos, rom] = await Promise.all([loadJsDos(), readRom(options.game, options.onProgress)])
      options.onProgress?.({ phase: 'starting', ratio: 1 })
      if (destroyed) return

      // 普通 zip / exe 现场打成 bundle；已经是 bundle 的原样使用
      // 后台指定了启动程序就按它生成 conf，压过 pickExecutable 的猜测；
      // ROM 本身已是 .jsdos bundle 时整包原样直通，这个覆盖不生效（bundle 里自带 conf）
      const bundle = makeJsdosBundle(
        rom.name,
        rom.buf,
        options.dosExecutable ? buildDosboxConf(options.dosExecutable) : undefined,
      )
      objectUrl = URL.createObjectURL(bundle.blob)

      /**
       * 存档的归档键。
       *
       * ⚠️ 这一步是必须的：js-dos 默认拿 `url + '.changes'` 当键，而我们传进去的 url 是
       * blob URL —— 每次进游戏都重新生成一个。用默认键的话每局都是全新存档，
       * 存了也永远读不回来。所以这里换成稳定的 slug（本地文件退回文件名）。
       */
      saveKey = options.gameSlug || `local:${rom.name}`
      if (destroyed) return URL.revokeObjectURL(objectUrl)

      const ipx = options.ipx
      props = Dos(host, {
        url: objectUrl,
        // 自托管的 wasm / worker 都在这个目录下
        pathPrefix: `${JSDOS_PATH}emulators/`,
        // Windows 95/98 仍是装在磁盘镜像里的客体系统；这里切的是能启动该镜像的 DOSBox-X 核心。
        // 仅换核心不会安装 Windows，所以后台会明确要求这类游戏上传完整 .jsdos 包。
        backend: options.dosBackend === 'dosboxX' ? 'dosboxX' : 'dosbox',
        // 播放器外壳是我们自己的，平时隐藏 js-dos 那套 UI；
        // 中继联机时必须放出来，玩家要在它的设置面板里填 IPX 服务器和房间
        kiosk: !ipx?.showUi,
        autoStart: true,
        // P2P 联机：一方开服，另一方按 peer id 连过去
        startIpxServer: Boolean(ipx?.host),
        connectIpxAddress: ipx?.connectTo ?? null,
        net: {
          peerServer: JSDOS_PEER_SERVER,
          // 打不通洞时要走中继，凭据由我们后端签发
          iceServers: fetchIceServers,
        },
        imageRendering: 'pixelated',
        /**
         * 存档。js-dos 存的是**文件系统的变更包**（盘上被改过的文件），
         * 不是内存快照 —— 玩家必须先在游戏里存盘，点存档只是把这些改动固化下来。
         *
         * 三个钩子指向 services/saves.ts：登录了进云端跟着账号走，
         * 没登录就落在浏览器里。pull 会在开机时被自动调用，所以读档是无感的。
         */
        fsChanges: {
          local: true,
          urlToKey: async () => saveKey,
          pull: async () => (await pullSave('jsdos', saveKey))?.data ?? null,
          push: async (_key: string, data: Uint8Array) => {
            // 记下这次落到哪儿了，fsSave() 要拿它告诉玩家「存到云端」还是「存在浏览器里」
            lastPush = await pushSave('jsdos', saveKey, data)
          },
          delete: async () => {
            await deleteSave('jsdos', saveKey)
          },
        },
        onEvent: (event: string, arg?: unknown) => {
          if (destroyed) return
          if (event === 'emu-ready') options.onReady?.()
          else if (event === 'bnd-play' || event === 'ci-ready') {
            if (event === 'ci-ready' && arg) {
              ci = arg as DosCi
              // DOS 游戏只认键盘，手柄在这里翻译成按键
              if (caps.has('gamepad') && !pad) {
                pad = startGamepadBridge(DOS_PAD_MAP, (key, pressed) => ci?.sendKeyEvent(key, pressed))
              }
            }
            options.onStart?.()
          }
          else if (event === 'emu-error' || event === 'bnd-error') {
            options.onError?.(fmt(rt.jsdosRunFailed, { msg: String(arg ?? '') }))
          }
        },
      }) as DosProps
      // 挂载前玩家可能已经调过音量/暂停，补一次
      props.setVolume?.(volume)
      if (paused) props.setPaused?.(true)
      // 存档要等 js-dos 起来才有 props.save()，所以能力在这里才补上
      if (props.save && saveKey) caps.add('fsSave')
      options.onCaps?.(caps)
      /**
       * 兜底：万一 kiosk 模式下不触发 emu-ready，也别让转圈一直转。
       *
       * ⚠️ 不能像原来那样在这里**立刻**调 —— Dos() 一返回 DOSBox 其实还在启动，
       * 立刻调的结果是播放器马上显示「运行中」、加载提示消失，玩家对着黑屏
       * 等好几秒还以为卡死了。改成延时兜底：正常情况下 emu-ready 早就先到了。
       */
      readyFallback = window.setTimeout(() => {
        if (!destroyed) options.onReady?.()
      }, 8000)
    } catch (e) {
      if (destroyed) return
      options.onError?.(fmt(rt.jsdosLoadFailed, { msg: e instanceof Error ? e.message : String(e) }))
    }
  })()

  options.onCaps?.(caps)

  return {
    caps,
    volume,
    destroy() {
      destroyed = true
      window.clearTimeout(readyFallback)
      pad?.stop()
      pad = null
      try {
        void props?.stop()
      } catch {
        /* 已经停了就忽略 */
      }
      props = null
      ci = null
      if (objectUrl) URL.revokeObjectURL(objectUrl)
      host.remove()
    },
    setPaused(next: boolean) {
      paused = next
      // 优先用 js-dos 自己的暂停（会连带停掉声音和渲染），拿不到就退回底层接口
      if (props?.setPaused) props.setPaused(next)
      else if (next) ci?.pause()
      else ci?.resume()
    },
    setVolume(next: number) {
      volume = Math.max(0, Math.min(1, next))
      props?.setVolume?.(volume)
    },
    /**
     * 「保存进度」：让 js-dos 把盘上的改动写出去，走上面 fsChanges.push 那条路。
     * 注意这不是即时存档 —— 玩家得先在游戏里用它自己的存档功能存过盘，这里才有东西可存。
     */
    async fsSave() {
      if (!props?.save) return { ok: false }
      try {
        lastPush = null
        const ok = await props.save()
        // props.save() 只说「js-dos 那边写出去了」，真正落到云端还是浏览器
        // 是上面 push 钩子知道的
        if (!ok) return { ok: false }
        const done = readLastPush()
        return { ok: done?.ok ?? true, where: done?.where ?? undefined }
      } catch {
        return { ok: false }
      }
    },
    async screenshot() {
      // js-dos 走 WebGL，直接读画布是空白的，得用它自己的截图接口
      if (!ci) return null
      try {
        return await imageDataToBlob(await ci.screenshot())
      } catch {
        return null
      }
    },
    captureSources(): CaptureSources | null {
      // 音频在 AudioWorklet 里，外面拿不到节点，DOS 录像目前只有画面
      const canvas = host.querySelector('canvas')
      return canvas ? { canvas } : null
    },
  }
}

export const jsdosRuntime: Runtime = {
  id: 'jsdos',
  name: 'js-dos',
  get description() {
    return getT().runtime.jsdosDesc
  },
  extensions: ['jsdos', 'zip', 'exe', 'com'],
  // 高于 EmulatorJS：DOS 这类文件优先交给它
  priority: 25,
  available: () => true,
  supports: (platform) => platform === 'dos',
  engineLabel: () => 'DOSBox',
  mount,
}
