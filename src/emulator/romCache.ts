/**
 * ROM 本地缓存（IndexedDB）。
 *
 * 为什么值得做：ROM 是不可变的二进制，同一个玩家反复玩同一款游戏，现在每次都要
 * 重新从 R2 拉一遍。PSX / NDS 动辄几百 MB，第二次进游戏本该是瞬开的。
 * 命中之后是零网络请求，比任何传输层优化（并发 Range、P2P）都直接。
 *
 * 为什么单开一个数据库，而不是往 lib/idb.ts 的 `8bitgo` 里加 store：
 * 那边放的是**玩家存档**。加 store 要升 DB 版本号，而升级会在「另一个标签页还开着
 * 旧版本」时卡在 onblocked。存档丢不起，不值得为一个缓存去动它 —— 缓存没了顶多
 * 重下一次，两者的容灾级别不一样，物理上分开最省心。
 *
 * 缓存键 = 完整播放 URL。services/roms.ts 的 probeRomUrl 会把对象 ETag 拼成
 * `?romv=<etag>` 带进播放地址，所以 URL 本身就是内容寻址的：R2 上覆盖同一个 key 之后
 * etag 变、URL 变，自然不会命中旧的那份。**没有 romv 的地址一律不缓存** ——
 * 那种情况下没法判断远端内容换没换，而「半截 / 过期 ROM 复活」是这个项目栽过的坑
 * （见 AGENTS.md §2.6），宁可不缓存。
 *
 * 所有失败都是静默的：无痕模式、配额满、用户禁用站点数据 —— 缓存只是加速，
 * 任何一步出错都必须退回「正常从网络下载」，不能让玩家玩不了游戏。
 *
 * ⚠️ 两套读写接口，按 ROM 大小分：
 *   - romCacheGet / romCachePut：ArrayBuffer，给卡带机 ROM 和街机 ZIP 用，
 *     调用方拿到字节本体去嗅探格式（listZipEntries、iNES 文件头之类）。
 *   - romCacheGetBlob / romCachePutBlob：Blob，给光盘镜像用。几百 MB 到几 GB 的盘
 *     不能走上面那条 —— 那要求一整块连续内存，手机上分配不出来。
 */

const DB_NAME = '8bitgo-roms'
const DB_VERSION = 1
/** 字节本体 */
const STORE_BLOB = 'blobs'
/** 只放 { size, storedAt, lastUsedAt }。LRU 淘汰要遍历全部条目，读元信息不该把几 GB 字节也拖出来 */
const STORE_META = 'meta'

/**
 * 单个对象上限，分两档。
 *
 * **ArrayBuffer 档 200MB**：走这条路的字节最终要在内存里连成一整块（卡带机 ROM、
 * 街机 ZIP），几百 MB 的连续分配在手机上本来就容易失败，缓存再大也没意义。
 *
 * **Blob 档 4GB**：光盘镜像走这条（见 romCachePutBlob）。Blob 不需要连续内存，
 * 浏览器会把大的落到磁盘上，所以这里的上限只受配额约束 —— 而配额那道在下面
 * `size > budget / 2` 单独管：一张盘再大也不能占掉全部预算，
 * 否则玩第二款游戏时会把第一款整个挤掉，两款轮流玩就是每次都重下。
 */
const MAX_ENTRY_BYTES = 200 * 1024 * 1024

/** 最近一次「没能缓存」的原因，给 romCacheStats() 和排查用 */
let lastSkip: { key: string; size: number; why: string; at: number } | null = null

/** 跳过缓存时留个痕迹 —— 静默跳过会让人怀疑整个缓存坏了 */
function skip(key: string, size: number, why: string): void {
  lastSkip = { key, size, why, at: Date.now() }
  console.debug(`[romCache] 跳过缓存：${why}（${Math.round(size / 1048576)}MB）${key}`)
}

/** 给设置页 / 排查用：最近一次跳过的原因 */
export function romCacheLastSkip() {
  return lastSkip
}
const MAX_BLOB_ENTRY_BYTES = 4 * 1024 * 1024 * 1024

/** 只占配额的一半，另一半留给存档、EmulatorJS-Cache 和浏览器自己的 HTTP 缓存 */
const BUDGET_RATIO = 0.5

/** 拿不到 storage.estimate() 时的保守预算 */
const FALLBACK_BUDGET = 1024 * 1024 * 1024

/** 无论浏览器给多少配额都不超过这个数。Chrome 能给到几十 GB，不该全拿走 */
const HARD_MAX_BUDGET = 8 * 1024 * 1024 * 1024

interface MetaEntry {
  size: number
  storedAt: number
  lastUsedAt: number
}

/**
 * 缓存里存的两种形态。
 * ArrayBuffer = 小 ROM（调用方要字节本体去嗅探格式）；Blob = 光盘镜像（只需要一个 URL）。
 * 同一个 store 里混着放没问题（结构化克隆两种都认），但**读的时候必须判类型** ——
 * 把 Blob 当 ArrayBuffer 返回给嗅探代码，症状会是「ROM 格式无法识别」而不是类型错误。
 */
type CacheValue = ArrayBuffer | Blob

const sizeOf = (v: CacheValue): number => (v instanceof Blob ? v.size : v.byteLength)

let dbPromise: Promise<IDBDatabase | null> | null = null

function openDb(): Promise<IDBDatabase | null> {
  if (dbPromise) return dbPromise
  dbPromise = new Promise((resolve) => {
    // 无痕模式、禁用站点数据、SSR —— 一律当作「没有本地存储」，不要抛错
    if (typeof indexedDB === 'undefined') return resolve(null)
    let req: IDBOpenDBRequest
    try {
      req = indexedDB.open(DB_NAME, DB_VERSION)
    } catch {
      return resolve(null)
    }
    req.onupgradeneeded = () => {
      const db = req.result
      if (!db.objectStoreNames.contains(STORE_BLOB)) db.createObjectStore(STORE_BLOB)
      if (!db.objectStoreNames.contains(STORE_META)) db.createObjectStore(STORE_META)
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => resolve(null)
    // 别的标签页占着旧版本时会一直卡在 blocked，给个出口别让调用方永远等
    req.onblocked = () => resolve(null)
  })
  return dbPromise
}

/** 把一个 IDBRequest 包成 Promise；失败一律解析成 null，不抛 */
function ask<T>(req: IDBRequest<T>): Promise<T | null> {
  return new Promise((resolve) => {
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => resolve(null)
  })
}

/**
 * 这个播放地址能不能缓存。返回 '' 表示不缓存。
 *
 * blob: / data: 是本地文件转出来的，本来就没走网络；
 * 没有 romv（内容版本号）的地址见文件头注释。
 */
export function romCacheKey(url: string): string {
  if (!url || /^(blob|data):/i.test(url)) return ''
  if (!/[?&]romv=/.test(url)) return ''
  return url
}

/** 读缓存。命中返回字节，未命中返回 null */
export async function romCacheGet(key: string): Promise<ArrayBuffer | null> {
  if (!key) return null
  const db = await openDb()
  if (!db) return null
  let value: unknown
  try {
    value = await ask(db.transaction(STORE_BLOB, 'readonly').objectStore(STORE_BLOB).get(key))
  } catch {
    return null
  }
  if (!(value instanceof ArrayBuffer) || value.byteLength === 0) return null
  // 命中时间是异步更新的，不阻塞开局
  void touch(db, key)
  return value
}

/**
 * 读缓存，要一个 Blob。
 *
 * 存进去的是 ArrayBuffer 时也照样返回（包一层，零拷贝的视图，不额外占内存）——
 * 这样先按小 ROM 缓存过、后来平台改判成光盘的那些条目不会白白落空。
 */
export async function romCacheGetBlob(key: string, type = 'application/octet-stream'): Promise<Blob | null> {
  if (!key) return null
  const db = await openDb()
  if (!db) return null
  let value: unknown
  try {
    value = await ask(db.transaction(STORE_BLOB, 'readonly').objectStore(STORE_BLOB).get(key))
  } catch {
    return null
  }
  let blob: Blob | null = null
  if (value instanceof Blob && value.size > 0) blob = value.type === type ? value : new Blob([value], { type })
  else if (value instanceof ArrayBuffer && value.byteLength > 0) blob = new Blob([value], { type })
  if (!blob) return null
  void touch(db, key)
  return blob
}

/**
 * 更新最近使用时间，喂给 LRU。
 *
 * ⚠️ 读和写必须在**同一个 readwrite 事务**里，中间不能 await。
 *
 * 以前是「只读事务读出来 → await → 另开读写事务写回去」。IndexedDB 的事务在 await
 * 处会自动提交，于是这两步之间是一个真空期：调用方那边 `void touch(...)` 从不 await，
 * 而紧接着的 romCachePut → ensureRoom 完全可能按 LRU 把这一条淘汰掉（blob 和 meta 一起删）。
 * 后落地的 put 又**把 meta 重新建出来**，而字节已经没了 —— 一条「有元信息没内容」的孤儿。
 * 孤儿带着原来的 size 永远算进 ensureRoom 的总量，而且 lastUsedAt 是刚刚、最后才轮到被淘汰：
 * 攒几次之后缓存就再也放不进新东西，玩家的大 ROM（PSX / NDS）每次进游戏都重下几百 MB，
 * 没有任何提示，romCacheStats() 报的占用也和实际对不上，排查时会被带偏。
 * 放进同一个事务之后，淘汰和 touch 天然互斥。
 */
async function touch(db: IDBDatabase, key: string): Promise<void> {
  try {
    const store = db.transaction(STORE_META, 'readwrite').objectStore(STORE_META)
    const req = store.get(key)
    req.onsuccess = () => {
      const cur = req.result as MetaEntry | null
      // 同一个事务里接着写：没有 await，事务不会在中间提交
      if (cur) store.put({ ...cur, lastUsedAt: Date.now() } satisfies MetaEntry, key)
    }
  } catch {
    /* 缓存计时不准无所谓，别影响开局 */
  }
}

/**
 * 写缓存。
 *
 * 调用方通常不 await（写几百 MB 要花时间，不该让玩家干等）。
 * ⚠️ 因此 data 必须是「调用方之后不会 transfer 走」的 buffer ——
 * 被 transfer 过的 buffer 会变成游离态、byteLength 归零，下面那道 size === 0
 * 的判断就是兜这种情况：宁可不缓存，也不能把 0 字节写进去当成有效 ROM。
 */
export async function romCachePut(key: string, data: ArrayBuffer): Promise<void> {
  if (data.byteLength > MAX_ENTRY_BYTES) {
    skip(key, data.byteLength, `超过单条上限（${Math.round(MAX_ENTRY_BYTES / 1048576)}MB）`)
  }
  return put(key, data, MAX_ENTRY_BYTES)
}

/**
 * 写缓存（光盘镜像）。
 *
 * 和 romCachePut 的区别只有两点：上限高得多，而且存的是 Blob ——
 * 几百 MB 到几 GB 的镜像从下载到入库全程不需要一整块连续内存（见 loadProgress.ts
 * 的 fetchBlobWithProgress）。同样不要 await，写盘慢不该让玩家干等。
 */
export async function romCachePutBlob(key: string, blob: Blob): Promise<void> {
  return put(key, blob, MAX_BLOB_ENTRY_BYTES)
}

async function put(key: string, data: CacheValue, maxEntry: number): Promise<void> {
  if (!key) return
  const size = sizeOf(data)
  if (size === 0 || size > maxEntry) return
  const db = await openDb()
  if (!db) return

  const budget = await budgetBytes()
  // 一个条目最多占掉预算的一半：占满的话，玩第二款游戏必然把第一款挤掉，
  // 两款轮着玩就变成每次都重下 —— 那还不如一开始就不缓存这一张
  /**
   * ⚠️ 这两道闸以前是**完全静默**的，排查时看不出任何痕迹。
   *
   * 表现：一个 260MB 的合并 romset 永远进不了缓存，玩家每次开局都重下 260MB，
   * `romCacheStats()` 里看不到、控制台一个字都没有，查的人只会怀疑 romCache 本身坏了。
   * 第二道更隐蔽：iOS Safari 的 `storage.estimate().quota` 常报 ~1GB → budget 500MB →
   * `budget/2 = 250MB`，同一份 ROM 在桌面 Chrome 上能缓存、在 iPhone 上永远不能，
   * 行为分叉却无从得知。
   */
  if (size > budget / 2) return skip(key, size, `超过预算的一半（${Math.round(budget / 2 / 1048576)}MB）`)
  if (!(await ensureRoom(db, size, budget))) return skip(key, size, '腾不出空间')

  const result = await putEntry(db, key, data)
  if (result !== 'quota') return
  // 配额是**整个源**共享的，存档、EmulatorJS-Cache、HTTP 缓存都在占，
  // estimate() 给的数字不一定跟得上。被拒了就多腾一倍再试一次，还不行就放弃。
  if (await ensureRoom(db, size * 2, budget)) await putEntry(db, key, data)
}

/** 读全部元信息（不碰字节本体） */
async function readMeta(db: IDBDatabase): Promise<Array<{ key: string; meta: MetaEntry }>> {
  try {
    const store = db.transaction(STORE_META, 'readonly').objectStore(STORE_META)
    // 两个请求必须在同一个同步块里发出去，await 之后事务就自动关了
    const keysReq = store.getAllKeys()
    const valuesReq = store.getAll()
    const [keys, values] = await Promise.all([ask(keysReq), ask(valuesReq)])
    if (!keys || !values || keys.length !== values.length) return []
    return keys.map((k, i) => ({ key: String(k), meta: values[i] as MetaEntry }))
      .filter((e) => e.meta && typeof e.meta.size === 'number')
  } catch {
    return []
  }
}

/** 按 LRU 淘汰到「装得下 need 字节」为止。返回是否腾出了空间 */
async function ensureRoom(db: IDBDatabase, need: number, budget: number): Promise<boolean> {
  const entries = await readMeta(db)
  let total = entries.reduce((sum, e) => sum + e.meta.size, 0)
  if (total + need <= budget) return true

  const victims: string[] = []
  // 最久没用的先走
  for (const e of [...entries].sort((a, b) => (a.meta.lastUsedAt || 0) - (b.meta.lastUsedAt || 0))) {
    if (total + need <= budget) break
    victims.push(e.key)
    total -= e.meta.size
  }
  if (victims.length) await removeKeys(db, victims)
  return total + need <= budget
}

function removeKeys(db: IDBDatabase, keys: string[]): Promise<void> {
  return new Promise((resolve) => {
    let tx: IDBTransaction
    try {
      tx = db.transaction([STORE_BLOB, STORE_META], 'readwrite')
    } catch {
      return resolve()
    }
    tx.oncomplete = () => resolve()
    tx.onabort = () => resolve()
    tx.onerror = () => resolve()
    try {
      const blobs = tx.objectStore(STORE_BLOB)
      const meta = tx.objectStore(STORE_META)
      for (const k of keys) {
        blobs.delete(k)
        meta.delete(k)
      }
    } catch {
      resolve()
    }
  })
}

/** 字节和元信息写在同一个事务里，避免出现「有元信息没字节」的半条记录 */
function putEntry(db: IDBDatabase, key: string, data: CacheValue): Promise<'ok' | 'quota' | 'fail'> {
  return new Promise((resolve) => {
    let tx: IDBTransaction
    try {
      tx = db.transaction([STORE_BLOB, STORE_META], 'readwrite')
    } catch {
      return resolve('fail')
    }
    let quota = false
    tx.oncomplete = () => resolve('ok')
    tx.onabort = () => resolve(quota || tx.error?.name === 'QuotaExceededError' ? 'quota' : 'fail')
    tx.onerror = () => {
      /* 交给 onabort 收口 */
    }
    try {
      const now = Date.now()
      const blobReq = tx.objectStore(STORE_BLOB).put(data, key)
      // 超配额时报在这个请求上，事务随后 abort；先记下来给 onabort 用
      blobReq.onerror = () => {
        if (blobReq.error?.name === 'QuotaExceededError') quota = true
      }
      tx.objectStore(STORE_META).put({ size: sizeOf(data), storedAt: now, lastUsedAt: now } satisfies MetaEntry, key)
    } catch {
      resolve('fail')
    }
  })
}

async function budgetBytes(): Promise<number> {
  try {
    const quota = (await navigator.storage?.estimate?.())?.quota
    if (typeof quota === 'number' && quota > 0) return Math.min(quota * BUDGET_RATIO, HARD_MAX_BUDGET)
  } catch {
    /* 老浏览器没有 estimate，走兜底预算 */
  }
  return FALLBACK_BUDGET
}

/** 给设置页 / 排查用：现在缓存了几份、占多少、预算多少 */
export async function romCacheStats(): Promise<{ count: number; bytes: number; budget: number }> {
  const db = await openDb()
  const budget = await budgetBytes()
  if (!db) return { count: 0, bytes: 0, budget }
  const entries = await readMeta(db)
  return { count: entries.length, bytes: entries.reduce((s, e) => s + e.meta.size, 0), budget }
}

/** 清空 ROM 缓存（不碰存档，存档在另一个数据库里） */
/** 删掉一条（发现是坏记录时用）。失败静默：删不掉也不影响接下来走网络 */
export async function romCacheDelete(key: string): Promise<void> {
  const db = await openDb()
  if (!db) return
  await removeKeys(db, [key])
}

export async function romCacheClear(): Promise<void> {
  const db = await openDb()
  if (!db) return
  const entries = await readMeta(db)
  if (entries.length) await removeKeys(db, entries.map((e) => e.key))
}
