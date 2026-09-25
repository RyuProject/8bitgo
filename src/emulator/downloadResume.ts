/**
 * 大 ROM 下载的临时分片仓库。
 *
 * 为什么不复用 romCache：romCache 保存的是已经验证完整、可以直接开局的 ROM；这里保存的是
 * 随时可能只下到一半的临时分片。混在一起不仅会让淘汰统计失真，任何一次键或类型判断失误
 * 还可能把半截 ROM 当成完整缓存复活。单独一个数据库，失败时最多只是失去续传能力。
 *
 * 键必须由调用方提供内容版本（当前使用带 romv/归档版本的 romCacheKey）。没有版本号时不落盘，
 * 否则管理员原地覆盖 ROM 后，浏览器可能把旧分片和新文件拼在一起，而且长度相同也发现不了。
 */

const DB_NAME = '8bitgo-rom-downloads'
const DB_VERSION = 1
const STORE_SESSIONS = 'sessions'
const STORE_PARTS = 'parts'
const PART_KEY = 'downloadKey'

/** 未完成下载只保留七天，避免玩家试过一次的 ROM 永久占着站点配额。 */
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000
/** 同时留四款已足够覆盖来回切游戏；完整 ROM 另有自己的 LRU 缓存。 */
const MAX_SESSIONS = 4

interface SessionRecord {
  key: string
  total: number
  chunkBytes: number
  updatedAt: number
}

interface PartRecord {
  downloadKey: string
  index: number
  blob: Blob
}

export interface DownloadResumeSnapshot {
  total: number
  chunkBytes: number
  parts: ReadonlyMap<number, Blob>
}

/** 注入接口也供下载器回归测试使用，测试不必伪造一套浏览器 IndexedDB。 */
export interface DownloadResumeStore {
  load(key: string, chunkBytes: number): Promise<DownloadResumeSnapshot | null>
  /** false 表示本环境不能持久化；下载器收到后会停止本局后续写盘，但继续网络下载。 */
  put(key: string, total: number, chunkBytes: number, index: number, blob: Blob): Promise<boolean | void>
  clear(key: string): Promise<void>
}

let dbPromise: Promise<IDBDatabase | null> | null = null

function openDb(): Promise<IDBDatabase | null> {
  if (dbPromise) return dbPromise
  dbPromise = new Promise((resolve) => {
    // SSR、无痕模式、禁用站点存储都只意味着不能续传，不应该挡住正常联网下载。
    if (typeof indexedDB === 'undefined') return resolve(null)
    let request: IDBOpenDBRequest
    try {
      request = indexedDB.open(DB_NAME, DB_VERSION)
    } catch {
      return resolve(null)
    }
    request.onupgradeneeded = () => {
      const db = request.result
      if (!db.objectStoreNames.contains(STORE_SESSIONS)) db.createObjectStore(STORE_SESSIONS, { keyPath: 'key' })
      if (!db.objectStoreNames.contains(STORE_PARTS)) {
        const parts = db.createObjectStore(STORE_PARTS, { keyPath: ['downloadKey', 'index'] })
        parts.createIndex(PART_KEY, PART_KEY)
      }
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => resolve(null)
    // 这里是纯加速缓存；旧标签页挡住升级时直接不用，比让开局永远等 onblocked 安全。
    request.onblocked = () => resolve(null)
  })
  return dbPromise
}

function requestResult<T>(request: IDBRequest<T>): Promise<T | null> {
  return new Promise((resolve) => {
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => resolve(null)
  })
}

function transactionDone(transaction: IDBTransaction): Promise<boolean> {
  return new Promise((resolve) => {
    transaction.oncomplete = () => resolve(true)
    transaction.onabort = () => resolve(false)
    transaction.onerror = () => resolve(false)
  })
}

async function clearStored(db: IDBDatabase, key: string): Promise<void> {
  try {
    // 元信息和分片放进同一个事务：若只删掉 session 就崩溃，孤儿分片之后再也没有键可供清理。
    const transaction = db.transaction([STORE_SESSIONS, STORE_PARTS], 'readwrite')
    transaction.objectStore(STORE_SESSIONS).delete(key)
    const parts = transaction.objectStore(STORE_PARTS)
    const request = parts.index(PART_KEY).openKeyCursor(IDBKeyRange.only(key))
    request.onsuccess = () => {
      const cursor = request.result
      if (!cursor) return
      parts.delete(cursor.primaryKey)
      cursor.continue()
    }
    await transactionDone(transaction)
  } catch {
    /* 临时缓存删不掉不影响开局，后面的过期清理还会再尝试。 */
  }
}

/**
 * 淘汰按会话做，绝不能逐片做：只删一款游戏的部分片会制造看似可续、实际必重下的碎片。
 * 当前正在写的 key 始终保留，哪怕设备时钟突然跳了七天也不会误删本次下载。
 */
async function cleanup(db: IDBDatabase, keepKey: string): Promise<void> {
  let sessions: SessionRecord[] | null = null
  try {
    sessions = await requestResult(db.transaction(STORE_SESSIONS, 'readonly').objectStore(STORE_SESSIONS).getAll())
  } catch {
    return
  }
  if (!sessions) return
  const now = Date.now()
  const ordered = sessions.slice().sort((a, b) => b.updatedAt - a.updatedAt)
  const remove = ordered.filter((session, index) =>
    session.key !== keepKey && (now - session.updatedAt > MAX_AGE_MS || index >= MAX_SESSIONS),
  )
  for (const session of remove) await clearStored(db, session.key)
}

export const downloadResumeStore: DownloadResumeStore = {
  async load(key, chunkBytes) {
    if (!key) return null
    const db = await openDb()
    if (!db) return null

    let session: SessionRecord | null = null
    try {
      session = await requestResult(
        db.transaction(STORE_SESSIONS, 'readonly').objectStore(STORE_SESSIONS).get(key),
      )
    } catch {
      return null
    }
    if (!session) return null
    if (
      session.chunkBytes !== chunkBytes
      || !Number.isSafeInteger(session.total)
      || session.total <= 0
      || Date.now() - session.updatedAt > MAX_AGE_MS
    ) {
      await clearStored(db, key)
      return null
    }

    let records: PartRecord[] | null = null
    try {
      records = await requestResult(
        db.transaction(STORE_PARTS, 'readonly').objectStore(STORE_PARTS).index(PART_KEY).getAll(key),
      )
    } catch {
      return null
    }
    if (!records?.length) {
      await clearStored(db, key)
      return null
    }

    const count = Math.ceil(session.total / chunkBytes)
    const parts = new Map<number, Blob>()
    for (const record of records) {
      const expected = Math.min(chunkBytes, session.total - record.index * chunkBytes)
      if (
        !Number.isInteger(record.index)
        || record.index < 0
        || record.index >= count
        || !(record.blob instanceof Blob)
        || record.blob.size !== expected
        || parts.has(record.index)
      ) {
        // 一片不可信就整组丢弃。用剩下的片继续拼，风险是产出一份长度正确但内容错位的 ROM。
        await clearStored(db, key)
        return null
      }
      parts.set(record.index, record.blob)
    }
    void cleanup(db, key)
    return { total: session.total, chunkBytes, parts }
  },

  async put(key, total, chunkBytes, index, blob) {
    if (
      !key
      || !Number.isSafeInteger(total)
      || total <= 0
      || !Number.isSafeInteger(chunkBytes)
      || chunkBytes <= 0
      || !Number.isInteger(index)
      || index < 0
      || blob.size !== Math.min(chunkBytes, total - index * chunkBytes)
    ) return false
    const db = await openDb()
    if (!db) return false

    try {
      const previous = await requestResult(
        db.transaction(STORE_SESSIONS, 'readonly').objectStore(STORE_SESSIONS).get(key),
      ) as SessionRecord | null
      if (previous && (previous.total !== total || previous.chunkBytes !== chunkBytes)) await clearStored(db, key)

      const transaction = db.transaction([STORE_SESSIONS, STORE_PARTS], 'readwrite')
      transaction.objectStore(STORE_SESSIONS).put({ key, total, chunkBytes, updatedAt: Date.now() } satisfies SessionRecord)
      transaction.objectStore(STORE_PARTS).put({ downloadKey: key, index, blob } satisfies PartRecord)
      if (!(await transactionDone(transaction))) return false
      void cleanup(db, key)
      return true
    } catch {
      // QuotaExceededError 最常见。续传是优化，配额满仍要让这一局在内存里正常下完。
      return false
    }
  },

  async clear(key) {
    if (!key) return
    const db = await openDb()
    if (!db) return
    await clearStored(db, key)
  },
}
