/**
 * 点击「开始游戏」之后、ROM 还在下载时，把 EmulatorJS 开局必经的文件先拉进 HTTP 缓存。
 *
 * ── 为什么 ──
 * 冷启动是一条串行链：ROM（街机走我们自己的预下载 + 8BG 解密）→ loader.js →
 * emulator.min.js → css → 核心报告 → 核心（FBNeo 8MB）→ 7z 解压 → 平台 BIOS。
 * 2026-10-25 线上《恐龙快打》冷启动实测 14.7 秒，其中核心下载 6.1 秒完全排在 ROM 的
 * 2.7 秒之后，BIOS 又排在核心解压之后。这几样彼此没有数据依赖，并行即可。
 *
 * ── 为什么要先查引擎的 IndexedDB ──
 * 引擎把下载过的核心 / BIOS 存进 `EmulatorJS-Cache`（键是请求 URL），二次开局直接
 * 从库里取、不发网络请求。HTTP 缓存却可能早被浏览器清掉了：这时盲目预热就是平白再下
 * 8MB。所以只在引擎库里**没有**这个 URL 时才预热。
 *
 * ⚠️ 打开库时绝不能顺手把它建出来：引擎用 `open(name, 1)` + onupgradeneeded 建表；
 * 如果我们先建了一个**空的** v1 库，引擎那次 open 不再触发升级，`cache` 表永远不存在，
 * 整个核心缓存就坏了。所以 onupgradeneeded 里直接 abort，当作「没有缓存」。
 */
import { warmHttpCache } from './httpWarm'

const EJS_CACHE_DB = 'EmulatorJS-Cache'
const EJS_CACHE_STORE = 'cache'
/** 查库最多等这么久；IndexedDB 卡住时宁可预热，也不能拖住开局。 */
const LOOKUP_TIMEOUT_MS = 400

type IdbFactoryLike = Pick<IDBFactory, 'open'>

/** 引擎缓存里有没有这些 URL。返回「已有」的集合；库不存在、打不开、超时都当作没有。 */
export function ejsCachedUrls(urls: readonly string[], idb: IdbFactoryLike | undefined = globalThis.indexedDB): Promise<Set<string>> {
  const found = new Set<string>()
  if (!idb || !urls.length) return Promise.resolve(found)
  return new Promise((resolve) => {
    let settled = false
    let db: IDBDatabase | undefined
    const done = () => {
      if (settled) return
      settled = true
      // 超时后也要关闭已经打开的连接；IndexedDB 请求不 settle 时，留着连接会阻塞引擎升级。
      try { db?.close() } catch { /* 已关闭 */ }
      resolve(found)
    }
    const timer = setTimeout(done, LOOKUP_TIMEOUT_MS)
    let request: IDBOpenDBRequest
    try {
      request = idb.open(EJS_CACHE_DB)
    } catch {
      clearTimeout(timer)
      done()
      return
    }
    request.onupgradeneeded = () => {
      // 库原本不存在：取消这次升级，不能留下一个没有 cache 表的空库给引擎。
      try { request.transaction?.abort() } catch { /* 已经结束 */ }
    }
    request.onerror = () => {
      clearTimeout(timer)
      done()
    }
    request.onblocked = () => {
      clearTimeout(timer)
      done()
    }
    request.onsuccess = () => {
      db = request.result
      // 打开数据库可能晚于 400ms 超时；不能让迟到的连接留在后台。
      if (settled) {
        try { db.close() } catch { /* 已关闭 */ }
        return
      }
      const finish = () => {
        clearTimeout(timer)
        done()
      }
      if (!db.objectStoreNames.contains(EJS_CACHE_STORE)) return finish()
      let index: IDBIndex
      try {
        const store = db.transaction(EJS_CACHE_STORE, 'readonly').objectStore(EJS_CACHE_STORE)
        if (!store.indexNames.contains('url')) return finish()
        index = store.index('url')
      } catch {
        return finish()
      }
      let pending = urls.length
      for (const url of urls) {
        try {
          const query = index.count(url)
          query.onsuccess = () => {
            if (query.result > 0) found.add(url)
            if (--pending === 0) finish()
          }
          query.onerror = () => {
            if (--pending === 0) finish()
          }
        } catch {
          // 坏索引同步抛错时直接当作缓存未命中，不能把开局预热卡到超时。
          finish()
          return
        }
      }
    }
  })
}

export interface EjsStartWarmPlan {
  /** 小文件：引擎入口、样式、核心报告。已在 HTTP 缓存里时 force-cache 不发请求。 */
  always: string[]
  /** 大文件（核心、平台 BIOS）：引擎缓存里没有时才预热。 */
  large: string[]
  /** 只在本局核心不在引擎缓存时需要的资源，例如核心压缩包的解压脚本。 */
  coreMiss?: string[]
}

export type EjsCoreWarmEvent = 'start' | 'complete' | 'cached'
export type EjsCoreWarmMetric = 'core_warm_start' | 'core_warm_complete' | 'core_cache_hit'
export interface EjsCoreWarmObservation {
  attemptId: string
  coreKey: string
  complete: boolean
}

/** 同一次开局只统计首个核心，且完成事件必须来自它，避免换核心重试串成一段耗时。 */
export function observeEjsCoreWarmEvent(
  current: EjsCoreWarmObservation | null,
  attemptId: string,
  coreKey: string,
  event: EjsCoreWarmEvent,
): { observation: EjsCoreWarmObservation | null; metric?: EjsCoreWarmMetric } {
  if (event === 'start') {
    if (current?.attemptId === attemptId) return { observation: current }
    return { observation: { attemptId, coreKey, complete: false }, metric: 'core_warm_start' }
  }
  if (event === 'cached') {
    if (current?.attemptId === attemptId) return { observation: current }
    return { observation: { attemptId, coreKey, complete: true }, metric: 'core_cache_hit' }
  }
  if (current?.attemptId !== attemptId || current.coreKey !== coreKey || current.complete) {
    return { observation: current }
  }
  return { observation: { ...current, complete: true }, metric: 'core_warm_complete' }
}

/**
 * 开局点击后立刻调用。不 await 也不抛错：预热失败的后果只是「和以前一样慢」。
 * `warm` 可注入，便于测试；默认写 HTTP 缓存。
 */
export async function warmEmulatorJsStart(
  plan: EjsStartWarmPlan,
  { idb, warm = warmHttpCache, assumeUncached = false, coreDataUrl, coreKey, onCoreWarmEvent }: {
    idb?: IdbFactoryLike
    warm?: (url: string) => void | boolean | PromiseLike<boolean | void>
    /** 本局将使用的核心数据文件；只观测这一条大资源。 */
    coreDataUrl?: string
    /** 内部配对标记，不上报 URL 或资源路径。 */
    coreKey?: string
    onCoreWarmEvent?: (event: EjsCoreWarmEvent, coreKey: string) => void
    /**
     * 引擎缓存这一局马上要被清掉（EJS_CACHE_GENERATION 换代，见 purgePoisonedEngineCache）：
     * 库里「有」的核心几百毫秒后就没了。以前照查不误 → 判定已缓存 → 不预热 → 清库 →
     * 每次换代后所有回访玩家都串行冷下核心。
     */
    assumeUncached?: boolean
  } = {},
): Promise<string[]> {
  const started: string[] = []
  const notifyCore = (url: string, event: EjsCoreWarmEvent) => {
    if (url !== coreDataUrl) return
    try { onCoreWarmEvent?.(event, coreKey ?? '') } catch { /* 观测回调不能打断游戏预热 */ }
  }
  const beginWarm = (url: string) => {
    notifyCore(url, 'start')
    const result = warm(url)
    started.push(url)
    if (url === coreDataUrl && result && typeof result === 'object' && 'then' in result) {
      void Promise.resolve(result).then((ok) => {
        if (ok !== false) notifyCore(url, 'complete')
      }, () => {})
    } else if (url === coreDataUrl && result !== false) {
      notifyCore(url, 'complete')
    }
  }
  for (const url of plan.always) {
    if (!url) continue
    beginWarm(url)
  }
  const large = plan.large.filter(Boolean)
  if (!large.length) return started
  let cached: Set<string>
  try {
    cached = assumeUncached ? new Set() : await ejsCachedUrls(large, idb ?? globalThis.indexedDB)
  } catch {
    cached = new Set()
  }
  for (const url of large) {
    if (cached.has(url)) {
      notifyCore(url, 'cached')
      continue
    }
    beginWarm(url)
  }
  // 核心命中时引擎不再解压 .data；此时单独预热 7z 脚本只会浪费带宽与解码工作。
  if (!coreDataUrl || !cached.has(coreDataUrl)) {
    for (const url of plan.coreMiss ?? []) {
      if (url) beginWarm(url)
    }
  }
  return started
}
