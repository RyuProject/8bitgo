/**
 * 塞班 / N-Gage：游戏详情页内嵌的 EKA2L1-WEB 播放器（点开始就玩，不用玩家自备固件）。
 *
 * 和 /symbian 程序库页的区别：那里由玩家自己导入固件、装游戏，数据存在 IndexedDB；这里每局在内存里
 * 从零装一台机器 —— 固件 ROM 来自后台的平台 BIOS（`symbian` 键），游戏来自这款游戏的 ROM 地址。
 * 下载、缓存、8BG 解包、线路回退都交给站内的 loadGameBytes；iframe 里的 play.html 只负责开机、装机、
 * 装游戏、启动和按键（public/eka2l1/v<构建>/js/8bitgo-player.js，源码 scripts/eka2l1-player.js）。
 *
 * 存档：游戏写在 C: / E: 上的文件由播放页打成一个小包，这里当作「电池存档」存本地，登录后经
 * batterySync 同步云端（emulatorjs / 游戏 slug / slot 9，和 GB / GBA 的电池存档同一套）。
 * iframe 必须同源且页面已跨源隔离（pthread 要 SharedArrayBuffer），详情页的隔离见 shared/inline-isolated-platforms.js。
 */
import type { Capability, CaptureSources, MountOptions, PadButton, RuntimeHandle } from '../types'
import { EKA2L1_RUNTIME_DIR } from '../eka2l1Runtime'
import { loadGameBytes } from '../romLoader'
import { romCacheKey } from '../romCache'
import { focusFrame } from '../frameFocus'
import { canvasToBlob } from '../recorder'
import { startGamepadInput } from '../gamepadInput'
import { batteryHash, createBatterySync, type BatteryFs, type BatterySync } from '../batterySync'
import { probeRom } from '@/services/roms'
import { fmt, getT } from '@/services/i18n'
import { diagLog, watchFramePerformance } from '@/services/startupDiagnostics'

const SAVE_KEY_PREFIX = '8bitgo.eka2l1.save.v1:'
/** localStorage 里存 base64，单款游戏给到约 1.5MB；存档包本身上限 2MB（播放页 MAX_ARCHIVE_BYTES） */
const MAX_LOCAL_SAVE_CHARS = 2_100_000
const MAX_FIRMWARE_BYTES = 128 * 1024 * 1024
const MAX_GAME_BYTES = 256 * 1024 * 1024
const FRAME_READY_TIMEOUT_MS = 60_000
const AUTOSAVE_MS = 30_000
const PAD_BUTTONS: PadButton[] = ['up', 'down', 'left', 'right', 'a', 'b', 'select', 'start']

interface PlayerStartResult {
  uid: number
  name: string
  width: number
  height: number
  restored: number
}

interface PlayerApi {
  /** 核心资源与 ROM/固件并行准备；同一 iframe 内保证只启动一次。 */
  prepare(onActivity?: () => void): Promise<void>
  cancelBoot(): void
  start(opts: {
    firmware: ArrayBuffer
    game: ArrayBuffer
    gameName: string
    save?: Uint8Array | null
    onStage?: (stage: string, info: Record<string, number | string>) => void
    onGeometry?: (geometry: { width: number; height: number }) => void
    onAssetConsumed?: (asset: 'firmware' | 'game') => void
  }): Promise<PlayerStartResult>
  saveArchive(): Uint8Array | null
  setPaused(paused: boolean): void
  setVolume(volume: number): void
  pressPad(button: PadButton, down: boolean): void
  releaseAll(): void
  canvas: HTMLCanvasElement | null
}

interface PlayerWindow extends Window {
  EightBitGoSymbianPlayer?: PlayerApi
}

/** 播放页抛出的错误（跨 realm，不能用 instanceof） */
interface PlayerErrorLike {
  name?: string
  code?: string
  detail?: string
  scope?: 'runtime' | 'content' | 'config' | 'deterministic' | 'network'
  message?: string
}

function toBase64(bytes: Uint8Array): string {
  let binary = ''
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  }
  return btoa(binary)
}

function fromBase64(text: string): Uint8Array {
  const binary = atob(text)
  const out = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i)
  return out
}

/** 本机那份存档：一个路径、一个 localStorage 键。batterySync 只认 /data/saves 下的单个文件 */
function makeSaveStore(key: string, path: string) {
  const read = (): Uint8Array | null => {
    try {
      const stored = localStorage.getItem(key)
      return stored ? fromBase64(stored) : null
    } catch {
      return null
    }
  }
  const write = (bytes: Uint8Array): boolean => {
    try {
      const encoded = toBase64(bytes)
      if (encoded.length > MAX_LOCAL_SAVE_CHARS) return false
      localStorage.setItem(key, encoded)
      return true
    } catch {
      return false
    }
  }
  const fs: BatteryFs = {
    analyzePath: (p) => ({ exists: p === path && read() !== null }),
    readFile: (p) => {
      const bytes = p === path ? read() : null
      if (!bytes) throw new Error('ENOENT')
      return bytes
    },
    writeFile: (p, data) => {
      if (p === path) write(data)
    },
    mkdir: () => {},
  }
  return { fs, read, write }
}

function saveFileName(slug: string): string {
  return slug.replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 80) || 'game'
}

export function mount(container: HTMLElement, options: MountOptions): RuntimeHandle {
  const rt = getT().runtime
  const caps = new Set<Capability>()
  const aborter = new AbortController()
  let destroyed = false
  let failed = false
  let ready = false
  let api: PlayerApi | null = null
  let volume = 1
  let autosaveTimer = 0
  let lastSaveHash = ''
  let gamepad: ReturnType<typeof startGamepadInput> | null = null
  let stopFrameWatch: (() => void) | null = null
  let cancelFrameWait: (() => void) | null = null

  const iframe = document.createElement('iframe')
  iframe.title = `${options.gameName} · EKA2L1`
  iframe.tabIndex = 0
  iframe.style.cssText = 'width:100%;height:100%;border:0;display:block;background:#000'
  iframe.referrerPolicy = 'same-origin'
  iframe.setAttribute('allow', 'autoplay; fullscreen; gamepad; cross-origin-isolated')
  iframe.setAttribute('sandbox', 'allow-scripts allow-same-origin allow-pointer-lock allow-forms')

  const stopFrame = () => {
    cancelFrameWait?.()
    cancelFrameWait = null
    try { api?.cancelBoot() } catch { /* 尚未创建核心或 iframe 已退出 */ }
    try { api?.releaseAll() } catch { /* iframe 已拆 */ }
    stopFrameWatch?.()
    stopFrameWatch = null
    api = null
    iframe.src = 'about:blank'
    iframe.remove()
  }

  const fail = (message: string, scope: 'runtime' | 'content' | 'config' | 'deterministic' | 'network') => {
    if (destroyed || failed) return
    failed = true
    aborter.abort()
    stopFrame()
    diagLog('adapter', 'error', `EKA2L1：${message}`)
    options.onError?.(message, scope)
  }

  const describe = (error: unknown): { message: string; scope: 'runtime' | 'content' | 'config' | 'deterministic' | 'network' } => {
    const err = (error ?? {}) as PlayerErrorLike
    if (err.name === 'PlayerError') {
      const detail = err.detail || err.code || ''
      switch (err.code) {
        case 'needs-s60v3': return { message: rt.eka2l1NeedsS60v3, scope: 'config' }
        case 'unknown-package':
        case 'card-invalid':
        case 'no-app': return { message: detail && err.code !== 'unknown-package' ? fmt(rt.eka2l1LoadFailed, { msg: detail }) : rt.eka2l1UnknownPackage, scope: 'content' }
        case 'install-failed': return { message: fmt(rt.eka2l1LoadFailed, { msg: detail }), scope: 'content' }
        case 'device-failed': return { message: fmt(rt.eka2l1LoadFailed, { msg: detail }), scope: 'config' }
        case 'environment': return { message: fmt(rt.eka2l1LoadFailed, { msg: detail }), scope: 'config' }
        case 'app-exited': return { message: fmt(rt.eka2l1AppExited, { detail }), scope: 'deterministic' }
        case 'first-frame-timeout': return { message: rt.eka2l1StartTimeout, scope: 'runtime' }
        default: return { message: fmt(rt.eka2l1LoadFailed, { msg: err.message || detail }), scope: err.scope || 'runtime' }
      }
    }
    const message = (error instanceof Error ? error.message : String(error)) || 'unknown'
    if (error instanceof TypeError) return { message: fmt(rt.eka2l1LoadFailed, { msg: message }), scope: 'network' }
    if (error instanceof RangeError) return { message: fmt(rt.eka2l1LoadFailed, { msg: message }), scope: 'content' }
    return { message: fmt(rt.eka2l1LoadFailed, { msg: message }), scope: 'runtime' }
  }

  // ---- 存档 ----
  const slug = options.gameSlug || ''
  const savePath = `/data/saves/eka2l1/${saveFileName(slug)}.ngsav`
  const store = slug ? makeSaveStore(`${SAVE_KEY_PREFIX}${slug}`, savePath) : null
  const remoteSave = typeof options.game === 'string' && Boolean(slug) && !slug.startsWith('local:')
  const sync: BatterySync | null = remoteSave && store ? createBatterySync(slug) : null

  const persistSave = (): Promise<unknown> => {
    if (!ready || !api || !store) return Promise.resolve()
    let archive: Uint8Array | null = null
    try {
      const fromFrame = api.saveArchive()
      archive = fromFrame ? new Uint8Array(fromFrame) : null
    } catch (error) {
      diagLog('adapter', 'warn', `EKA2L1 存档打包失败：${error instanceof Error ? error.message : String(error)}`)
      return Promise.resolve()
    }
    if (!archive) return Promise.resolve()
    const hash = batteryHash(archive)
    if (hash === lastSaveHash) return Promise.resolve()
    lastSaveHash = hash
    if (!store.write(archive)) diagLog('adapter', 'warn', `EKA2L1 存档 ${archive.length} 字节，超出本机存储上限`)
    return sync ? sync.push(store.fs, savePath, 'eka2l1') : Promise.resolve()
  }

  const onVisibility = () => {
    if (document.visibilityState === 'hidden') void persistSave()
  }
  const onPageHide = () => { void persistSave() }

  const pressPad = (button: PadButton, down: boolean) => {
    if (ready) api?.pressPad(button, down)
  }

  // ---- 启动 ----
  if (!EKA2L1_RUNTIME_DIR) {
    queueMicrotask(() => fail(fmt(rt.eka2l1LoadFailed, { msg: 'runtime missing' }), 'config'))
  } else if (typeof SharedArrayBuffer === 'undefined' || !globalThis.crossOriginIsolated) {
    queueMicrotask(() => fail(rt.eka2l1NeedsIsolation, 'config'))
  } else if (!options.biosUrl) {
    queueMicrotask(() => fail(rt.eka2l1NoFirmware, 'config'))
  } else {
    const biosUrl = options.biosUrl
    options.onProgress?.({ phase: 'engine', loaded: 0 })
    iframe.src = `${EKA2L1_RUNTIME_DIR}play.html`
    container.appendChild(iframe)

    const frameReady = new Promise<PlayerApi>((resolve, reject) => {
      let settled = false
      const clearWait = () => {
        window.clearTimeout(timer)
        cancelFrameWait = null
      }
      const timer = window.setTimeout(() => {
        if (settled) return
        settled = true
        cancelFrameWait = null
        reject(new Error('play.html did not load'))
      }, FRAME_READY_TIMEOUT_MS)
      cancelFrameWait = () => {
        if (settled) return
        settled = true
        clearWait()
        reject(new DOMException('已取消', 'AbortError'))
      }
      iframe.addEventListener('load', () => {
        if (settled || destroyed || failed) return
        settled = true
        clearWait()
        // 核心 wasm / data 在 iframe 里下载，诊断包要看得到这些请求
        stopFrameWatch = watchFramePerformance(iframe.contentWindow)
        const player = (iframe.contentWindow as PlayerWindow | null)?.EightBitGoSymbianPlayer
        if (player) resolve(player)
        else reject(new Error('play.html is missing the player script'))
      }, { once: true })
      iframe.addEventListener('error', () => {
        if (settled) return
        settled = true
        clearWait()
        reject(new Error('play.html failed to load'))
      }, { once: true })
    })
    // 平台固件绑定通常只有对象 key，没有 ETag 版本号；先用有时限的 HEAD 取内容版本，
    // 后续同一固件可命中 ROM IndexedDB 缓存并安全续传。探测失败仍沿原 URL 下载，不能让 HEAD 限制可玩性。
    const stableFirmwareUrl = romCacheKey(biosUrl)
      ? Promise.resolve(biosUrl)
      : probeRom(biosUrl, 4_000, false, { signal: aborter.signal, retry: false })
          .then((outcome) => romCacheKey(outcome.url) ? outcome.url : biosUrl)
          .catch(() => biosUrl)
    const firmwareLoad = stableFirmwareUrl.then((url) => loadGameBytes(
      url,
      (progress) => options.onProgress?.({ ...progress, phase: 'assets' }),
      aborter.signal,
      { maxBytes: MAX_FIRMWARE_BYTES, maxUnpackedBytes: MAX_FIRMWARE_BYTES },
    ))
    const gameLoad = loadGameBytes(options.game, options.onProgress, aborter.signal, {
      maxBytes: MAX_GAME_BYTES,
      maxUnpackedBytes: MAX_GAME_BYTES,
    }, options.onRomLoadStart)
    // 云端那份和下载并行拉；batterySync.apply 自带超时、永不抛错
    const seeded = sync && store ? sync.apply(store.fs) : Promise.resolve('off')
    // 核心的 wasm/data 下载与编译也和 ROM、固件并行；原先必须等两份游戏资源到齐才调用 start()，
    // 使弱网玩家把核心冷启动完整地排在 ROM 下载之后。核心资源空闲超时 / 短包会自行重试。
    const preparedPlayer = frameReady.then((player) => {
      if (destroyed || failed) throw new DOMException('已取消', 'AbortError')
      api = player
      return player.prepare(() => {
        if (!destroyed && !failed) options.onStartupActivity?.()
      }).then(() => player)
    })

    void (async () => {
      try {
        const [player, firmware, game, decision] = await Promise.all([preparedPlayer, firmwareLoad, gameLoad, seeded])
        if (destroyed) return
        api = player
        const save = store?.read() ?? null
        if (save) lastSaveHash = batteryHash(save)
        diagLog('adapter', 'info', `EKA2L1：固件 ${firmware.data.byteLength} 字节，游戏 ${game.data.byteLength} 字节，存档 ${save ? save.length : 0} 字节（${decision}）`)
        options.onProgress?.({ phase: 'starting', startup: 0 })
        const stageWeight: Record<string, number> = { boot: 0.05, install: 0.45, device: 0.55, launch: 0.7, 'first-frame': 0.75 }
        const result = await player.start({
          firmware: firmware.data,
          game: game.data,
          gameName: options.gameName,
          save,
          onStage(stage, info) {
            if (destroyed) return
            let startup = stageWeight[stage] ?? 0.5
            if (stage === 'boot') startup = 0.05 + 0.35 * Math.min(1, Number(info.pct || 0) / 100)
            if (stage === 'first-frame') startup = 0.75 + 0.24 * Math.min(1, Number(info.elapsed || 0) / 60_000)
            options.onProgress?.({ phase: 'starting', startup })
            options.onStartupActivity?.()
          },
          onGeometry: (geometry) => options.onGeometry?.(geometry),
          // EKA2L1 已把固件 / 安装包复制进本局虚拟盘后，释放下载缓冲；手机不必把整份 ROM 再留到首帧。
          onAssetConsumed(asset) {
            if (asset === 'firmware') firmware.data = new ArrayBuffer(0)
            else game.data = new ArrayBuffer(0)
          },
        })
        if (destroyed) return
        ready = true
        caps.add('pause')
        caps.add('volume')
        caps.add('gamepad')
        caps.add('touchpad')
        if (player.canvas) {
          caps.add('screenshot')
          if (typeof MediaRecorder !== 'undefined') caps.add('record')
        }
        player.setVolume(volume)
        gamepad = startGamepadInput(pressPad)
        autosaveTimer = window.setInterval(() => { void persistSave() }, AUTOSAVE_MS)
        document.addEventListener('visibilitychange', onVisibility)
        window.addEventListener('pagehide', onPageHide)
        diagLog('adapter', 'info', `EKA2L1：已启动 ${result.name}（0x${result.uid.toString(16)}），写回存档 ${result.restored} 个文件`)
        options.onGeometry?.({ width: result.width, height: result.height })
        options.onReady?.()
        focusFrame(iframe)
      } catch (error) {
        if (destroyed) return
        const { message, scope } = describe(error)
        fail(message, scope)
      }
    })()
  }

  return {
    caps,
    padButtons: PAD_BUTTONS,
    sendButton: pressPad,
    setPaused(paused: boolean) {
      if (ready) api?.setPaused(paused)
    },
    get volume() {
      return volume
    },
    setVolume(next: number) {
      volume = Math.max(0, Math.min(1, next))
      if (ready) api?.setVolume(volume)
    },
    async screenshot() {
      const canvas = api?.canvas
      return canvas ? canvasToBlob(canvas) : null
    },
    captureSources(): CaptureSources | null {
      const canvas = api?.canvas
      return canvas ? { canvas } : null
    },
    focus() {
      focusFrame(iframe)
    },
    destroy() {
      if (destroyed) return
      // 先存最后一次，再停：推送是异步的，停掉同步要等它发出去
      const finalPush = persistSave()
      destroyed = true
      aborter.abort()
      window.clearInterval(autosaveTimer)
      document.removeEventListener('visibilitychange', onVisibility)
      window.removeEventListener('pagehide', onPageHide)
      gamepad?.stop()
      gamepad = null
      try { api?.releaseAll() } catch { /* iframe 已拆 */ }
      void Promise.resolve(finalPush).finally(() => sync?.stop())
      stopFrame()
    },
  }
}
