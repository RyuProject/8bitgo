/**
 * IodineGBA：GBA 在禁用 WebAssembly 浏览器中的备用运行时。
 *
 * 上游核心是纯 JavaScript、固定画布 240×160，并要求 16 KiB GBA BIOS。这里提供本站的
 * ROM / BIOS 读取、画面、音频、键盘 / 手柄和电池存档桥；即时存档格式上游没有实现，
 * 因此不冒充支持 F2 / 云端快照，也不写 EmulatorJS 的存档槽。
 *
 * 2026-11-15 实测（M 系列 Mac、Chromium 153，《高级战争》《火红》《马里奥赛车》《缩小帽》）：
 * - 只删掉 WebAssembly、JIT 照常：四款都稳定 100% 速度。
 * - `--js-flags=--jitless`（Edge 增强安全性 / Chrome 关掉 JS 优化器的样子）：只有 12～20%，
 *   这种环境下核心能跑但慢到没法玩，所以测出来就在画面上说明原因（见 SLOW_*）。
 * - 站内没有绑定官方 GBA BIOS，以前一律报「请先在后台配置 GBA 平台 BIOS」，整个退路其实没法用；
 *   现在没配就用随站发布的 MIT 开源替代 BIOS（vendor/iodinegba/UPSTREAM.md）。
 * - 开源 BIOS 的开机动画在 IodineGBA 里走不完（PC 卡在 0x100 附近、画面一直强制空白 = 白屏），
 *   所以一律 SKIPBoot：BIOS 只负责 SWI 调用。官方 BIOS 跳过开机也没有副作用，还省两三秒。
 * - 上游按音频缓冲水位决定每轮跑多少周期；AudioContext 还没解锁（iOS / Safari 未点过画面）时缓冲
 *   永远是满的，核心会被压到 0% —— 只要声音没起来就不能让它参与调速。
 */
import { batterySaveGameName } from '../ejsSaveFs'
import { canvasToBlob } from '../recorder'
import { loadGameBytes } from '../romLoader'
import { readGamepadsSafe } from '../gamepadAccess'
import { gamepadPadState } from '../gamepadInput'
import { installPadKeyboard } from '../padKeyboard'
import type { Capability, CaptureSources, MountOptions, PadButton, RuntimeHandle } from '../types'
import { isZip, extractRomFromZip } from '@/lib/unzip'
import { diagLog } from '@/services/startupDiagnostics'
import { fetchPlatformBios, platformBiosUrlSync } from '@/services/platformBios'
import { getT } from '@/services/i18n'
import { IODINEGBA_BUILD } from '../iodinegbaVersion'

const BASE = '/iodinegba'
const BIOS_BYTES = 0x4000
const MAX_ROM_BYTES = 64 * 1024 * 1024
const SAVE_KEY_PREFIX = '8bitgo.iodinegba.battery.v1:'
const SAVE_STATE_TAG = '8bitgo-iodinegba-battery-v1'
const TIMER_INTERVAL_MS = 16
/**
 * 没绑官方 BIOS 时用的开源替代 BIOS（Cult-of-GBA，MIT）。文件名固定、内容不变，SHA-256 前 16 位当版本参数，
 * 让它走长期缓存；换 BIOS 版本必须同时换文件内容和这里的摘要（npm run test:iodinegba 会核对）。
 */
export const OPEN_GBA_BIOS_SHA256 = '61af6e8c2db6cf24aa6924e8133f6a50833158fca33ff08ea5e11e1a06e132f2'
export const OPEN_GBA_BIOS_URL = `${BASE}/gba-bios-cult-of-gba.bin?v=${OPEN_GBA_BIOS_SHA256.slice(0, 16)}`
/** 上游每 500ms 报一次速度百分比；连续这么多次低于阈值才算「这个浏览器跑不动」，避开开局编译与加载的抖动。 */
const SLOW_SPEED_PERCENT = 70
const SLOW_SPEED_REPORTS = 8
/** 等后台 BIOS 映射的上限；超时就当没配，用开源 BIOS 开局 */
const BIOS_MAP_WAIT_MS = 3_000

type IodineButton = PadButton | 'l' | 'r'

interface IodineEmulator {
  settings: { SKIPBoot: boolean; offthreadGfxEnabled: boolean }
  emulatorStatus: number
  audio?: IodineAudioHandler
  IOCore?: { coreExposed?: { graphicsHandle?: unknown } } | null
  attachROM(rom: Uint8Array): void
  attachBIOS(bios: Uint8Array): void
  attachGraphicsFrameHandler(handler: { copyBuffer(buffer: ArrayLike<number>): void }): void
  attachAudioHandler(handler: IodineAudioHandler): void
  attachSaveImportHandler(handler: (name: string, found: (data: ArrayLike<number>) => void, missing: () => void) => void): void
  attachSaveExportHandler(handler: (name: string, data: ArrayLike<number>) => void): void
  attachPlayStatusHandler(handler: (status: number) => void): void
  attachSpeedHandler(handler: (percent: number) => void): void
  setIntervalRate(rate: number): void
  timerCallback(timestamp: number): void
  play(): void
  pause(): void
  exportSave(): void
  keyDown(index: number): void
  keyUp(index: number): void
}

export interface IodineAudioHandler {
  initialize(channels: number, sampleRate: number, bufferAmount: number, heartbeat: () => void, postHeartbeat: () => void, error: () => void): void
  register(): void
  unregister(): void
  push(data: Float32Array, start: number, end: number): void
  /** 上游只在返回 number 时按水位调速；返回 undefined 表示「声音没在放，别拿它调速」 */
  remainingBuffer(): number | undefined
  setBufferSpace(amount: number): void
  setVolume(volume: number): void
}

declare global {
  interface Window {
    IodineGBA?: new () => IodineEmulator
  }
}

const KEY_INDEX: Record<IodineButton, number> = {
  a: 0,
  b: 1,
  select: 2,
  start: 3,
  right: 4,
  left: 5,
  up: 6,
  down: 7,
  r: 8,
  l: 9,
}

let scriptPromise: Promise<void> | null = null

function loadIodineScript(): Promise<void> {
  if (window.IodineGBA) return Promise.resolve()
  if (!scriptPromise) {
    scriptPromise = new Promise<void>((resolve, reject) => {
      const script = document.createElement('script')
      script.async = true
      script.src = `${BASE}/iodinegba.js?v=${IODINEGBA_BUILD}`
      script.onload = () => window.IodineGBA ? resolve() : reject(new Error('IodineGBA 脚本没有导出核心'))
      script.onerror = () => reject(new Error('无法加载自托管的 IodineGBA 核心'))
      document.head.appendChild(script)
    }).catch((error: unknown) => {
      scriptPromise = null
      throw error
    })
  }
  return scriptPromise
}

function encodeBase64(bytes: Uint8Array): string {
  let binary = ''
  for (let i = 0; i < bytes.length; i += 0x4000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x4000))
  return btoa(binary)
}

function decodeBase64(value: string): Uint8Array | null {
  try {
    const binary = atob(value)
    const bytes = new Uint8Array(binary.length)
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
    return bytes
  } catch {
    return null
  }
}

function identityFor(options: MountOptions): string {
  const originalName = typeof options.game === 'string' ? options.gameName : options.game.name
  return batterySaveGameName(options.gameSlug, originalName) ?? options.gameSlug ?? `local:${originalName}`
}

/**
 * 交错立体声的环形队列：核心按源采样率（约 44.15 kHz）推入，输出端按 AudioContext 采样率线性重采样后取走。
 *
 * isRunning 为假（AudioContext 还被浏览器挂起、或玩家暂停了）时：推进来的样本直接丢掉，remainingBuffer
 * 返回 undefined。上游 audioUnderrunAdjustment 只在拿到数字时按水位调速，所以核心照常按定时器跑，
 * 不会因为一个永远不被消费的满缓冲把周期压到 0；声音起来以后从空队列开始，也不会带着几秒旧声音延迟。
 */
export function createIodineAudioQueue(outputRate: () => number, isRunning: () => boolean, capacity = 1 << 16) {
  const mask = capacity - 1
  const queue = new Float32Array(capacity)
  let read = 0
  let write = 0
  let sourceRate = 44_100
  let phase = 0
  let wasRunning = false

  const pushSample = (sample: number) => {
    if (write - read >= capacity) read++
    queue[write & mask] = sample
    write++
  }
  /** 刚从挂起恢复：丢掉挂起前残留的样本，从空队列重新累计 */
  const syncRunning = (): boolean => {
    const running = isRunning()
    if (running && !wasRunning) {
      read = write
      phase = 0
    }
    wasRunning = running
    return running
  }

  const handler: IodineAudioHandler = {
    initialize: (_channels, sampleRate) => { sourceRate = sampleRate || 44_100 },
    register: () => {},
    unregister: () => { read = write },
    push: (data, start, end) => {
      if (!syncRunning()) return
      const frames = Math.floor((end - start) / 2)
      if (frames <= 0) return
      const step = sourceRate / outputRate()
      for (let pos = phase; pos < frames; pos += step) {
        const base = Math.floor(pos)
        const next = Math.min(base + 1, frames - 1)
        const mix = pos - base
        const left = start + base * 2
        const right = left + 1
        const leftNext = start + next * 2
        const rightNext = leftNext + 1
        pushSample(data[left] + (data[leftNext] - data[left]) * mix)
        pushSample(data[right] + (data[rightNext] - data[right]) * mix)
      }
      phase = Math.max(0, phase + Math.ceil((frames - phase) / step) * step - frames)
    },
    remainingBuffer: () => (syncRunning() ? write - read : undefined),
    setBufferSpace: (amount) => {
      // 开局 / 恢复时上游会先垫一段静音稳住水位；声音没起来时垫了也没人消费，反而变成延迟
      if (!syncRunning()) return
      const target = Math.max(0, Math.min(capacity, amount | 0))
      while (write - read < target) pushSample(0)
    },
    setVolume: () => {},
  }

  /** 输出端取样（ScriptProcessor 的回调）：队列空了补静音 */
  const pull = (left: Float32Array, right: Float32Array) => {
    for (let i = 0; i < left.length; i++) {
      left[i] = read < write ? queue[read++ & mask] : 0
      right[i] = read < write ? queue[read++ & mask] : 0
    }
  }
  return { handler, pull, buffered: () => write - read }
}

function createAudioSink(): { context: AudioContext; node: ScriptProcessorNode; gain: GainNode; handler: IodineAudioHandler } | null {
  let context: AudioContext | null = null
  try {
    const AudioContextCtor = window.AudioContext ?? (window as Window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
    if (!AudioContextCtor) return null
    context = new AudioContextCtor()
    if (typeof context.createScriptProcessor !== 'function') throw new Error('ScriptProcessorNode 不可用')

    const ctx = context
    const node = ctx.createScriptProcessor(2048, 0, 2)
    const gain = ctx.createGain()
    const queue = createIodineAudioQueue(() => ctx.sampleRate, () => ctx.state === 'running')
    node.onaudioprocess = (event) => queue.pull(event.outputBuffer.getChannelData(0), event.outputBuffer.getChannelData(1))
    node.connect(gain)
    gain.connect(ctx.destination)

    const handler: IodineAudioHandler = {
      ...queue.handler,
      setVolume: (volume) => { gain.gain.value = Math.max(0, Math.min(1, volume)) },
    }
    return { context: ctx, node, gain, handler }
  } catch {
    if (context && context.state !== 'closed') void context.close().catch(() => {})
    return null
  }
}

/**
 * 关了 JIT 的浏览器里核心只有十几二十的速度。不提示的话玩家只看到「慢动作」，以为是网站卡；
 * 在画面底部说清楚原因和办法，可以关掉。
 */
function showSlowNotice(surface: HTMLElement, percent: number): void {
  if (surface.querySelector('[data-iodinegba-slow]')) return
  const bar = document.createElement('div')
  bar.setAttribute('data-iodinegba-slow', '')
  bar.setAttribute('role', 'status')
  bar.style.cssText = 'position:absolute;z-index:6;left:8px;right:8px;bottom:8px;display:flex;gap:8px;align-items:flex-start;padding:8px 10px;border-radius:8px;background:rgba(0,0,0,.78);color:#fff;font:12px/1.5 system-ui,sans-serif'
  const text = document.createElement('span')
  text.style.flex = '1'
  text.textContent = getT().runtime.iodinegbaSlow.replace('{percent}', String(Math.round(percent)))
  const close = document.createElement('button')
  close.type = 'button'
  close.textContent = '×'
  close.setAttribute('aria-label', getT().common.close)
  close.style.cssText = 'border:0;background:transparent;color:#fff;font:16px/1 sans-serif;cursor:pointer;padding:0 2px'
  close.addEventListener('click', () => bar.remove())
  bar.append(text, close)
  surface.appendChild(bar)
}

class IodineStartupError extends Error {
  readonly scope: 'content' | 'config' | 'runtime'

  constructor(message: string, scope: 'content' | 'config' | 'runtime') {
    super(message)
    this.scope = scope
  }
}

export function mount(container: HTMLElement, options: MountOptions): RuntimeHandle {
  if (typeof WebAssembly === 'undefined') diagLog('adapter', 'info', '浏览器没有 WebAssembly，GBA 改用纯 JavaScript 的 IodineGBA')
  const aborter = new AbortController()
  const caps = new Set<Capability>(['pause', 'screenshot', 'record', 'gamepad', 'touchpad'])
  const surface = document.createElement('div')
  surface.style.cssText = 'position:relative;width:100%;height:100%;display:flex;align-items:center;justify-content:center;background:#000;overflow:hidden'
  const canvas = document.createElement('canvas')
  canvas.width = 240
  canvas.height = 160
  canvas.style.cssText = 'display:block;width:100%;height:100%;max-width:100%;max-height:100%;object-fit:contain;image-rendering:pixelated;touch-action:none'
  surface.appendChild(canvas)
  container.appendChild(surface)

  const context2d = canvas.getContext('2d', { alpha: false })
  const image = context2d?.createImageData(240, 160) ?? null
  const audio = createAudioSink()
  if (audio) caps.add('volume')

  let destroyed = false
  let paused = false
  let engine: IodineEmulator | null = null
  let timer = 0
  let saveTimer = 0
  let gamepadRaf = 0
  let firstFrame = false
  let uninstallKeyboard: (() => void) | null = null
  let batteryData: Uint8Array | null = null
  let batteryType = 0
  let batteryKey = ''
  let lastBatteryRecord = ''
  let unlockAudio: (() => void) | null = null
  const held = new Set<IodineButton>()
  const gamepadHeld = new Set<IodineButton>()

  try {
    batteryKey = `${SAVE_KEY_PREFIX}${encodeURIComponent(identityFor(options))}`
    const raw = localStorage.getItem(batteryKey)
    if (raw) {
      const parsed = JSON.parse(raw) as { tag?: string; data?: string; type?: number }
      if (parsed.tag === SAVE_STATE_TAG && typeof parsed.data === 'string' && Number.isInteger(parsed.type)) {
        batteryData = decodeBase64(parsed.data)
        batteryType = Math.max(0, Math.min(3, parsed.type ?? 0))
      }
    }
  } catch {
    // 隐私模式或损坏的本地值不应挡住游戏启动。
  }

  const persistBattery = () => {
    if (!batteryData?.length || !batteryKey) return
    try {
      const data = encodeBase64(batteryData)
      const record = `${batteryType}:${data}`
      if (record === lastBatteryRecord) return
      localStorage.setItem(batteryKey, JSON.stringify({ tag: SAVE_STATE_TAG, data, type: batteryType }))
      lastBatteryRecord = record
    } catch {
      // 浏览器不允许持久化时，核心仍能继续玩。
    }
  }

  const setKey = (button: IodineButton, down: boolean) => {
    if (!engine || destroyed || held.has(button) === down) return
    if (down) held.add(button)
    else held.delete(button)
    const index = KEY_INDEX[button]
    if (down) engine.keyDown(index)
    else engine.keyUp(index)
  }

  const commonPad = (button: PadButton, down: boolean) => setKey(button, down)
  const stopGamepad = () => {
    if (gamepadRaf) cancelAnimationFrame(gamepadRaf)
    gamepadRaf = 0
    for (const button of gamepadHeld) setKey(button, false)
    gamepadHeld.clear()
  }

  const pollGamepad = () => {
    if (destroyed) return
    try {
      const pads = Array.from(readGamepadsSafe(navigator))
      const next = new Set<IodineButton>(gamepadPadState(pads))
      for (const pad of pads) {
        if (!pad?.connected || pad.mapping !== 'standard') continue
        if (pad.buttons[4]?.pressed || pad.buttons[6]?.pressed) next.add('l')
        if (pad.buttons[5]?.pressed || pad.buttons[7]?.pressed) next.add('r')
      }
      const all: IodineButton[] = ['a', 'b', 'select', 'start', 'up', 'down', 'left', 'right', 'l', 'r']
      for (const button of all) {
        const want = next.has(button)
        if (want === gamepadHeld.has(button)) continue
        if (want) gamepadHeld.add(button)
        else gamepadHeld.delete(button)
        setKey(button, want)
      }
    } catch {
      // 读取手柄失败时保留上一帧按键，下一帧再重试。
    }
    gamepadRaf = requestAnimationFrame(pollGamepad)
  }

  const updateBattery = () => {
    if (!engine) return
    try {
      engine.exportSave()
      persistBattery()
    } catch (error) {
      diagLog('adapter', 'warn', `IodineGBA 导出游戏内存档失败：${error instanceof Error ? error.message : String(error)}`)
    }
  }

  const startClock = () => {
    if (timer || paused || !engine || destroyed) return
    timer = window.setInterval(() => {
      if (!engine || destroyed || paused) return
      try {
        engine.timerCallback(performance.now() >>> 0)
      } catch (error) {
        fail(new Error(`IodineGBA 运行中断：${error instanceof Error ? error.message : String(error)}`))
      }
    }, TIMER_INTERVAL_MS)
  }

  function stopClock() {
    if (timer) window.clearInterval(timer)
    timer = 0
  }

  const onVisibilityChange = () => {
    if (document.visibilityState === 'hidden') updateBattery()
  }
  const onPageHide = () => updateBattery()

  const extraKeysDown = (event: KeyboardEvent) => {
    if (event.code !== 'KeyQ' && event.code !== 'KeyE') return
    if (event.target instanceof HTMLElement && /^(INPUT|TEXTAREA|SELECT)$/.test(event.target.tagName)) return
    event.preventDefault()
    setKey(event.code === 'KeyQ' ? 'l' : 'r', true)
  }
  const extraKeysUp = (event: KeyboardEvent) => {
    if (event.code === 'KeyQ') setKey('l', false)
    else if (event.code === 'KeyE') setKey('r', false)
  }

  if (typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches) {
    const shoulders = document.createElement('div')
    shoulders.style.cssText = 'position:absolute;z-index:5;left:8px;right:8px;top:8px;display:flex;justify-content:space-between;pointer-events:none'
    for (const button of ['l', 'r'] as const) {
      const control = document.createElement('button')
      control.type = 'button'
      control.textContent = button.toUpperCase()
      control.setAttribute('aria-label', button === 'l' ? 'GBA L' : 'GBA R')
      control.style.cssText = 'pointer-events:auto;touch-action:none;width:52px;height:32px;border:1px solid rgba(255,255,255,.4);border-radius:8px;background:rgba(0,0,0,.55);color:#fff;font:600 13px sans-serif'
      control.addEventListener('pointerdown', (event) => {
        event.preventDefault()
        control.setPointerCapture(event.pointerId)
        setKey(button, true)
      })
      const release = () => setKey(button, false)
      control.addEventListener('pointerup', release)
      control.addEventListener('pointercancel', release)
      control.addEventListener('lostpointercapture', release)
      shoulders.appendChild(control)
    }
    surface.appendChild(shoulders)
  }

  const destroy = () => {
    if (destroyed) return
    aborter.abort()
    stopClock()
    if (saveTimer) window.clearInterval(saveTimer)
    saveTimer = 0
    stopGamepad()
    uninstallKeyboard?.()
    uninstallKeyboard = null
    window.removeEventListener('keydown', extraKeysDown, true)
    window.removeEventListener('keyup', extraKeysUp, true)
    document.removeEventListener('visibilitychange', onVisibilityChange)
    window.removeEventListener('pagehide', onPageHide)
    if (unlockAudio) {
      window.removeEventListener('pointerdown', unlockAudio, true)
      window.removeEventListener('keydown', unlockAudio, true)
      window.removeEventListener('touchend', unlockAudio, true)
      unlockAudio = null
    }
    updateBattery()
    destroyed = true
    if (engine) {
      try { engine.pause() } catch { /* 退出清理不再影响播放器 */ }
      engine.attachSaveExportHandler(() => {})
      engine.attachSaveImportHandler((_name, _found, missing) => missing())
      if (engine.IOCore?.coreExposed) engine.IOCore.coreExposed.graphicsHandle = null
      engine.audio = undefined
      engine.IOCore = null
      engine = null
    }
    audio?.node.disconnect()
    audio?.gain.disconnect()
    if (audio?.context.state !== 'closed') void audio?.context.close().catch(() => {})
    surface.remove()
  }

  const fail = (error: unknown) => {
    if (destroyed) return
    const message = error instanceof Error ? error.message : String(error)
    const scope = error instanceof IodineStartupError ? error.scope : 'runtime'
    options.onError?.(message, scope)
    destroy()
  }

  options.onProgress?.({ phase: 'engine' })
  options.onCaps?.(caps)
  void (async () => {
    try {
      if (!context2d || !image) throw new IodineStartupError('这个浏览器无法创建 Canvas 2D 画布。', 'config')
      let biosUrl = options.biosUrl || platformBiosUrlSync(options.platform)
      if (!biosUrl) {
        // 播放器可能先于 BIOS 映射接口返回而挂载；等一次共享请求，后台确实绑了官方 BIOS 就用它（兼容性更好）。
        // 接口失败或慢都不能挡住开局：最多等 BIOS_MAP_WAIT_MS，下面照样有开源 BIOS 兜底。
        // （本地实测这个接口 502 / 慢时整局停在「正在准备模拟器 14%」。）
        let waitTimer: ReturnType<typeof setTimeout> | undefined
        await Promise.race([
          fetchPlatformBios().catch(() => undefined),
          new Promise<void>((resolve) => { waitTimer = setTimeout(resolve, BIOS_MAP_WAIT_MS) }),
        ])
        // race 结束就清掉定时器：不清的话快的那次返回后它还在跑（§2.8.0.1 第十二节的教训）
        clearTimeout(waitTimer)
        if (destroyed) return
        biosUrl = platformBiosUrlSync(options.platform)
      }
      if (!biosUrl) {
        biosUrl = OPEN_GBA_BIOS_URL
        diagLog('adapter', 'info', 'IodineGBA：后台没有配置 GBA BIOS，使用随站发布的开源替代 BIOS（Cult-of-GBA，MIT）')
      }
      const [loaded, bios] = await Promise.all([
        loadGameBytes(options.game, options.onProgress, aborter.signal, { maxBytes: MAX_ROM_BYTES, maxUnpackedBytes: MAX_ROM_BYTES }),
        loadGameBytes(biosUrl, undefined, aborter.signal, { maxBytes: 2 * 1024 * 1024, maxUnpackedBytes: 2 * 1024 * 1024 }),
      ])
      if (destroyed) return
      let rom = loaded.data
      if (isZip(rom)) {
        const extracted = await extractRomFromZip(rom, ['gba', 'agb', 'bin'])
        if (destroyed) return
        rom = extracted.data.buffer.slice(extracted.data.byteOffset, extracted.data.byteOffset + extracted.data.byteLength) as ArrayBuffer
      }
      if (rom.byteLength < 0x100 || rom.byteLength > MAX_ROM_BYTES) {
        throw new IodineStartupError('GBA ROM 长度不合法，或压缩包里没有可识别的 .gba 游戏文件。', 'content')
      }
      let biosBytes = bios.data
      if (isZip(biosBytes)) {
        try {
          const extracted = await extractRomFromZip(biosBytes, ['bin', 'bios', 'gba'])
          if (destroyed) return
          biosBytes = extracted.data.buffer.slice(extracted.data.byteOffset, extracted.data.byteOffset + extracted.data.byteLength) as ArrayBuffer
        } catch {
          throw new IodineStartupError('GBA BIOS 压缩包内没有可识别的 .bin / .bios 文件。', 'config')
        }
      }
      if (biosBytes.byteLength !== BIOS_BYTES) {
        throw new IodineStartupError(`GBA BIOS 大小必须为 16 KiB，当前为 ${biosBytes.byteLength} 字节。`, 'config')
      }
      const Core = await loadIodineScript().then(() => window.IodineGBA)
      if (!Core) throw new Error('IodineGBA 核心未能初始化')
      if (destroyed) return
      const instance = new Core()
      instance.settings.offthreadGfxEnabled = false
      // 开源 BIOS 的开机动画在 IodineGBA 里走不完（白屏），官方 BIOS 跳过也无副作用：一律直接从卡带开机。
      instance.settings.SKIPBoot = true
      // 上游 play() 会无条件调用此回调；未注册时会在初始化成功后同步抛 TypeError。
      instance.attachPlayStatusHandler(() => {})
      let slowReports = 0
      let slowReported = false
      instance.attachSpeedHandler((percent) => {
        if (slowReported || paused || destroyed || document.visibilityState === 'hidden') {
          slowReports = 0
          return
        }
        slowReports = percent < SLOW_SPEED_PERCENT ? slowReports + 1 : 0
        if (slowReports < SLOW_SPEED_REPORTS) return
        slowReported = true
        diagLog('adapter', 'warn', `IodineGBA 只跑到 ${Math.round(percent)}% 速度：这个浏览器很可能同时关掉了 JavaScript 优化（JIT）`)
        showSlowNotice(surface, percent)
      })
      instance.attachSaveImportHandler((name, found, missing) => {
        if (!batteryData?.length) {
          missing()
          return
        }
        found(name.startsWith('TYPE_') ? new Uint8Array([batteryType]) : batteryData.slice())
      })
      instance.attachSaveExportHandler((name, value) => {
        const bytes = Uint8Array.from(Array.from(value, (byte) => Number(byte) & 0xff))
        if (name.startsWith('TYPE_')) {
          batteryType = bytes[0] ?? 0
        } else if (bytes.length) {
          batteryData = bytes
        }
        persistBattery()
      })
      instance.attachGraphicsFrameHandler({
        copyBuffer: (buffer) => {
          if (!context2d || !image || destroyed) return
          for (let src = 0, dst = 0; src < 240 * 160 * 3; src += 3) {
            image.data[dst++] = Number(buffer[src]) & 0xff
            image.data[dst++] = Number(buffer[src + 1]) & 0xff
            image.data[dst++] = Number(buffer[src + 2]) & 0xff
            image.data[dst++] = 0xff
          }
          context2d.putImageData(image, 0, 0)
          if (!firstFrame) {
            firstFrame = true
            options.onStart?.()
          }
        },
      })
      if (audio) instance.attachAudioHandler(audio.handler)
      instance.attachROM(new Uint8Array(rom))
      instance.attachBIOS(new Uint8Array(biosBytes))
      instance.setIntervalRate(TIMER_INTERVAL_MS)
      instance.play()
      if ((instance.emulatorStatus & 0x1) !== 0x1) {
        throw new IodineStartupError('IodineGBA 无法初始化 GBA BIOS 或 ROM。', 'content')
      }
      engine = instance
      options.onGeometry?.({ width: 240, height: 160 })
      options.onProgress?.({ phase: 'starting', ratio: 1 })
      uninstallKeyboard = installPadKeyboard((button, down) => {
        if (button === 'turboA') commonPad('a', down)
        else if (button === 'turboB') commonPad('b', down)
        else commonPad(button, down)
      })
      window.addEventListener('keydown', extraKeysDown, true)
      window.addEventListener('keyup', extraKeysUp, true)
      gamepadRaf = requestAnimationFrame(pollGamepad)
      document.addEventListener('visibilitychange', onVisibilityChange)
      window.addEventListener('pagehide', onPageHide)
      saveTimer = window.setInterval(updateBattery, 30_000)
      startClock()
      unlockAudio = () => {
        if (audio?.context.state === 'suspended') void audio.context.resume().catch(() => {})
      }
      window.addEventListener('pointerdown', unlockAudio, { once: true, capture: true })
      window.addEventListener('keydown', unlockAudio, { once: true, capture: true })
      window.addEventListener('touchend', unlockAudio, { once: true, capture: true })
      options.onReady?.()
    } catch (error) {
      fail(error)
    }
  })()

  return {
    caps,
    setPaused: (next) => {
      if (!engine || destroyed || paused === next) return
      paused = next
      if (paused) {
        stopClock()
        engine.pause()
        if (audio?.context.state === 'running') void audio.context.suspend().catch(() => {})
        updateBattery()
      } else {
        engine.play()
        startClock()
        if (audio?.context.state === 'suspended') void audio.context.resume().catch(() => {})
      }
    },
    setVolume: (volume) => audio?.handler.setVolume(volume),
    sendButton: commonPad,
    screenshot: async () => canvasToBlob(canvas),
    nativeVideoSize: () => ({ width: 240, height: 160 }),
    volume: 1,
    captureSources: (): CaptureSources => ({ canvas, audioNode: audio?.gain ?? null, audioContext: audio?.context ?? null }),
    destroy,
  }
}
