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
/**
 * MAME 的 CHD 比普通 ROM 大得多：能用 OPFS 时，分片直接落浏览器私有文件系统，
 * 避免 IndexedDB 在写入数百 MB Blob 时额外做一次结构化克隆。Safari / 无痕模式尚未
 * 提供 OPFS 时必须无感回退到下方既有的 IndexedDB 仓库，不能因为一项加速让游戏不能开局。
 */
const MAME_OPFS_DIR = '8bitgo-mame-chd-parts'

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

/** 这里只声明实际用到的 OPFS 形状，避免旧版 TypeScript DOM lib 缺少实验性类型时构建失败。 */
interface OpfsFileHandle {
  getFile(): Promise<File>
  createWritable(options?: { keepExistingData?: boolean }): Promise<{
    write(value: Blob | string): Promise<void>
    close(): Promise<void>
    abort?(): Promise<void>
  }>
}

interface OpfsDirectoryHandle {
  kind?: string
  getDirectoryHandle(name: string, options?: { create?: boolean }): Promise<OpfsDirectoryHandle>
  getFileHandle(name: string, options?: { create?: boolean }): Promise<OpfsFileHandle>
  removeEntry(name: string, options?: { recursive?: boolean }): Promise<void>
  entries?(): AsyncIterableIterator<[string, { kind?: string } & OpfsDirectoryHandle & Partial<OpfsFileHandle>]>
}

interface OpfsStorageLike {
  getDirectory?: () => Promise<OpfsDirectoryHandle>
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
let mameOpfsRootPromise: Promise<OpfsDirectoryHandle | null> | null = null

function mameOpfsSessionName(key: string): string {
  // MAME CHD 的调用方使用内容寻址键（mame-chd:<sha1>:<sha1>:<size>）。仍保留一个短 hash
  // 并把完整 key 写进 meta：文件名碰撞时会被 meta 的 key 检查挡住，不能拼到另一张盘。
  let hash = 2166136261
  for (let index = 0; index < key.length; index += 1) {
    hash ^= key.charCodeAt(index)
    hash = Math.imul(hash, 16777619)
  }
  return `m-${(hash >>> 0).toString(36)}-${key.replace(/[^a-z0-9_-]/gi, '_').slice(0, 120)}`
}

async function mameOpfsRoot(): Promise<OpfsDirectoryHandle | null> {
  if (mameOpfsRootPromise) return mameOpfsRootPromise
  mameOpfsRootPromise = (async () => {
    try {
      const storage = typeof navigator === 'undefined'
        ? undefined
        : (navigator.storage as unknown as OpfsStorageLike | undefined)
      if (!storage?.getDirectory) return null
      const root = await storage.getDirectory()
      return await root.getDirectoryHandle(MAME_OPFS_DIR, { create: true })
    } catch {
      return null
    }
  })()
  return mameOpfsRootPromise
}

async function opfsSessionDirectory(key: string, create: boolean): Promise<OpfsDirectoryHandle | null> {
  const root = await mameOpfsRoot()
  if (!root) return null
  try {
    return await root.getDirectoryHandle(mameOpfsSessionName(key), { create })
  } catch {
    return null
  }
}

async function opfsReadSession(dir: OpfsDirectoryHandle): Promise<SessionRecord | null> {
  try {
    const handle = await dir.getFileHandle('meta.json')
    const value = JSON.parse(await (await handle.getFile()).text()) as SessionRecord
    if (!value || typeof value.key !== 'string' || !Number.isSafeInteger(value.total) ||
        !Number.isSafeInteger(value.chunkBytes) || !Number.isFinite(value.updatedAt)) return null
    return value
  } catch {
    return null
  }
}

async function opfsWrite(dir: OpfsDirectoryHandle, name: string, value: Blob | string): Promise<void> {
  const handle = await dir.getFileHandle(name, { create: true })
  const writer = await handle.createWritable({ keepExistingData: false })
  try {
    await writer.write(value)
    await writer.close()
  } catch (error) {
    await writer.abort?.().catch(() => {})
    throw error
  }
}

async function clearMameOpfsSession(key: string): Promise<void> {
  const root = await mameOpfsRoot()
  if (!root) return
  try {
    await root.removeEntry(mameOpfsSessionName(key), { recursive: true })
  } catch {
    /* 不可恢复的本地缓存清理失败只会多占一会空间，不能阻止联网下载。 */
  }
}

async function cleanupMameOpfs(keepKey: string): Promise<void> {
  const root = await mameOpfsRoot()
  if (!root?.entries) return
  const sessions: Array<{ name: string; record: SessionRecord }> = []
  try {
    for await (const [name, entry] of root.entries()) {
      if (entry.kind && entry.kind !== 'directory') continue
      const record = await opfsReadSession(entry)
      if (record) sessions.push({ name, record })
      else await root.removeEntry(name, { recursive: true }).catch(() => {})
    }
  } catch {
    return
  }
  const now = Date.now()
  for (const [index, session] of sessions.sort((a, b) => b.record.updatedAt - a.record.updatedAt).entries()) {
    if (session.record.key === keepKey) continue
    if (now - session.record.updatedAt > MAX_AGE_MS || index >= MAX_SESSIONS) {
      await root.removeEntry(session.name, { recursive: true }).catch(() => {})
    }
  }
}

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

/**
 * OPFS 版的 MAME CHD 临时分片仓库。
 *
 * 这里故意只给 CHD 用：NDS / 普通 ROM 的分片远小，另建一套目录反而会让两个缓存策略
 * 互相抢配额。CHD 完整挂进 MAME 后仍会由调用方清理这些临时片，完整可复用副本继续交给
 * romCache 管理；不要把“未校验的中断现场”当成长久 ROM 缓存。
 */
const mameOpfsResumeStore: DownloadResumeStore = {
  async load(key, chunkBytes) {
    if (!key) return null
    const dir = await opfsSessionDirectory(key, false)
    if (!dir) return null
    const session = await opfsReadSession(dir)
    if (
      !session || session.key !== key || session.chunkBytes !== chunkBytes ||
      session.total <= 0 || Date.now() - session.updatedAt > MAX_AGE_MS
    ) {
      await clearMameOpfsSession(key)
      return null
    }
    if (!dir.entries) return null
    const count = Math.ceil(session.total / chunkBytes)
    const parts = new Map<number, Blob>()
    try {
      for await (const [name, entry] of dir.entries()) {
        if (name === 'meta.json') continue
        const match = /^part-(\d+)\.bin$/.exec(name)
        if (!match || entry.kind && entry.kind !== 'file' || typeof entry.getFile !== 'function') {
          await clearMameOpfsSession(key)
          return null
        }
        const index = Number(match[1])
        const expected = Math.min(chunkBytes, session.total - index * chunkBytes)
        const blob = await entry.getFile()
        if (!Number.isInteger(index) || index < 0 || index >= count || blob.size !== expected || parts.has(index)) {
          await clearMameOpfsSession(key)
          return null
        }
        parts.set(index, blob)
      }
    } catch {
      return null
    }
    if (!parts.size) {
      await clearMameOpfsSession(key)
      return null
    }
    void cleanupMameOpfs(key)
    return { total: session.total, chunkBytes, parts }
  },

  async put(key, total, chunkBytes, index, blob) {
    if (
      !key || !Number.isSafeInteger(total) || total <= 0 ||
      !Number.isSafeInteger(chunkBytes) || chunkBytes <= 0 ||
      !Number.isInteger(index) || index < 0 ||
      blob.size !== Math.min(chunkBytes, total - index * chunkBytes)
    ) return false
    const dir = await opfsSessionDirectory(key, true)
    if (!dir) return false
    try {
      const previous = await opfsReadSession(dir)
      if (previous && (previous.key !== key || previous.total !== total || previous.chunkBytes !== chunkBytes)) {
        await clearMameOpfsSession(key)
        const fresh = await opfsSessionDirectory(key, true)
        if (!fresh) return false
        await opfsWrite(fresh, `part-${index}.bin`, blob)
        await opfsWrite(fresh, 'meta.json', JSON.stringify({ key, total, chunkBytes, updatedAt: Date.now() } satisfies SessionRecord))
      } else {
        // 先落数据、后落 meta：标签页恰好被系统杀掉时最多留下没有 session 的孤儿文件；
        // 反过来会让 meta 宣称某片存在、续传读到空文件而制造更难诊断的“半张盘”。
        await opfsWrite(dir, `part-${index}.bin`, blob)
        await opfsWrite(dir, 'meta.json', JSON.stringify({ key, total, chunkBytes, updatedAt: Date.now() } satisfies SessionRecord))
      }
      void cleanupMameOpfs(key)
      return true
    } catch {
      // 配额、OPFS 被策略禁用、或浏览器在后台回收句柄都只意味着回退，不应拦住本局下载。
      return false
    }
  },

  async clear(key) {
    if (key) await clearMameOpfsSession(key)
  },
}

/**
 * MAME CHD 优先 OPFS、不可用时回退 IndexedDB。
 *
 * 选择必须按 key 固定：若本次从旧版 IndexedDB 接续，后续新片也继续写同一处；否则把一半
 * 片写 IDB、一半写 OPFS，下次刷新任一仓库都拿不到完整断点现场。新会话则优先 OPFS。
 */
const mameStoreTargets = new Map<string, 'opfs' | 'idb'>()

export const mameChdResumeStore: DownloadResumeStore = {
  async load(key, chunkBytes) {
    const opfs = await mameOpfsResumeStore.load(key, chunkBytes)
    if (opfs) {
      mameStoreTargets.set(key, 'opfs')
      return opfs
    }
    const idb = await downloadResumeStore.load(key, chunkBytes)
    if (idb) mameStoreTargets.set(key, 'idb')
    return idb
  },

  async put(key, total, chunkBytes, index, blob) {
    const target = mameStoreTargets.get(key)
    if (target === 'idb') return downloadResumeStore.put(key, total, chunkBytes, index, blob)
    const opfs = await mameOpfsResumeStore.put(key, total, chunkBytes, index, blob)
    if (opfs !== false) {
      mameStoreTargets.set(key, 'opfs')
      return opfs
    }
    const idb = await downloadResumeStore.put(key, total, chunkBytes, index, blob)
    if (idb !== false) mameStoreTargets.set(key, 'idb')
    return idb
  },

  async clear(key) {
    mameStoreTargets.delete(key)
    await Promise.all([
      mameOpfsResumeStore.clear(key),
      downloadResumeStore.clear(key),
    ])
  },
}
