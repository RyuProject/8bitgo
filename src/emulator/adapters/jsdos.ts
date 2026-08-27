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
import type { MountOptions, Runtime } from '../types'
import { getT, fmt } from '@/services/i18n'
import { makeJsdosBundle } from '@/lib/jsdosBundle'

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

type DosProps = { stop: () => Promise<void> | void }
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

async function readRom(game: File | string): Promise<{ name: string; buf: ArrayBuffer }> {
  if (typeof game !== 'string') return { name: game.name, buf: await game.arrayBuffer() }
  const res = await fetch(game)
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return { name: game.split(/[?#]/)[0].split('/').pop() || 'game.zip', buf: await res.arrayBuffer() }
}

function mount(container: HTMLElement, options: MountOptions): () => void {
  const rt = getT().runtime
  let destroyed = false
  let props: DosProps | null = null
  let objectUrl = ''

  const host = document.createElement('div')
  host.style.cssText = 'width:100%;height:100%;background:#000'
  container.appendChild(host)

  void (async () => {
    try {
      const [Dos, rom] = await Promise.all([loadJsDos(), readRom(options.game)])
      if (destroyed) return

      // 普通 zip / exe 现场打成 bundle；已经是 bundle 的原样使用
      const bundle = makeJsdosBundle(rom.name, rom.buf)
      objectUrl = URL.createObjectURL(bundle.blob)
      if (destroyed) return URL.revokeObjectURL(objectUrl)

      const ipx = options.ipx
      props = Dos(host, {
        url: objectUrl,
        // 自托管的 wasm / worker 都在这个目录下
        pathPrefix: `${JSDOS_PATH}emulators/`,
        backend: 'dosbox',
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
        onEvent: (event: string, arg?: unknown) => {
          if (destroyed) return
          if (event === 'emu-ready') options.onReady?.()
          else if (event === 'bnd-play' || event === 'ci-ready') options.onStart?.()
          else if (event === 'emu-error' || event === 'bnd-error') {
            options.onError?.(fmt(rt.jsdosRunFailed, { msg: String(arg ?? '') }))
          }
        },
      })
      // 兜底：万一 kiosk 模式下不触发 emu-ready，也别让转圈一直转
      options.onReady?.()
    } catch (e) {
      if (destroyed) return
      options.onError?.(fmt(rt.jsdosLoadFailed, { msg: e instanceof Error ? e.message : String(e) }))
    }
  })()

  return () => {
    destroyed = true
    try {
      void props?.stop()
    } catch {
      /* 已经停了就忽略 */
    }
    props = null
    if (objectUrl) URL.revokeObjectURL(objectUrl)
    host.remove()
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
