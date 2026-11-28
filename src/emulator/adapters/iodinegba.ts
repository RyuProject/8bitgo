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
import type { Capability, CaptureSources, GbaLinkNetplaySession, MountOptions, PadButton, RuntimeHandle } from '../types'
import { isZip, extractRomFromZip } from '@/lib/unzip'
import { diagLog } from '@/services/startupDiagnostics'
import { resolvePlatformBiosForStartup } from '@/services/platformBios'
import { IODINEGBA_BUILD, IODINEGBA_SHA256 } from '../iodinegbaVersion'
import { applyPinnedScriptIntegrity } from '../coreAssetIntegrity'
import { createInputSourceRouter } from '../inputSourceRouter'
import { attachGbaCable, GBA_LINK_PROTOCOL_VERSION, type GbaLinkCable, type GbaLinkSerial } from '../gbaLinkCable'
import { advanceGbaLinkFrameClock, createGbaLinkFrameClock, gbaLinkRemoteWaitExpired } from '../gbaLinkClock'
import { JsnesNetplay } from '../jsnesNetplay'

const BASE = '/iodinegba'
const BIOS_BYTES = 0x4000
const MAX_ROM_BYTES = 64 * 1024 * 1024
const SAVE_KEY_PREFIX = '8bitgo.iodinegba.battery.v1:'
const SAVE_STATE_TAG = '8bitgo-iodinegba-battery-v1'
const TIMER_INTERVAL_MS = 1000 / 60

type IodineButton = PadButton | 'l' | 'r'

interface IodineEmulator {
  settings: { SKIPBoot: boolean; offthreadGfxEnabled: boolean; dynamicSpeed?: boolean }
  CPUCyclesTotal: number
  CPUCyclesPerIteration: number
  emulatorStatus: number
  audio?: IodineAudioHandler
  IOCore?: { serial?: GbaLinkSerial; coreExposed?: { graphicsHandle?: unknown } } | null
  audioUnderrunAdjustment?: () => void
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

interface IodineBatterySnapshot {
  data: Uint8Array | null
  type: number
}

const GBA_NETPLAY_ACTIONS: readonly IodineButton[] = ['a', 'b', 'select', 'start', 'up', 'down', 'left', 'right', 'l', 'r']

function gbaInputBits(keys: ReadonlySet<IodineButton>): number {
  let bits = 0
  for (let index = 0; index < GBA_NETPLAY_ACTIONS.length; index++) {
    if (keys.has(GBA_NETPLAY_ACTIONS[index])) bits |= 1 << index
  }
  return bits
}

function gbaRomFingerprint(bytes: Uint8Array): string {
  let a = 0x811c9dc5
  let b = 0x9e3779b9
  for (let i = 0; i < bytes.length; i++) {
    a = Math.imul(a ^ bytes[i], 0x01000193) >>> 0
    b = Math.imul(b ^ (bytes[i] + i), 0x85ebca6b) >>> 0
  }
  return `${bytes.length.toString(16)}-${a.toString(16).padStart(8, '0')}${b.toString(16).padStart(8, '0')}`
}

function serializeBattery(snapshot: IodineBatterySnapshot): { tag: string; type: number; data: string } {
  return { tag: SAVE_STATE_TAG, type: snapshot.type, data: snapshot.data ? encodeBase64(snapshot.data) : '' }
}

function parseBattery(value: unknown): IodineBatterySnapshot {
  if (!value || typeof value !== 'object') throw new Error('对端卡带存档格式不合法')
  const record = value as { tag?: unknown; type?: unknown; data?: unknown }
  if (record.tag !== SAVE_STATE_TAG || !Number.isInteger(record.type) || (record.type as number) < 0 || (record.type as number) > 3
    || typeof record.data !== 'string' || record.data.length > 180_000) {
    throw new Error('对端卡带存档格式或大小不合法')
  }
  const data = record.data ? decodeBase64(record.data) : null
  if (record.data && (!data || data.length > 131_072)) throw new Error('对端卡带存档内容损坏')
  return { data, type: record.type as number }
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
  let engines: IodineEmulator[] = []
  let cable: GbaLinkCable | null = null
  let netplay: JsnesNetplay | null = null
  let netplaySession: GbaLinkNetplaySession | null = null
  let netplayActive = false
  let netplayRaf = 0
  let netplayFrame = 0
  let netplayFrameClock = createGbaLinkFrameClock()
  let netplayLocalRing: number[] = []
  let netplayPendingFrame = -1
  let netplayPendingBits = 0
  let netplayPendingSent = false
  let netplayAppliedBits: [number, number] = [-1, -1]
  let netplayRemoteWaitStartedAt: number | null = null
  let netplaySeat: 0 | 1 = 0
  let romBytes: Uint8Array | null = null
  let biosBytesForCore: Uint8Array | null = null
  let coreConstructor: (new () => IodineEmulator) | null = null
  const batteryBySeat: [IodineBatterySnapshot, IodineBatterySnapshot] = [
    { data: null, type: 0 },
    { data: null, type: 0 },
  ]
  const localKeys = new Set<IodineButton>()
  let timer = 0
  let saveTimer = 0
  let gamepadRaf = 0
  let firstFrame = false
  let uninstallKeyboard: (() => void) | null = null
  let batteryData: Uint8Array | null = null
  let batteryType = 0
  let batterySaveSeat: 0 | 1 = 0
  let batteryKey = ''
  let lastBatteryRecord = ''
  let unlockAudio: (() => void) | null = null
  const gamepadHeld = new Set<IodineButton>()
  const extraKeysHeld = new Set<'l' | 'r'>()
  const inputSources = createInputSourceRouter<IodineButton>((button, down) => {
    const index = KEY_INDEX[button]
    if (down) localKeys.add(button)
    else localKeys.delete(button)
    // 锁步时按帧施加输入；直接写核心会让两端因网络等待时长不同而分叉。
    if (netplayActive) return
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
        batteryBySeat[0] = { data: batteryData?.slice() ?? null, type: batteryType }
      }
    }
  } catch {
    // 隐私模式或损坏的本地值不应挡住游戏启动。
  }

  const persistBattery = () => {
    if (!batteryData?.length || !batteryKey) return
    batteryBySeat[netplayActive ? netplaySeat : batterySaveSeat] = { data: batteryData.slice(), type: batteryType }
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
    // 后台标签页可能暂停 RAF；恢复时重新给对端一段完整等待时间，不把系统挂起算成断流。
    netplayRemoteWaitStartedAt = null
    if (document.visibilityState === 'hidden') {
      releaseExtraKeys()
      inputSources.releaseSource('gamepad')
      inputSources.releaseSource('touchpad')
      inputSources.releaseSource('touch:l')
      inputSources.releaseSource('touch:r')
      gamepadHeld.clear()
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
    netplayActive = false
    if (netplayRaf) cancelAnimationFrame(netplayRaf)
    netplayRaf = 0
    cable?.destroy()
    cable = null
    const oldNetplay = netplay
    netplay = null
    netplaySession = null
    oldNetplay?.close()
    for (const instance of new Set([...engines, ...(engine ? [engine] : [])])) disposeEngine(instance)
    engines = []
    engine = null
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

  const makeEngine = (
    save: IodineBatterySnapshot,
    render: boolean,
    sound: boolean,
    lockstep: boolean,
    persist: boolean,
  ): IodineEmulator => {
    if (!coreConstructor || !romBytes || !biosBytesForCore) throw new Error('GBA 联机核心资源尚未准备好')
    const instance = new coreConstructor()
    instance.settings.offthreadGfxEnabled = false
    if (lockstep) instance.settings.dynamicSpeed = false
    instance.attachPlayStatusHandler(() => {})
    instance.attachSaveImportHandler((name, found, missing) => {
      if (!save.data?.length) {
        missing()
        return
      }
      found(name.startsWith('TYPE_') ? new Uint8Array([save.type]) : save.data.slice())
    })
    instance.attachSaveExportHandler((name, value) => {
      const bytes = Uint8Array.from(Array.from(value, (byte) => Number(byte) & 0xff))
      if (name.startsWith('TYPE_')) save.type = bytes[0] ?? 0
      else if (bytes.length) save.data = bytes
      if (persist) {
        batteryData = save.data?.slice() ?? null
        batteryType = save.type
        persistBattery()
      }
    })
    if (render) {
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
    } else {
      instance.attachGraphicsFrameHandler({ copyBuffer: () => {} })
    }
    if (sound && audio) instance.attachAudioHandler(audio.handler)
    if (lockstep) {
      // 音频缓冲欠载会改变 IodineGBA 每轮 CPU 周期；锁步时固定周期，保持两份核心逐帧一致。
      instance.audioUnderrunAdjustment = function () {
        this.CPUCyclesTotal = this.CPUCyclesPerIteration
      }
    }
    instance.attachROM(romBytes)
    instance.attachBIOS(biosBytesForCore)
    instance.setIntervalRate(TIMER_INTERVAL_MS)
    instance.play()
    if ((instance.emulatorStatus & 0x1) !== 0x1) throw new IodineStartupError('IodineGBA 无法初始化 GBA BIOS 或 ROM。', 'content')
    return instance
  }

  const disposeEngine = (instance: IodineEmulator) => {
    try { instance.pause() } catch { /* 退出清理不再影响播放器 */ }
    instance.attachSaveExportHandler(() => {})
    instance.attachSaveImportHandler((_name, _found, missing) => missing())
    if (instance.IOCore?.coreExposed) instance.IOCore.coreExposed.graphicsHandle = null
    instance.audio = undefined
    instance.IOCore = null
  }

  const resetLinkInput = () => {
    netplayFrame = 0
    netplayFrameClock = createGbaLinkFrameClock()
    netplayLocalRing = []
    netplayPendingFrame = -1
    netplayPendingBits = 0
    netplayPendingSent = false
    netplayAppliedBits = [-1, -1]
    netplayRemoteWaitStartedAt = null
  }

  const applyLinkInput = (seat: 0 | 1, bits: number) => {
    const instance = engines[seat]
    if (!instance) throw new Error('GBA 联机核心已经退出')
    const previous = netplayAppliedBits[seat]
    if (previous === bits) return
    for (let index = 0; index < GBA_NETPLAY_ACTIONS.length; index++) {
      const was = previous >= 0 && (previous & (1 << index)) !== 0
      const down = (bits & (1 << index)) !== 0
      if (was === down) continue
      const button = GBA_NETPLAY_ACTIONS[index]
      const key = KEY_INDEX[button]
      if (down) instance.keyDown(key)
      else instance.keyUp(key)
    }
    netplayAppliedBits[seat] = bits
  }

  const resumeSoloAfterLink = (target?: JsnesNetplay) => {
    // 离房前立刻刷一次本机卡带存档；只依赖 30 秒周期会丢掉刚发生的进度。
    if (netplayActive) updateBattery()
    if (netplayActive) {
      try {
        // 联机按延迟帧施加输入；切回单机前要对齐实体按键，避免留下延迟后的粘键状态。
        applyLinkInput(netplaySeat, gbaInputBits(localKeys))
      } catch {
        // 核心已异常退出时仍要完成拆线和房间清理，不能让输入对齐卡住退出。
      }
    }
    netplayActive = false
    if (netplayRaf) cancelAnimationFrame(netplayRaf)
    netplayRaf = 0
    cable?.destroy()
    cable = null
    const localEngine = engine
    for (const instance of engines) {
      if (instance !== localEngine) disposeEngine(instance)
    }
    engines = localEngine ? [localEngine] : []
    if (netplay === target || !target) netplay = null
    target?.close()
    netplaySession = null
    resetLinkInput()
    if (!caps.has('pause')) {
      caps.add('pause')
      options.onCaps?.(caps)
    }
    if (!destroyed) {
      paused = false
      startClock()
    }
  }

  const startLinkLoop = () => {
    const tick = (time: number) => {
      netplayRaf = 0
      const activeNetplay = netplay
      if (!netplayActive || !activeNetplay || destroyed) return
      try {
        advanceGbaLinkFrameClock(netplayFrameClock, time, (frameTime) => {
          const frame = netplayFrame
          const delay = activeNetplay.bufferFrames
          if (netplayPendingFrame !== frame) {
            netplayPendingFrame = frame
            netplayPendingBits = gbaInputBits(localKeys)
            netplayPendingSent = false
          }
          if (!netplayPendingSent) netplayPendingSent = activeNetplay.sendLocal(frame, netplayPendingBits)
          if (!netplayPendingSent) return false
          const sourceFrame = frame - delay
          const remoteBits = sourceFrame < 0 ? 0 : activeNetplay.remoteBitsFor(sourceFrame)
          if (remoteBits === undefined) {
            const now = performance.now()
            if (netplayRemoteWaitStartedAt === null) netplayRemoteWaitStartedAt = now
            if (gbaLinkRemoteWaitExpired(netplayRemoteWaitStartedAt, now, document.visibilityState !== 'hidden')) {
              throw new Error('对端输入长时间未到达，已停止联机以避免游戏无限卡住；请重新连接后继续')
            }
            return false
          }
          netplayRemoteWaitStartedAt = null

          netplayLocalRing.push(netplayPendingBits)
          while (netplayLocalRing.length > delay + 1) netplayLocalRing.shift()
          if (sourceFrame < 0) {
            applyLinkInput(netplaySeat, 0)
            applyLinkInput(netplaySeat === 0 ? 1 : 0, 0)
          } else {
            applyLinkInput(netplaySeat, netplayLocalRing[0] ?? 0)
            applyLinkInput(netplaySeat === 0 ? 1 : 0, remoteBits)
            activeNetplay.pruneRemote(sourceFrame - 1)
          }
          const timestamp = Math.floor(frameTime) >>> 0
          for (const instance of engines) instance.timerCallback(timestamp)
          const transfer = cable?.settleFrame() ?? 'idle'
          if (transfer === 'failed') throw new Error(cable?.failureReason ?? 'GBA 串口传输失败，已停止联机以避免游戏状态分叉')
          netplayFrame++
          netplayPendingFrame = -1
          netplayPendingSent = false
          return true
        })
      } catch (error) {
        const target = netplay
        const session = netplaySession
        const message = error instanceof Error ? error.message : String(error)
        resumeSoloAfterLink(target ?? undefined)
        session?.onError?.(message)
      }
      if (netplayActive && !destroyed) netplayRaf = requestAnimationFrame(tick)
    }
    netplayRaf = requestAnimationFrame(tick)
  }

  const makeLinkCores = () => {
    // 离房后本机可能继续玩并更新同一个存档；下次换座位开房时仍以本机当前存档为准。
    batteryBySeat[netplaySeat] = { data: batteryData?.slice() ?? null, type: batteryType }
    batterySaveSeat = netplaySeat
    const localIndex = netplaySeat
    const pair: IodineEmulator[] = []
    try {
      pair[0] = makeEngine(batteryBySeat[0], localIndex === 0, localIndex === 0, true, localIndex === 0)
      pair[1] = makeEngine(batteryBySeat[1], localIndex === 1, localIndex === 1, true, localIndex === 1)
      const serial0 = pair[0].IOCore?.serial
      const serial1 = pair[1].IOCore?.serial
      if (!serial0 || !serial1) throw new Error('IodineGBA 没有公开可用的串口，无法连接 GBA 电缆')
      const nextCable = attachGbaCable({ serial: serial0 }, { serial: serial1 })
      const previousEngine = engine
      stopClock()
      if (previousEngine && !pair.includes(previousEngine)) disposeEngine(previousEngine)
      engines = pair
      cable = nextCable
      engine = pair[localIndex]
      batteryData = batteryBySeat[localIndex].data?.slice() ?? null
      batteryType = batteryBySeat[localIndex].type
      lastBatteryRecord = ''
      netplayActive = true
      paused = false
      resetLinkInput()
      caps.delete('pause')
      options.onCaps?.(caps)
      startLinkLoop()
    } catch (error) {
      for (const instance of pair) disposeEngine(instance)
      throw error
    }
  }

  const startGbaNetplay = async () => {
    const session = netplaySession
    if (!session || netplay || !engine || !romBytes || destroyed || paused) return false
    netplaySeat = session.mode === 'host' ? 0 : 1
    const np = new JsnesNetplay({
      roomId: session.roomId,
      seat: netplaySeat,
      bufferFrames: session.bufferFrames ?? 2,
      // 同 ROM 仍可能因核心或串口桥代次不同而逐帧分叉，因此把运行时构建与电缆协议一起核对。
      gameId: `${GBA_LINK_PROTOCOL_VERSION}:${IODINEGBA_SHA256}:${gbaRomFingerprint(romBytes)}:${gbaRomFingerprint(biosBytesForCore ?? new Uint8Array())}`,
      captureInitialState: () => null,
      applyInitialState: () => {},
      captureOwnState: () => {
        // 两端各自暂停在握手快照处；新的双机局从这两份存档冷启动，不能把未同步的单机内存带进来。
        stopClock()
        paused = true
        caps.delete('pause')
        options.onCaps?.(caps)
        updateBattery()
        batteryBySeat[netplaySeat] = { data: batteryData?.slice() ?? null, type: batteryType }
        return serializeBattery(batteryBySeat[netplaySeat])
      },
      applyPeerState: (state) => {
        const peerSeat = netplaySeat === 0 ? 1 : 0
        batteryBySeat[peerSeat] = parseBattery(state)
      },
      onReady: () => {
        if (destroyed || netplay !== np || netplaySession !== session) return
        try {
          makeLinkCores()
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          resumeSoloAfterLink(np)
          session.onError?.(message)
        }
      },
      onError: (message) => {
        // 断开后立刻重试时，旧 WebSocket 的迟到错误不能覆盖新会话的 UI 状态。
        if (destroyed || netplay !== np || netplaySession !== session) return
        resumeSoloAfterLink(np)
        session.onError?.(message)
      },
      onState: (state) => {
        if (netplay === np && netplaySession === session) session.onLinkState?.(state)
      },
      onPeerCount: (count) => {
        if (netplay === np && netplaySession === session) session.onPlayers?.(count)
      },
      onRoom: (roomId, isHost) => {
        if (netplay === np && netplaySession === session) session.onRoom?.(roomId, isHost)
      },
      onHostLeft: () => {
        if (destroyed || netplay !== np || netplaySession !== session) return
        resumeSoloAfterLink(np)
        session.onHostLeft?.()
      },
    })
    netplay = np
    try {
      await np.connect()
      return true
    } catch (error) {
      if (destroyed || netplay !== np || netplaySession !== session) return false
      resumeSoloAfterLink(np)
      session.onError?.(error instanceof Error ? error.message : String(error))
      return false
    }
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
      coreConstructor = Core
      romBytes = new Uint8Array(rom)
      biosBytesForCore = new Uint8Array(biosBytes)
      const instance = makeEngine(batteryBySeat[0], true, true, false, true)
      engine = instance
      engines = [instance]
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
      if (!engine || destroyed || netplayActive || paused === next) return
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
    openGbaLinkNetplay: (session) => {
      if (!engine || destroyed || netplay || paused || !romBytes) return false
      netplaySession = session
      void startGbaNetplay()
      return true
    },
    closeNetplay: () => resumeSoloAfterLink(netplay ?? undefined),
    screenshot: async () => canvasToBlob(canvas),
    nativeVideoSize: () => ({ width: 240, height: 160 }),
    volume: 1,
    captureSources: (): CaptureSources => ({ canvas, audioNode: audio?.gain ?? null, audioContext: audio?.context ?? null }),
    destroy,
  }
}
