/**
 * IodineGBA：GBA 在禁用 WebAssembly 浏览器中的备用运行时。
 *
 * 上游核心是纯 JavaScript、固定画布 240×160，并要求 16 KiB GBA BIOS。这里提供本站的
 * ROM / BIOS 读取、画面、音频、键盘 / 手柄和电池存档桥；即时存档格式上游没有实现，
 * 因此不冒充支持 F2 / 云端快照，也不写 EmulatorJS 的存档槽。
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
import { resolvePlatformBiosForStartup } from '@/services/platformBios'
import { IODINEGBA_BUILD, IODINEGBA_SHA256 } from '../iodinegbaVersion'
import { applyPinnedScriptIntegrity } from '../coreAssetIntegrity'
import { createInputSourceRouter } from '../inputSourceRouter'

const BASE = '/iodinegba'
const BIOS_BYTES = 0x4000
const MAX_ROM_BYTES = 64 * 1024 * 1024
const SAVE_KEY_PREFIX = '8bitgo.iodinegba.battery.v1:'
const SAVE_STATE_TAG = '8bitgo-iodinegba-battery-v1'
const TIMER_INTERVAL_MS = 16

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
  setIntervalRate(rate: number): void
  timerCallback(timestamp: number): void
  play(): void
  pause(): void
  exportSave(): void
  keyDown(index: number): void
  keyUp(index: number): void
}

interface IodineAudioHandler {
  initialize(channels: number, sampleRate: number, bufferAmount: number, heartbeat: () => void, postHeartbeat: () => void, error: () => void): void
  register(): void
  unregister(): void
  push(data: Float32Array, start: number, end: number): void
  remainingBuffer(): number
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
      applyPinnedScriptIntegrity(script, IODINEGBA_SHA256)
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

function createAudioSink(): { context: AudioContext; node: ScriptProcessorNode; gain: GainNode; handler: IodineAudioHandler } | null {
  let context: AudioContext | null = null
  try {
    const AudioContextCtor = window.AudioContext ?? (window as Window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
    if (!AudioContextCtor) return null
    context = new AudioContextCtor()
    if (typeof context.createScriptProcessor !== 'function') throw new Error('ScriptProcessorNode 不可用')

    const node = context.createScriptProcessor(2048, 0, 2)
    const gain = context.createGain()
    const capacity = 1 << 16
    const mask = capacity - 1
    const queue = new Float32Array(capacity)
    let read = 0
    let write = 0
    let sourceRate = 44_100
    let phase = 0

    const pushSample = (sample: number) => {
      if (write - read >= capacity) read++
      queue[write & mask] = sample
      write++
    }
    node.onaudioprocess = (event) => {
      const left = event.outputBuffer.getChannelData(0)
      const right = event.outputBuffer.getChannelData(1)
      for (let i = 0; i < left.length; i++) {
        left[i] = read < write ? queue[read++ & mask] : 0
        right[i] = read < write ? queue[read++ & mask] : 0
      }
    }
    node.connect(gain)
    gain.connect(context.destination)

    const handler: IodineAudioHandler = {
      initialize: (_channels, sampleRate) => { sourceRate = sampleRate || 44_100 },
      register: () => {},
      unregister: () => { read = write },
      push: (data, start, end) => {
        const frames = Math.floor((end - start) / 2)
        if (frames <= 0) return
        const step = sourceRate / context!.sampleRate
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
      remainingBuffer: () => write - read,
      setBufferSpace: (amount) => {
        const target = Math.max(0, Math.min(capacity, amount | 0))
        while (write - read < target) pushSample(0)
      },
      setVolume: (volume) => { gain.gain.value = Math.max(0, Math.min(1, volume)) },
    }
    return { context, node, gain, handler }
  } catch {
    if (context && context.state !== 'closed') void context.close().catch(() => {})
    return null
  }
}

class IodineStartupError extends Error {
  readonly scope: 'content' | 'config' | 'runtime'

  constructor(message: string, scope: 'content' | 'config' | 'runtime') {
    super(message)
    this.scope = scope
  }
}

/** BIOS 通常只有 16 KiB；先在它自己的并行 Promise 内校验，避免配错时把大 ROM 下载完才报配置错。 */
async function prepareIodineBios(data: ArrayBuffer): Promise<ArrayBuffer> {
  let biosBytes = data
  if (isZip(biosBytes)) {
    try {
      const extracted = await extractRomFromZip(biosBytes, ['bin', 'bios', 'gba'])
      biosBytes = extracted.data.buffer.slice(extracted.data.byteOffset, extracted.data.byteOffset + extracted.data.byteLength) as ArrayBuffer
    } catch {
      throw new IodineStartupError('GBA BIOS 压缩包内没有可识别的 .bin / .bios 文件。', 'config')
    }
  }
  if (biosBytes.byteLength !== BIOS_BYTES) {
    throw new IodineStartupError(`GBA BIOS 大小必须为 16 KiB，当前为 ${biosBytes.byteLength} 字节。`, 'config')
  }
  return biosBytes
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
  const gamepadHeld = new Set<IodineButton>()
  const extraKeysHeld = new Set<'l' | 'r'>()
  const inputSources = createInputSourceRouter<IodineButton>((button, down) => {
    const index = KEY_INDEX[button]
    if (down) engine?.keyDown(index)
    else engine?.keyUp(index)
  })

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

  const setKey = (button: IodineButton, down: boolean, source: string) => {
    if (!engine || destroyed) return
    inputSources.set(button, down, source)
  }

  const commonPad = (button: PadButton, down: boolean, source = 'touchpad') => setKey(button, down, source)
  const stopGamepad = () => {
    if (gamepadRaf) cancelAnimationFrame(gamepadRaf)
    gamepadRaf = 0
    for (const button of gamepadHeld) setKey(button, false, 'gamepad')
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
        setKey(button, want, 'gamepad')
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
    if (document.visibilityState === 'hidden') {
      releaseExtraKeys()
      updateBattery()
    }
  }
  const onPageHide = () => updateBattery()

  const releaseExtraKeys = () => {
    for (const button of extraKeysHeld) setKey(button, false, 'keyboard-extra')
    extraKeysHeld.clear()
  }

  const extraButtonOf = (code: string): 'l' | 'r' | null =>
    code === 'KeyQ' ? 'l' : code === 'KeyE' ? 'r' : null

  const extraKeysDown = (event: KeyboardEvent) => {
    const button = extraButtonOf(event.code)
    if (!button) return
    const target = event.target as HTMLElement | null
    if (target?.isContentEditable || (target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName))) return
    event.preventDefault()
    if (extraKeysHeld.has(button)) return
    extraKeysHeld.add(button)
    setKey(button, true, 'keyboard-extra')
  }
  const extraKeysUp = (event: KeyboardEvent) => {
    const button = extraButtonOf(event.code)
    if (!button || !extraKeysHeld.delete(button)) return
    setKey(button, false, 'keyboard-extra')
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
        setKey(button, true, `touch:${button}`)
      })
      const release = () => setKey(button, false, `touch:${button}`)
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
    releaseExtraKeys()
    inputSources.releaseSource('keyboard-extra')
    window.removeEventListener('keydown', extraKeysDown, true)
    window.removeEventListener('keyup', extraKeysUp, true)
    window.removeEventListener('blur', releaseExtraKeys)
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
      let biosUrl = options.biosUrl
      if (!biosUrl) {
        const binding = await resolvePlatformBiosForStartup(options.platform)
        biosUrl = binding.url
        if (!biosUrl && !binding.mapLoaded) {
          throw new IodineStartupError('暂时无法读取 GBA 平台 BIOS 配置，请检查网络后重试。', 'runtime')
        }
      }
      if (!biosUrl) throw new IodineStartupError('IodineGBA 启动需要 16 KiB GBA BIOS；请先在后台配置 GBA 平台 BIOS。', 'config')
      const [loaded, biosBytes] = await Promise.all([
        loadGameBytes(options.game, options.onProgress, aborter.signal, { maxBytes: MAX_ROM_BYTES, maxUnpackedBytes: MAX_ROM_BYTES }, options.onRomLoadStart),
        loadGameBytes(biosUrl, undefined, aborter.signal, { maxBytes: 2 * 1024 * 1024, maxUnpackedBytes: 2 * 1024 * 1024 })
          .then((bios) => prepareIodineBios(bios.data)),
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
      const Core = await loadIodineScript().then(() => window.IodineGBA)
      if (!Core) throw new Error('IodineGBA 核心未能初始化')
      if (destroyed) return
      const instance = new Core()
      instance.settings.offthreadGfxEnabled = false
      // 上游 play() 会无条件调用此回调；未注册时会在初始化成功后同步抛 TypeError。
      instance.attachPlayStatusHandler(() => {})
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
      uninstallKeyboard = installPadKeyboard((button, down, _seat, code) => {
        if (button === 'turboA') commonPad('a', down, `keyboard:${code}`)
        else if (button === 'turboB') commonPad('b', down, `keyboard:${code}`)
        else commonPad(button, down, `keyboard:${code}`)
      })
      window.addEventListener('keydown', extraKeysDown, true)
      window.addEventListener('keyup', extraKeysUp, true)
      window.addEventListener('blur', releaseExtraKeys)
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
    sendButton: (button, down) => commonPad(button, down),
    screenshot: async () => canvasToBlob(canvas),
    nativeVideoSize: () => ({ width: 240, height: 160 }),
    volume: 1,
    captureSources: (): CaptureSources => ({ canvas, audioNode: audio?.gain ?? null, audioContext: audio?.context ?? null }),
    destroy,
  }
}
