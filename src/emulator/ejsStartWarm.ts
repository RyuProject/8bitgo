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
    const done = () => {
      if (settled) return
      settled = true
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
      const db = request.result
      const finish = () => {
        try { db.close() } catch { /* 已关闭 */ }
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
        const query = index.count(url)
        query.onsuccess = () => {
          if (query.result > 0) found.add(url)
          if (--pending === 0) finish()
        }
        query.onerror = () => {
          if (--pending === 0) finish()
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
}

/**
 * 开局点击后立刻调用。不 await 也不抛错：预热失败的后果只是「和以前一样慢」。
 * `warm` 可注入，便于测试；默认写 HTTP 缓存。
 */
export async function warmEmulatorJsStart(
  plan: EjsStartWarmPlan,
  { idb, warm = warmHttpCache, assumeUncached = false }: {
    idb?: IdbFactoryLike
    warm?: (url: string) => void
    /**
     * 引擎缓存这一局马上要被清掉（EJS_CACHE_GENERATION 换代，见 purgePoisonedEngineCache）：
     * 库里「有」的核心几百毫秒后就没了。以前照查不误 → 判定已缓存 → 不预热 → 清库 →
     * 每次换代后所有回访玩家都串行冷下核心。
     */
    assumeUncached?: boolean
  } = {},
): Promise<string[]> {
  const started: string[] = []
  for (const url of plan.always) {
    if (!url) continue
    warm(url)
    started.push(url)
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
    if (cached.has(url)) continue
    warm(url)
    started.push(url)
  }
  return started
}
