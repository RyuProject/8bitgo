/**
 * binjgb 备用运行时：只接管没有 WebGL 的 GB / GBC 浏览器。
 *
 * 核心是仓库内自托管的 WebAssembly；画面固定走 Canvas 2D，不创建 WebGL 上下文。
 * 输入仍复用播放器的键盘、手柄与触屏按键，电池存档使用与 Gambatte 相同的 SRAM 字节，
 * 避免玩家在 WebGL 设备与旧浏览器之间切换时丢掉游戏内进度。
 */
import type { Capability, CaptureSources, MountOptions, PadButton, RuntimeHandle } from '../types'
import { canvasToBlob } from '../recorder'
import { loadGameBytes } from '../romLoader'
import { extractRomFromZip, isZip } from '@/lib/unzip'
import { batterySaveGameName } from '../ejsSaveFs'
import { createBatterySync, type BatteryFs, type BatterySync } from '../batterySync'
import { installPadKeyboard } from '../padKeyboard'
import { startGamepadInput } from '../gamepadInput'

const BINJGB_BUILD = '16621111ed0ee73bcc45c912a823bcebedcffc0f'
const BINJGB_BASE = '/binjgb'
const CPU_TICKS_PER_SECOND = 4_194_304
const AUDIO_FRAMES = 4096
const AUDIO_LATENCY_SEC = 0.1
const MAX_UPDATE_SEC = 5 / 60
const SCREEN_WIDTH = 160
const SCREEN_HEIGHT = 144
const MAX_ROM_BYTES = 16 * 1024 * 1024
const BATTERY_KEY_PREFIX = '8bitgo.binjgb.battery.v1:'
const STATE_TAG = '8bitgo-binjgb-state-v1'

interface BinjgbModule {
  HEAPU8: Uint8Array
  _malloc(size: number): number
  _free(ptr: number): void
  _emulator_new_simple(rom: number, size: number, sampleRate: number, audioFrames: number, colorCurve: number): number
  _emulator_delete(emulator: number): void
  _emulator_get_ticks_f64(emulator: number): number
  _emulator_run_until_f64(emulator: number, ticks: number): number
  _emulator_was_ext_ram_updated(emulator: number): number
  _emulator_set_builtin_palette(emulator: number, palette: number): void
  _emulator_read_ext_ram(emulator: number, fileData: number): number
  _emulator_write_ext_ram(emulator: number, fileData: number): number
  _emulator_read_state(emulator: number, fileData: number): number
  _emulator_write_state(emulator: number, fileData: number): number
  _ext_ram_file_data_new(emulator: number): number
  _state_file_data_new(emulator: number): number
  _get_file_data_ptr(fileData: number): number
  _get_file_data_size(fileData: number): number
  _file_data_delete(fileData: number): void
  _get_frame_buffer_ptr(emulator: number): number
  _get_frame_buffer_size(emulator: number): number
  _get_audio_buffer_ptr(emulator: number): number
  _get_audio_buffer_capacity(emulator: number): number
  _set_joyp_up(emulator: number, down: number): void
  _set_joyp_down(emulator: number, down: number): void
  _set_joyp_left(emulator: number, down: number): void
  _set_joyp_right(emulator: number, down: number): void
  _set_joyp_A(emulator: number, down: number): void
  _set_joyp_B(emulator: number, down: number): void
  _set_joyp_select(emulator: number, down: number): void
  _set_joyp_start(emulator: number, down: number): void
}

type BinjgbFactory = (options: {
  locateFile: (path: string) => string
  print: (...args: unknown[]) => void
  printErr: (...args: unknown[]) => void
}) => Promise<BinjgbModule>

declare global {
  interface Window {
    Binjgb?: BinjgbFactory
  }
}

let scriptPromise: Promise<void> | null = null
let modulePromise: Promise<BinjgbModule> | null = null

function loadBinjgbScript(): Promise<void> {
  if (window.Binjgb) return Promise.resolve()
  if (!scriptPromise) {
    scriptPromise = new Promise<void>((resolve, reject) => {
      const script = document.createElement('script')
      script.async = true
      script.src = `${BINJGB_BASE}/binjgb.js?v=${BINJGB_BUILD}`
      script.onload = () => window.Binjgb ? resolve() : reject(new Error('binjgb 脚本没有导出运行时'))
      script.onerror = () => reject(new Error('无法加载自托管的 binjgb 运行时'))
      document.head.appendChild(script)
    }).catch((error: unknown) => {
      scriptPromise = null
      throw error
    })
  }
  return scriptPromise
}

function loadBinjgb(): Promise<BinjgbModule> {
  if (!modulePromise) {
    modulePromise = loadBinjgbScript()
      .then(() => {
        const factory = window.Binjgb
        if (!factory) throw new Error('binjgb 脚本没有导出运行时')
        return factory({
          locateFile: (path) => `${BINJGB_BASE}/${path}?v=${BINJGB_BUILD}`,
          print: (...args) => console.info('[binjgb]', ...args),
          printErr: (...args) => console.warn('[binjgb]', ...args),
        })
      })
      .catch((error: unknown) => {
        modulePromise = null
        throw error
      })
  }
  return modulePromise
}

function toBase64(bytes: Uint8Array): string {
  let binary = ''
  const chunk = 0x4000
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk))
  }
  return btoa(binary)
}

function fromBase64(value: string): Uint8Array | null {
  try {
    const binary = atob(value)
    const bytes = new Uint8Array(binary.length)
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
    return bytes
  } catch {
    return null
  }
}

function cleanSaveBase(slug: string | undefined, romName: string, gameName: string): string {
  const slugName = slug ? batterySaveGameName(slug, romName) : undefined
  const base = (slugName ?? gameName ?? romName).split('/').pop()?.replace(/\.[^./]+$/, '') ?? 'game'
  return base.replace(/[^A-Za-z0-9._~-]/g, '_').replace(/^\.+/, '').slice(0, 120) || 'game'
}

function makeBatteryStore(key: string, path: string) {
  const files = new Map<string, Uint8Array>()
  try {
    const saved = localStorage.getItem(key)
    const decoded = saved ? fromBase64(saved) : null
    if (decoded) files.set(path, decoded)
  } catch {
    /* 浏览器禁用本地存储时仍可玩，只是无法保留电池存档 */
  }

  const fs: BatteryFs = {
    analyzePath: (name) => ({ exists: files.has(name) }),
    readFile: (name) => {
      const data = files.get(name)
      if (!data) throw new Error(`电池存档不存在：${name}`)
      return data.slice()
    },
    writeFile: (name, data) => files.set(name, data.slice()),
    mkdir: () => {},
  }

  return {
    fs,
    seed: () => {
      const exact = files.get(path)
      if (exact) return exact.slice()
      // 老版本云存档可能以 ROM 原名落盘；格式相同且大小匹配时仍能迁入当前游戏。
      const candidate = [...files.values()].at(-1)
      return candidate?.slice() ?? null
    },
    persist: (data: Uint8Array) => {
      if (!data.length) return false
      files.set(path, data.slice())
      try {
        localStorage.setItem(key, toBase64(data))
      } catch {
        /* 写入配额满或隐私模式时保留内存副本，模拟器本身继续工作 */
      }
      return true
    },
  }
}

function createAudioContext(): AudioContext | null {
  try {
    const AudioContextCtor = window.AudioContext ?? (window as Window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
    return AudioContextCtor ? new AudioContextCtor() : null
  } catch {
    return null
  }
}

export function mount(container: HTMLElement, options: MountOptions): RuntimeHandle {
  const aborter = new AbortController()
  let destroyed = false
  let paused = false
  let emulator = 0
  let romPtr = 0
  let frameRaf = 0
  let lastRafSec = 0
  let leftoverTicks = 0
  let module: BinjgbModule | null = null
  let audioContext: AudioContext | null = null
  let gain: GainNode | null = null
  let batteryTimer = 0
  let batteryDirty = false
  let batterySync: BatterySync | null = null
  let batteryStore: ReturnType<typeof makeBatteryStore> | null = null
  let batteryPath = ''
  let batteryHandle: ReturnType<typeof startGamepadInput> | null = null
  let uninstallKeyboard: (() => void) | null = null
  let unlockAudio: (() => void) | null = null
  let firstFrame = false
  const audioStartSec = { value: 0 }
  const held = new Map<string, boolean>()
  const caps = new Set<Capability>(['pause', 'saveState', 'screenshot', 'record', 'gamepad', 'touchpad'])

  const surface = document.createElement('div')
  surface.style.cssText = 'width:100%;height:100%;display:flex;align-items:center;justify-content:center;background:#000;overflow:hidden'
  const canvas = document.createElement('canvas')
  canvas.width = SCREEN_WIDTH
  canvas.height = SCREEN_HEIGHT
  canvas.style.cssText = 'display:block;width:100%;height:100%;max-width:100%;max-height:100%;object-fit:contain;image-rendering:pixelated;touch-action:none'
  surface.appendChild(canvas)
  container.appendChild(surface)

  const context2d = canvas.getContext('2d', { alpha: false })
  const imageData = context2d?.createImageData(SCREEN_WIDTH, SCREEN_HEIGHT) ?? null

  const updateBattery = () => {
    if (!module || !emulator || !batteryStore) return
    const fileData = module._ext_ram_file_data_new(emulator)
    if (!fileData) return
    try {
      module._emulator_write_ext_ram(emulator, fileData)
      const ptr = module._get_file_data_ptr(fileData)
      const size = module._get_file_data_size(fileData)
      if (size > 0) {
        const bytes = module.HEAPU8.slice(ptr, ptr + size)
        if (batteryStore.persist(bytes)) batteryDirty = true
      }
    } finally {
      module._file_data_delete(fileData)
    }
  }

  const flushBattery = async () => {
    if (!batteryDirty || !batterySync || !batteryStore || !batteryPath) return
    batteryDirty = false
    const result = await batterySync.push(batteryStore.fs, batteryPath, 'binjgb')
    if (result === 'failed') batteryDirty = true
  }

  const onVisibilityChange = () => {
    if (document.visibilityState === 'hidden') {
      updateBattery()
      void flushBattery()
    }
  }
  const onPageHide = () => {
    updateBattery()
    void flushBattery()
  }

  const setInput = (button: PadButton | 'turboA' | 'turboB', down: boolean) => {
    if (!module || !emulator || destroyed) return
    held.set(button, down)
    const isDown = (names: string[]) => names.some((name) => held.get(name) === true)
    const apply = (names: string[], fn: (emulator: number, down: number) => void) => fn(emulator, Number(isDown(names)))
    apply(['up'], module._set_joyp_up)
    apply(['down'], module._set_joyp_down)
    apply(['left'], module._set_joyp_left)
    apply(['right'], module._set_joyp_right)
    apply(['a', 'turboA'], module._set_joyp_A)
    apply(['b', 'turboB'], module._set_joyp_B)
    apply(['select'], module._set_joyp_select)
    apply(['start'], module._set_joyp_start)
  }

  const setPad = (button: PadButton, down: boolean) => setInput(button, down)

  const destroyCore = () => {
    if (frameRaf) cancelAnimationFrame(frameRaf)
    frameRaf = 0
    if (batteryTimer) window.clearInterval(batteryTimer)
    batteryTimer = 0
    batteryHandle?.stop()
    batteryHandle = null
    uninstallKeyboard?.()
    uninstallKeyboard = null
    document.removeEventListener('visibilitychange', onVisibilityChange)
    window.removeEventListener('pagehide', onPageHide)
    if (unlockAudio) {
      window.removeEventListener('pointerdown', unlockAudio, true)
      window.removeEventListener('keydown', unlockAudio, true)
      window.removeEventListener('touchend', unlockAudio, true)
      unlockAudio = null
    }
    if (emulator && module) {
      module._emulator_delete(emulator)
      emulator = 0
    }
    if (romPtr && module) {
      module._free(romPtr)
      romPtr = 0
    }
    gain?.disconnect()
    gain = null
    if (audioContext && audioContext.state !== 'closed') void audioContext.close().catch(() => {})
    audioContext = null
    surface.remove()
  }

  const readState = (): Uint8Array | null => {
    if (!module || !emulator) return null
    const fileData = module._state_file_data_new(emulator)
    if (!fileData) return null
    try {
      module._emulator_write_state(emulator, fileData)
      const ptr = module._get_file_data_ptr(fileData)
      const size = module._get_file_data_size(fileData)
      return size > 0 ? module.HEAPU8.slice(ptr, ptr + size) : null
    } finally {
      module._file_data_delete(fileData)
    }
  }

  const uploadFrame = () => {
    if (!module || !emulator || !context2d || !imageData) return
    const ptr = module._get_frame_buffer_ptr(emulator)
    const size = module._get_frame_buffer_size(emulator)
    if (size !== imageData.data.length) {
      throw new Error(`binjgb 画面缓冲区大小不正确：${size}`)
    }
    imageData.data.set(module.HEAPU8.subarray(ptr, ptr + size))
    context2d.putImageData(imageData, 0, 0)
  }

  const pushAudio = (audioFrames: number, audioBuffer: Uint8Array | null, startSec: { value: number }) => {
    if (!audioContext || !gain || !audioBuffer || audioContext.state !== 'running') return
    const now = audioContext.currentTime
    const start = startSec.value || now + AUDIO_LATENCY_SEC
    if (start < now) {
      startSec.value = now + AUDIO_LATENCY_SEC
      return
    }
    const buffer = audioContext.createBuffer(2, audioFrames, audioContext.sampleRate)
    const left = buffer.getChannelData(0)
    const right = buffer.getChannelData(1)
    for (let i = 0; i < audioFrames; i++) {
      left[i] = audioBuffer[i * 2] / 255
      right[i] = audioBuffer[i * 2 + 1] / 255
    }
    const source = audioContext.createBufferSource()
    source.buffer = buffer
    source.connect(gain)
    source.start(start)
    startSec.value = start + audioFrames / audioContext.sampleRate
  }

  const fail = (error: unknown, scope: 'runtime' | 'content' | 'config' = 'runtime') => {
    if (destroyed || aborter.signal.aborted) return
    const message = error instanceof Error ? error.message : String(error)
    options.onError?.(message, scope)
  }

  const failAndDispose = (error: unknown, scope: 'runtime' | 'content' | 'config') => {
    fail(error, scope)
    // onError 会同步结束当前会话；若父层已经调用 destroy，不要二次释放 WASM 句柄。
    if (destroyed) return
    updateBattery()
    destroyed = true
    aborter.abort()
    const endingSync = batterySync
    void flushBattery().finally(() => endingSync?.stop())
    destroyCore()
  }

  const audioBufferView = (): Uint8Array | null => {
    if (!module || !emulator) return null
    const ptr = module._get_audio_buffer_ptr(emulator)
    const size = module._get_audio_buffer_capacity(emulator)
    return size > 0 ? module.HEAPU8.subarray(ptr, ptr + size) : null
  }

  const frame = (startMs: number) => {
    if (destroyed || paused || !module || !emulator) return
    frameRaf = requestAnimationFrame(frame)
    try {
      const start = startMs / 1000
      const delta = Math.max(start - (lastRafSec || start), 0)
      const deltaTicks = Math.min(delta, MAX_UPDATE_SEC) * CPU_TICKS_PER_SECOND
      const endTicks = module._emulator_get_ticks_f64(emulator) + deltaTicks - leftoverTicks
      while (true) {
        const event = module._emulator_run_until_f64(emulator, endTicks)
        if (event & 1) {
          uploadFrame()
          if (!firstFrame) {
            firstFrame = true
            options.onStart?.()
          }
        }
        if (event & 2) pushAudio(AUDIO_FRAMES, audioBufferView(), audioStartSec)
        if (event & 4) break
      }
      leftoverTicks = (module._emulator_get_ticks_f64(emulator) - endTicks) | 0
      lastRafSec = start
      if (module._emulator_was_ext_ram_updated(emulator)) updateBattery()
    } catch (error) {
      failAndDispose(error, 'runtime')
    }
  }

  void (async () => {
    let romLoaded = false
    try {
      if (!context2d || !imageData) {
        failAndDispose(new Error('这个浏览器无法创建 Canvas 2D 画布。'), 'config')
        return
      }
      const loaded = await loadGameBytes(options.game, options.onProgress, aborter.signal, {
        maxBytes: MAX_ROM_BYTES,
        maxUnpackedBytes: MAX_ROM_BYTES,
      })
      romLoaded = true
      if (destroyed) return
      let romData = loaded.data
      let romName = loaded.name
      if (isZip(romData)) {
        const extracted = await extractRomFromZip(romData, ['gb', 'gbc'])
        if (extracted.data.byteLength > MAX_ROM_BYTES) throw new RangeError('GB/GBC ROM 超过 16 MiB 安全上限')
        romData = extracted.data.buffer.slice(extracted.data.byteOffset, extracted.data.byteOffset + extracted.data.byteLength) as ArrayBuffer
        romName = extracted.name
      }
      if (romData.byteLength < 0x150 || romData.byteLength > MAX_ROM_BYTES) {
        failAndDispose(new Error('GB/GBC ROM 长度不合法，或压缩包里没有可识别的卡带文件。'), 'content')
        return
      }

      const saveBase = cleanSaveBase(options.gameSlug, romName, options.gameName)
      batteryPath = `/data/saves/gambatte/${saveBase}.srm`
      const localIdentity = options.gameSlug && !options.gameSlug.startsWith('local:')
        ? options.gameSlug
        : `local:${romName}`
      batteryStore = makeBatteryStore(`${BATTERY_KEY_PREFIX}${localIdentity}`, batteryPath)
      const remoteSave = typeof options.game === 'string' && Boolean(options.gameSlug) && !options.gameSlug?.startsWith('local:')
      const cartType = new Uint8Array(romData)[0x147]
      const hasMbc3Rtc = cartType === 0x0f || cartType === 0x10
      if (remoteSave && hasMbc3Rtc) {
        console.info('[binjgb] MBC3 RTC 卡带不写入 Gambatte 云存档，避免覆盖含 RTC 数据的 .srm')
      }
      batterySync = remoteSave && !hasMbc3Rtc ? createBatterySync(options.gameSlug!) : null
      // createBatterySync 构造时已开始拉取；与下面的 JS/WASM 初始化并行，核心启动前再应用结果。
      const seedPromise = batterySync ? batterySync.apply(batteryStore.fs) : Promise.resolve('off')
      options.onProgress?.({ phase: 'engine' })
      module = await loadBinjgb()
      if (destroyed) return

      // binjgb 的公开浏览器构建会同时带 WebGL / 2D renderer；本站只创建 2D context。
      const ctx = createAudioContext()
      audioContext = ctx
      const sampleRate = ctx?.sampleRate ?? 44_100
      const romSize = (romData.byteLength + 0x7fff) & ~0x7fff
      romPtr = module._malloc(romSize)
      if (!romPtr) throw new Error('无法为 GB/GBC ROM 分配内存')
      module.HEAPU8.fill(0, romPtr, romPtr + romSize)
      module.HEAPU8.set(new Uint8Array(romData), romPtr)

      // SRAM 与 ROM 并行下载；在核心读取卡带存档前等云端决定，和 EmulatorJS 现有策略一致。
      await seedPromise
      if (destroyed) return
      emulator = module._emulator_new_simple(romPtr, romSize, sampleRate, AUDIO_FRAMES, 2)
      if (!emulator) throw new Error('binjgb 不支持这份卡带或 ROM 文件已损坏')
      module._emulator_set_builtin_palette(emulator, 79)

      try {
        gain = ctx?.createGain() ?? null
        if (gain && ctx) {
          gain.gain.value = 1
          gain.connect(ctx.destination)
        }
      } catch {
        gain = null
      }

      // 云端或本地电池存档按核心要求的精确长度装入；尺寸不匹配时保留文件、不覆盖核心内存。
      const savedRam = batteryStore.seed()
      if (savedRam?.length) {
        const fileData = module._ext_ram_file_data_new(emulator)
        if (fileData) {
          try {
            const size = module._get_file_data_size(fileData)
            if (size === savedRam.length) {
              const ptr = module._get_file_data_ptr(fileData)
              module.HEAPU8.set(savedRam, ptr)
              module._emulator_read_ext_ram(emulator, fileData)
            } else {
              console.warn(`[binjgb] SRAM 大小不匹配，保留现有存档：文件 ${savedRam.length}，核心 ${size}`)
              // Gambatte 的 RTC 存档或其它核心格式不应被当作 binjgb SRAM 再推回同一云档位。
              batterySync?.stop()
              batterySync = null
            }
          } finally {
            module._file_data_delete(fileData)
          }
        }
      }

      // 旧 WebAssembly 内存视图在 grow 后会失效；每次出音频块时重新取当前 view。
      uploadFrame()
      options.onGeometry?.({ width: SCREEN_WIDTH, height: SCREEN_HEIGHT })
      options.onProgress?.({ phase: 'starting', ratio: 1 })
      if (gain) caps.add('volume')
      options.onCaps?.(caps)
      uninstallKeyboard = installPadKeyboard((action, down) => setInput(action, down))
      batteryHandle = startGamepadInput(setPad)
      document.addEventListener('visibilitychange', onVisibilityChange)
      window.addEventListener('pagehide', onPageHide)
      batteryTimer = window.setInterval(() => { void flushBattery() }, 30_000)
      if (!paused) frameRaf = requestAnimationFrame(frame)
      options.onReady?.()

      unlockAudio = () => {
        if (audioContext?.state === 'suspended') void audioContext.resume().catch(() => {})
      }
      window.addEventListener('pointerdown', unlockAudio, { once: true, capture: true })
      window.addEventListener('keydown', unlockAudio, { once: true, capture: true })
      window.addEventListener('touchend', unlockAudio, { once: true, capture: true })
    } catch (error) {
      if (destroyed || aborter.signal.aborted) return
      const message = error instanceof Error ? error.message : String(error)
      const isRomError = !romLoaded || /ROM|zip|压缩包|卡带|游戏文件/i.test(message)
      failAndDispose(error, isRomError ? 'content' : 'runtime')
    }
  })()

  return {
    caps,
    saveMode: 'local',
    saveExt: 'binjgb-state',
    saveMetadata: { core: 'binjgb', build: BINJGB_BUILD, format: 'binjgb-state' },
    setPaused: (next) => {
      paused = next
      if (next) {
        if (frameRaf) cancelAnimationFrame(frameRaf)
        frameRaf = 0
        if (audioContext?.state === 'running') void audioContext.suspend().catch(() => {})
        updateBattery()
      } else if (emulator) {
        lastRafSec = 0
        leftoverTicks = 0
        if (audioContext?.state === 'suspended') void audioContext.resume().catch(() => {})
        frameRaf = requestAnimationFrame(frame)
      }
    },
    setVolume: (volume) => {
      if (gain) gain.gain.value = Math.max(0, Math.min(1, volume))
    },
    sendButton: setPad,
    screenshot: async () => canvasToBlob(canvas),
    nativeVideoSize: () => ({ width: SCREEN_WIDTH, height: SCREEN_HEIGHT }),
    volume: 1,
    saveState: async () => {
      const state = readState()
      if (!state) return null
      const game = options.gameSlug ?? options.gameName
      return new Blob([JSON.stringify({ tag: STATE_TAG, build: BINJGB_BUILD, game, state: toBase64(state) })], { type: 'application/json' })
    },
    loadState: async (data) => {
      if (!module || !emulator) return
      let parsed: unknown
      try {
        parsed = JSON.parse(new TextDecoder().decode(data))
      } catch {
        throw new Error('存档文件无法读取')
      }
      const file = parsed as { tag?: string; build?: string; game?: string; state?: string } | null
      const expectedGame = options.gameSlug ?? options.gameName
      if (!file || file.tag !== STATE_TAG || file.build !== BINJGB_BUILD || file.game !== expectedGame || typeof file.state !== 'string') {
        throw new Error('这不是当前 GB/GBC 游戏的 binjgb 即时存档')
      }
      const state = fromBase64(file.state)
      if (!state) throw new Error('存档内容已损坏')
      const fileData = module._state_file_data_new(emulator)
      if (!fileData) throw new Error('无法分配 GB/GBC 即时存档空间')
      try {
        const size = module._get_file_data_size(fileData)
        if (state.length !== size) throw new Error('即时存档与当前 binjgb 版本不兼容')
        const ptr = module._get_file_data_ptr(fileData)
        module.HEAPU8.set(state, ptr)
        module._emulator_read_state(emulator, fileData)
        uploadFrame()
      } finally {
        module._file_data_delete(fileData)
      }
    },
    captureSources: (): CaptureSources => ({ canvas, audioNode: gain, audioContext }),
    destroy: () => {
      if (destroyed) return
      // 退出前同步最新 SRAM，并把已变化的电池存档交给云端队列。
      updateBattery()
      const endingSync = batterySync
      void flushBattery().finally(() => endingSync?.stop())
      destroyed = true
      aborter.abort()
      destroyCore()
    },
  }
}
