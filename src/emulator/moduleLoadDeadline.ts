/**
 * 运行时适配器模块（runtimes.ts 的 loadMountOf）的加载时限：按「有没有进展」判，不按墙钟。
 *
 * 以前是 60 秒墙钟。2026-11-21 #2756 / #2758（《暴力摩托》，QQ 浏览器 22，大陆 EdgeOne 线路约 6KB/s）：
 *   - 计时从播放器挂载时的**预加载**就开始了（EmulatorPlayer 一挂载就调 loadMountOf），比点「开始」还早 1.2 秒；
 *   - 适配器那串 chunk（jsdos 83KB、romLoader 等）在这条线上要 9～15 秒才陆续到齐，期间一直有进展；
 *   - 到 60 秒整局失败，适配器还没挂载，它自己给加速入口准备的 25 秒改道（js-dos.js）根本没机会跑。
 *
 * 现在：同目录下的 JS / CSS 每完成一个（Resource Timing，含预加载助手的暖缓存 fetch）就重新计时；
 * 连续 idleMs 没有任何一个完成才判超时（真挂死照样失败），另设 maxMs 总上限，慢到离谱也不无限等。
 * Resource Timing 只在请求结束时出条目，所以「进展」是「又有一个文件到齐」，单个文件的字节流看不到；
 * 运行时 chunk 都在几十 KB 以内，6KB/s 也在 idleMs 内能到齐一个。
 */

export const MODULE_LOAD_IDLE_MS = 60_000
export const MODULE_LOAD_MAX_MS = 180_000

export class RuntimeModuleTimeoutError extends Error {
  readonly runtimeModuleTimeout = true
  readonly reason: 'idle' | 'max'
  readonly elapsedMs: number
  readonly progressCount: number
  constructor(message: string, reason: 'idle' | 'max', elapsedMs: number, progressCount: number) {
    super(message)
    this.name = 'RuntimeModuleTimeoutError'
    this.reason = reason
    this.elapsedMs = elapsedMs
    this.progressCount = progressCount
  }
}

export function isRuntimeModuleTimeout(error: unknown): error is RuntimeModuleTimeoutError {
  return Boolean(error && typeof error === 'object' && (error as { runtimeModuleTimeout?: unknown }).runtimeModuleTimeout === true)
}

export interface ModuleLoadDeadlineOptions {
  idleMs?: number
  maxMs?: number
  /** 订阅「又有进展」；返回取消订阅 */
  watchProgress?: (onProgress: () => void) => () => void
  now?: () => number
  /** 超时文案（idle / max 两种） */
  message: (reason: 'idle' | 'max', elapsedMs: number) => string
}

export function raceModuleLoad<T>(loading: Promise<T>, options: ModuleLoadDeadlineOptions): Promise<T> {
  const idleMs = options.idleMs ?? MODULE_LOAD_IDLE_MS
  const maxMs = options.maxMs ?? MODULE_LOAD_MAX_MS
  const now = options.now ?? (() => Date.now())
  const startedAt = now()
  let progressCount = 0
  let idleTimer: ReturnType<typeof setTimeout> | undefined
  let maxTimer: ReturnType<typeof setTimeout> | undefined
  let unwatch: () => void = () => {}
  let rejectTimeout: (error: Error) => void = () => {}
  const fail = (reason: 'idle' | 'max') => {
    const elapsed = now() - startedAt
    rejectTimeout(new RuntimeModuleTimeoutError(options.message(reason, elapsed), reason, elapsed, progressCount))
  }
  const armIdle = () => {
    if (idleTimer !== undefined) clearTimeout(idleTimer)
    idleTimer = setTimeout(() => fail('idle'), idleMs)
  }
  const timeout = new Promise<never>((_, reject) => {
    rejectTimeout = reject
  })
  armIdle()
  maxTimer = setTimeout(() => fail('max'), maxMs)
  try {
    unwatch = options.watchProgress?.(() => {
      progressCount++
      armIdle()
    }) ?? (() => {})
  } catch {
    unwatch = () => {}
  }
  return Promise.race([loading, timeout]).finally(() => {
    if (idleTimer !== undefined) clearTimeout(idleTimer)
    if (maxTimer !== undefined) clearTimeout(maxTimer)
    try { unwatch() } catch { /* 观察器已断开 */ }
  })
}

/** 只用到的 Resource Timing 字段（测试里给普通对象） */
export interface ModuleResourceLike {
  name: string
  transferSize?: number
  decodedBodySize?: number
  responseStatus?: number
}

/** 这条资源完成记录算不算「模块加载有进展」：同一资源目录下的 JS / CSS，且确实拿到了内容 */
export function isModuleProgressEntry(entry: ModuleResourceLike, assetsDir: string): boolean {
  const url = String(entry.name || '')
  if (!assetsDir || !url.startsWith(assetsDir)) return false
  if (!/\.(?:m?js|css)(?:[?#]|$)/.test(url)) return false
  const status = typeof entry.responseStatus === 'number' ? entry.responseStatus : 0
  if (status >= 400) return false
  return (entry.decodedBodySize ?? 0) > 0 || (entry.transferSize ?? 0) > 0 || (status >= 200 && status < 400)
}

/** 浏览器里：用 PerformanceObserver 盯同目录资源的完成；不支持时返回空订阅（退化成纯 idle 计时） */
export function watchModuleResources(assetsDir: string): (onProgress: () => void) => () => void {
  return (onProgress) => {
    if (typeof PerformanceObserver !== 'function' || !assetsDir) return () => {}
    let observer: PerformanceObserver | null = null
    try {
      observer = new PerformanceObserver((list) => {
        for (const entry of list.getEntries() as unknown as ModuleResourceLike[]) {
          if (isModuleProgressEntry(entry, assetsDir)) {
            onProgress()
            return
          }
        }
      })
      observer.observe({ type: 'resource', buffered: false })
    } catch {
      observer = null
    }
    return () => observer?.disconnect()
  }
}
