export interface RufflePerformanceProfile {
  maxPixelRatio: number
  tier: 'economy' | 'balanced' | 'full'
}

export interface RuffleDeviceHints {
  deviceMemory?: number
  hardwareConcurrency?: number
  devicePixelRatio?: number
  maxTouchPoints?: number
}

export const RUFFLE_RENDER_PIXEL_RATIO = 1.25
export const RUFFLE_ADAPTIVE_PIXEL_RATIOS = [0.8, 1, RUFFLE_RENDER_PIXEL_RATIO] as const

export interface RuffleFrameSample {
  frameCount: number
  callbackCount: number
  durationMs: number
  p25IntervalMs: number
  p90IntervalMs: number
  p90CallbackMs: number
  lateFrameRatio: number
}

export interface RuffleFrameTelemetry {
  sample: () => RuffleFrameSample
  discard: () => void
  stop: () => void
}

export interface RufflePixelRatioController {
  supported: boolean
  current: () => number
  setCap: (cap: number) => number
}

export interface RuffleAdaptiveControllerOptions {
  telemetry: Pick<RuffleFrameTelemetry, 'sample' | 'discard'>
  pixelRatio: RufflePixelRatioController
  initialTier: RufflePerformanceProfile['tier']
  frameRate: number
  onChange?: (state: { tier: RufflePerformanceProfile['tier']; pixelRatio: number; reason: 'slow' | 'recovered' }) => void
}

export interface RuffleAdaptiveController {
  sample: () => void
  discard: () => void
  stop: () => void
  currentTier: () => RufflePerformanceProfile['tier']
}

/**
 * Ruffle 没有公开的实时 FPS 计数器或不中断游戏的运行中画质 setter。
 * 首屏按浏览器提供的粗略硬件能力信号选择渲染像素比；这不是性能基准，不能单独代表显卡速度。
 * 绝不为了“匹配帧数”覆写游戏帧率或重载当前游戏。
 */
export function selectRufflePerformanceProfile(hints: RuffleDeviceHints): RufflePerformanceProfile {
  const cores = positiveHint(hints.hardwareConcurrency)
  const memory = positiveHint(hints.deviceMemory)
  const pixelRatio = positiveHint(hints.devicePixelRatio)
  const touchPoints = positiveHint(hints.maxTouchPoints) ?? 0

  if ((cores !== null && cores <= 2) || (memory !== null && memory <= 2)) {
    return { tier: 'economy', maxPixelRatio: 0.8 }
  }

  const hasWeakSignal = (cores !== null && cores <= 4) || (memory !== null && memory <= 4)
  const highDpiTouchDevice = touchPoints > 0 && pixelRatio !== null && pixelRatio >= 2.5
  const lacksUsefulHints = cores === null && memory === null
  if (hasWeakSignal || highDpiTouchDevice || lacksUsefulHints) {
    return { tier: 'balanced', maxPixelRatio: 1 }
  }

  return { tier: 'full', maxPixelRatio: RUFFLE_RENDER_PIXEL_RATIO }
}

function positiveHint(value: unknown): number | null {
  const number = Number(value)
  return Number.isFinite(number) && number > 0 ? number : null
}

type PixelRatioTarget = { devicePixelRatio: number }

/** 在 iframe 内动态限制 Ruffle 的 backing-store 像素比；Flash 的 Stage.quality 在 Ruffle 中目前不影响渲染。 */
export function installRufflePixelRatioController(
  target: PixelRatioTarget,
  maxPixelRatio = RUFFLE_RENDER_PIXEL_RATIO,
): RufflePixelRatioController {
  let current = 1
  try {
    const observed = Number(target.devicePixelRatio)
    if (Number.isFinite(observed) && observed > 0) current = observed
  } catch {
    /* 部分 WebView 的窗口属性可能在 iframe 卸载边缘抛错；保留安全默认值，不能阻断启动。 */
  }
  let cap = validPixelRatio(maxPixelRatio, RUFFLE_RENDER_PIXEL_RATIO)
  let nativeRatio = current
  let nativeGetter: (() => number) | null = null
  let prototype: object | null = target
  try {
    while (prototype && !nativeGetter) {
      const descriptor = Object.getOwnPropertyDescriptor(prototype, 'devicePixelRatio')
      if (typeof descriptor?.get === 'function') nativeGetter = () => Number(descriptor.get!.call(target))
      prototype = Object.getPrototypeOf(prototype)
    }
  } catch {
    nativeGetter = null
  }
  const readNative = () => {
    try {
      const value = nativeGetter?.()
      if (Number.isFinite(value) && value! > 0) nativeRatio = value!
    } catch {
      /* 原生 DPR 暂时不可读时沿用最后一次有效值。 */
    }
    return nativeRatio
  }
  const getCurrent = () => {
    try {
      const observed = Number(target.devicePixelRatio)
      return Number.isFinite(observed) && observed > 0 ? observed : current
    } catch {
      return current
    }
  }
  const controller: RufflePixelRatioController = {
    supported: false,
    current: getCurrent,
    setCap: (nextCap) => {
      cap = validPixelRatio(nextCap, cap)
      return getCurrent()
    },
  }

  try {
    Object.defineProperty(target, 'devicePixelRatio', {
      configurable: true,
      get: () => Math.min(readNative(), cap),
    })
  } catch {
    return controller
  }
  controller.supported = true
  return controller
}

/** 兼容既有调用方与测试；新代码应保留 controller 以便运行中降档。 */
export function installRufflePixelRatioCap(target: PixelRatioTarget, maxPixelRatio = RUFFLE_RENDER_PIXEL_RATIO): number {
  return installRufflePixelRatioController(target, maxPixelRatio).current()
}

/**
 * 在专用 Ruffle iframe 中采样 requestAnimationFrame 回调时长与间隔。
 * 只包装 iframe 自己的调度，不读取 ROM/输入，也不触碰父页面；不能安装时安全退化为硬件档位。
 */
export function installRuffleFrameTelemetry(target: {
  requestAnimationFrame?: (callback: (timestamp: number) => void) => number
  performance?: { now?: () => number }
}): RuffleFrameTelemetry | null {
  const nativeRequest = target.requestAnimationFrame
  if (typeof nativeRequest !== 'function') return null

  const originalDescriptor = Object.getOwnPropertyDescriptor(target, 'requestAnimationFrame')
  const intervalSamples = new Float64Array(480)
  const callbackSamples = new Float64Array(480)
  // 复用排序缓冲区，避免每 3 秒采样时创建多组数组；逐帧热路径只写定长环形缓冲。
  const intervalScratch = new Float64Array(intervalSamples.length)
  const callbackScratch = new Float64Array(callbackSamples.length)
  let writeIndex = 0
  let size = 0
  let callbackWriteIndex = 0
  let callbackSize = 0
  let previousTimestamp: number | null = null
  let active = true
  const wrappedCallbacks = new WeakMap<Function, FrameRequestCallback>()
  const readClock = () => {
    try {
      const value = target.performance?.now?.()
      return Number.isFinite(value) ? Number(value) : Date.now()
    } catch {
      return Date.now()
    }
  }
  let lastSampleAt = readClock()
  const wrapped = function (this: unknown, callback: FrameRequestCallback): number {
    // 保持浏览器原生的参数校验与非法 this 行为，监控不改变 RAF API 语义。
    if (typeof callback !== 'function') return nativeRequest.call(this, callback)
    let measuredCallback = wrappedCallbacks.get(callback)
    if (!measuredCallback) {
      measuredCallback = function (this: unknown, timestamp: number) {
        const startedAt = readClock()
        try {
          callback.call(this, timestamp)
        } finally {
          if (active) {
            const duration = Math.max(0, readClock() - startedAt)
            callbackSamples[callbackWriteIndex] = duration
            callbackWriteIndex = (callbackWriteIndex + 1) % callbackSamples.length
            callbackSize = Math.min(callbackSize + 1, callbackSamples.length)
            if (Number.isFinite(timestamp) && previousTimestamp !== null && timestamp > previousTimestamp) {
              const interval = timestamp - previousTimestamp
              intervalSamples[writeIndex] = interval
              writeIndex = (writeIndex + 1) % intervalSamples.length
              size = Math.min(size + 1, intervalSamples.length)
            }
            if (Number.isFinite(timestamp) && (previousTimestamp === null || timestamp > previousTimestamp)) {
              previousTimestamp = timestamp
            } else if (Number.isFinite(timestamp) && previousTimestamp !== null && timestamp < previousTimestamp) {
              // 浏览器恢复 / 时钟重置时重新建立基线，不把负间隔折成一个假的超长帧。
              previousTimestamp = timestamp
            }
          }
        }
      }
      wrappedCallbacks.set(callback, measuredCallback)
    }
    return nativeRequest.call(this, measuredCallback)
  }

  try {
    Object.defineProperty(target, 'requestAnimationFrame', {
      configurable: true,
      enumerable: originalDescriptor?.enumerable ?? true,
      writable: true,
      value: wrapped,
    })
  } catch {
    return null
  }

  const clear = () => {
    size = 0
    writeIndex = 0
    callbackSize = 0
    callbackWriteIndex = 0
    previousTimestamp = null
    lastSampleAt = readClock()
  }
  return {
    sample() {
      const now = readClock()
      const sampleCount = size
      for (let offset = 0; offset < sampleCount; offset++) {
        const index = (writeIndex - sampleCount + offset + intervalSamples.length) % intervalSamples.length
        intervalScratch[offset] = intervalSamples[index]!
      }
      const callbackCount = callbackSize
      for (let offset = 0; offset < callbackCount; offset++) {
        const index = (callbackWriteIndex - callbackCount + offset + callbackSamples.length) % callbackSamples.length
        callbackScratch[offset] = callbackSamples[index]!
      }
      const durationMs = Math.max(0, now - lastSampleAt)
      const p25Interval = percentile(intervalScratch, sampleCount, 0.25)
      const p90Interval = percentile(intervalScratch, sampleCount, 0.9)
      const p90Callback = percentile(callbackScratch, callbackCount, 0.9)
      // 不把稳定的 30 Hz 屏幕误当成每帧都掉帧；明显超过本窗稳定节奏两倍才计作长间隔。
      const lateIntervalThreshold = Math.max(1000 / 240, p25Interval || 1000 / 60) * 2.2
      let lateFrames = 0
      for (let offset = 0; offset < sampleCount; offset++) {
        if (intervalScratch[offset]! > lateIntervalThreshold) lateFrames++
      }
      lastSampleAt = now
      clear()
      return {
        frameCount: sampleCount,
        callbackCount,
        durationMs,
        p25IntervalMs: p25Interval,
        p90IntervalMs: p90Interval,
        p90CallbackMs: p90Callback,
        lateFrameRatio: sampleCount ? lateFrames / sampleCount : 0,
      }
    },
    discard: clear,
    stop() {
      active = false
      clear()
      try {
        if (originalDescriptor) Object.defineProperty(target, 'requestAnimationFrame', originalDescriptor)
        else delete (target as { requestAnimationFrame?: unknown }).requestAnimationFrame
      } catch {
        /* iframe 销毁时失败也不会影响游戏；回调会在 iframe 一起释放 */
      }
    },
  }
}

/** 两个慢窗口降一档，持续 30 秒余量才恢复，避免复杂场景中画质来回跳。 */
export function createRuffleAdaptiveController(options: RuffleAdaptiveControllerOptions): RuffleAdaptiveController {
  const initialLevel = tierLevel(options.initialTier)
  const maxLevel = initialLevel
  let level = initialLevel
  let slowWindows = 0
  let goodWindows = 0
  let cooldown = 0
  let stopped = false
  const budgetMs = Math.max(1000 / 60, 1000 / clamp(options.frameRate, 1, 120, 60))
  const apply = (next: number, reason: 'slow' | 'recovered') => {
    level = clamp(next, 0, maxLevel, 0)
    const pixelRatio = options.pixelRatio.setCap(RUFFLE_ADAPTIVE_PIXEL_RATIOS[level]!)
    const tier = levelTier(level)
    options.onChange?.({ tier, pixelRatio, reason })
  }

  return {
    currentTier: () => levelTier(level),
    sample() {
      if (stopped) return
      const sample = options.telemetry.sample()
      // 低帧率 SWF 也要能进入判断；12 个样本约等于每秒 4 帧，低于此值数据不足以稳健调档。
      if (sample.frameCount < 12 || sample.durationMs < 1500) {
        slowWindows = 0
        goodWindows = 0
        cooldown = 0
        return
      }
      if (cooldown > 0) cooldown--

      // 用游戏目标帧间隔与当前稳定 RAF 间隔中较宽的一项，避免把 30 FPS 内容或 30 Hz 屏误判成掉帧。
      // p90 明显超过预算则补捉 GPU / 合成拥塞导致的长间隔；回调耗时仍负责识别 CPU 主线程瓶颈。
      const frameBudgetMs = Math.max(budgetMs, sample.p25IntervalMs || 0)
      const pacingIsSlow = sample.p90IntervalMs >= frameBudgetMs * 1.35
      const isSlow = sample.p90CallbackMs >= Math.max(5, budgetMs * 0.42)
        || pacingIsSlow
        || sample.lateFrameRatio >= 0.2
      const hasHeadroom = sample.p90CallbackMs <= budgetMs * 0.2
        && sample.p90IntervalMs <= frameBudgetMs * 1.1
        && sample.lateFrameRatio <= 0.03

      if (isSlow) {
        slowWindows++
        goodWindows = 0
        if (slowWindows >= 2 && level > 0 && cooldown === 0) {
          apply(level - 1, 'slow')
          slowWindows = 0
          cooldown = 5
        }
      } else if (hasHeadroom) {
        goodWindows++
        slowWindows = 0
        if (goodWindows >= 10 && level < maxLevel && cooldown === 0) {
          apply(level + 1, 'recovered')
          goodWindows = 0
          cooldown = 5
        }
      } else {
        slowWindows = 0
        goodWindows = 0
      }
    },
    discard() {
      if (stopped) return
      options.telemetry.discard()
      slowWindows = 0
      goodWindows = 0
      cooldown = 0
    },
    stop() {
      stopped = true
      slowWindows = 0
      goodWindows = 0
    },
  }
}

function percentile(values: Float64Array, length: number, fraction: number): number {
  if (!length) return 0
  // 调用方传入专用 scratch 数组；原始环形样本顺序不受排序影响。
  values.subarray(0, length).sort()
  return values[Math.min(length - 1, Math.max(0, Math.ceil(length * fraction) - 1))]!
}

function validPixelRatio(value: number, fallback: number): number {
  return Number.isFinite(value) && value > 0 ? Math.max(0.5, Math.min(value, 3)) : fallback
}

function tierLevel(tier: RufflePerformanceProfile['tier']): number {
  return tier === 'full' ? 2 : tier === 'balanced' ? 1 : 0
}

function levelTier(level: number): RufflePerformanceProfile['tier'] {
  return level >= 2 ? 'full' : level === 1 ? 'balanced' : 'economy'
}

function clamp(value: number, minimum: number, maximum: number, fallback: number): number {
  return Number.isFinite(value) ? Math.max(minimum, Math.min(maximum, value)) : fallback
}

/**
 * Ruffle 会按这五项能力在增强版 / 兼容版 WASM 之间二选一。
 * 预热必须做同样的选择；猜错会先白下约 14 MB，再由 Ruffle 下载另一份。
 */
const WASM_EXTENSION_PROBES = [
  [0, 97, 115, 109, 1, 0, 0, 0, 1, 4, 1, 96, 0, 0, 3, 2, 1, 0, 5, 3, 1, 0, 1, 10, 14, 1, 12, 0, 65, 0, 65, 0, 65, 0, 252, 10, 0, 0, 11],
  [0, 97, 115, 109, 1, 0, 0, 0, 1, 5, 1, 96, 0, 1, 123, 3, 2, 1, 0, 10, 10, 1, 8, 0, 65, 0, 253, 15, 253, 98, 11],
  [0, 97, 115, 109, 1, 0, 0, 0, 1, 4, 1, 96, 0, 0, 3, 2, 1, 0, 10, 12, 1, 10, 0, 67, 0, 0, 0, 0, 252, 0, 26, 11],
  [0, 97, 115, 109, 1, 0, 0, 0, 1, 4, 1, 96, 0, 0, 3, 2, 1, 0, 10, 8, 1, 6, 0, 65, 0, 192, 26, 11],
  [0, 97, 115, 109, 1, 0, 0, 0, 1, 4, 1, 96, 0, 0, 3, 2, 1, 0, 10, 7, 1, 5, 0, 208, 112, 26, 11],
] as const

export function supportsRuffleWasmExtensions(
  validate: (bytes: BufferSource) => boolean = WebAssembly.validate,
): boolean {
  try {
    return WASM_EXTENSION_PROBES.every((probe) => validate(new Uint8Array(probe)))
  } catch {
    return false
  }
}
