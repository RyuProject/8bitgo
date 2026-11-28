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
 * etag 变、URL 变，自然不会命中旧的那份。外站 ZIP 的版本在 fragment 里，
 * 源站暴露 ETag 时用 romv；没有时只接受管理员明确填写的 v。**没有版本号一律不缓存** ——
 * 那种情况下没法判断远端内容换没换，而「半截 / 过期 ROM 复活」是这个项目栽过的坑
 * （见 AGENTS.md §2.6），宁可不缓存。
 *
 * 所有失败都是静默的：无痕模式、配额满、用户禁用站点数据 —— 缓存只是加速，
 * 任何一步出错都必须退回「正常从网络下载」，不能让玩家玩不了游戏。
 *
 * ⚠️ 两套读写接口，按 ROM 大小分：
 *   - romCacheGet / romCachePut：ArrayBuffer，只给必须直接嗅探字节的小卡带 ROM。
 *   - romCacheGetBlob / romCachePutBlob：Blob，给光盘和街机 ZIP。街机只切片读取中央目录，
 *     不该为了验一个大包再申请一整块连续内存。
 */

export { romCacheKey } from './romCacheKey'
import type { RomIntegrityManifest } from '@/services/romIntegrityData'

const DB_NAME = '8bitgo-roms'
const DB_VERSION = 1
/** 字节本体 */
const STORE_BLOB = 'blobs'
/** 只放小型索引 / 校验元信息。LRU 淘汰要遍历全部条目，不能把几 GB 字节也拖出来 */
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
  /** 记录每次 Blob 写入的身份，防止迟到的复验结果贴到同键同尺寸的新 ROM。 */
  recordId?: string
  /** 仅可信清单校验成功后写入；新版本清单不匹配时必须重验 ROM 本体。 */
  integrityTag?: string
  integrityCheckedAt?: number
  /** 下载响应当时是否明确要求校验；旧缓存缺省表示未知，读取时继续保守等待清单。 */
  integrityRequired?: boolean
  /** 仅下载器已按该清单验完全部字节后保存；热缓存可用它本地复验而不等网络清单。 */
  integrityManifest?: RomIntegrityManifest
}

export interface RomCacheBlobRecord {
  blob: Blob
  recordId?: string
  storedAt?: number
  integrityTag?: string
  integrityCheckedAt?: number
  integrityRequired?: boolean
  integrityManifest?: RomIntegrityManifest
}

export interface RomCacheArrayBufferRecord {
  data: ArrayBuffer
  recordId?: string
  storedAt?: number
  integrityRequired?: boolean
  integrityManifest?: RomIntegrityManifest
}

export interface RomCacheBoundedRecord {
  value: ArrayBuffer | Blob
  recordId?: string
  storedAt?: number
  integrityRequired?: boolean
  integrityManifest?: RomIntegrityManifest
}

let cacheRecordSequence = 0

/** 只作同页 / 跨标签缓存写入代次比较，不承载安全凭据。 */
function nextCacheRecordId(): string {
  return `${Date.now().toString(36)}-${(++cacheRecordSequence).toString(36)}-${Math.random().toString(36).slice(2)}`
}

/** 本地 Blob 每周至少完整重验一次；同一周内重复开局可免去数百 MB 的磁盘读取与 SHA-256。 */
export const ROM_CACHE_INTEGRITY_RECHECK_MS = 7 * 24 * 60 * 60 * 1000

/** 缓存键、完整清单与近期校验时间都一致时，才可跳过本次整盘哈希。 */
export function romCacheIntegrityIsFresh(
  record: Pick<RomCacheBlobRecord, 'integrityTag' | 'integrityCheckedAt'> | null,
  integrityTag: string,
  now = Date.now(),
): boolean {
  const checkedAt = record?.integrityCheckedAt
  return Boolean(record && integrityTag && record.integrityTag === integrityTag &&
    Number.isSafeInteger(checkedAt) && checkedAt! > 0 && now >= checkedAt! &&
    now - checkedAt! <= ROM_CACHE_INTEGRITY_RECHECK_MS)
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
  const opening = new Promise<IDBDatabase | null>((resolve) => {
    // 无痕模式、禁用站点数据、SSR —— 一律当作「没有本地存储」，不要抛错
    if (typeof indexedDB === 'undefined') return resolve(null)
    let req: IDBOpenDBRequest
    try {
      req = indexedDB.open(DB_NAME, DB_VERSION)
    } catch {
      return resolve(null)
    }
    let settled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const finish = (db: IDBDatabase | null) => {
      if (settled) {
        // blocked / timeout 后 open 请求仍可能迟到成功；不能把没人使用的连接留着阻塞其它标签页升级。
        try { db?.close() } catch { /* 已关闭 */ }
        return
      }
      settled = true
      if (timer !== undefined) clearTimeout(timer)
      if (db) {
        db.onversionchange = () => {
          try { db.close() } catch { /* 已关闭 */ }
          if (dbPromise === opening) dbPromise = null
        }
      }
      resolve(db)
    }
    req.onupgradeneeded = () => {
      const db = req.result
      if (!db.objectStoreNames.contains(STORE_BLOB)) db.createObjectStore(STORE_BLOB)
      if (!db.objectStoreNames.contains(STORE_META)) db.createObjectStore(STORE_META)
    }
    /*
      库坏掉的浏览器上 open 可能既不 success 也不 error（引擎缓存同一个库挂死过的现象，见 AGENTS §2.8.0.1）。
      读缓存挡在每次 ROM 下载前面，等不到就本页当作没有缓存。迟到的连接直接关掉，不留着占锁。
    */
    timer = setTimeout(() => finish(null), OPEN_TIMEOUT_MS)
    req.onsuccess = () => finish(req.result)
    req.onerror = () => finish(null)
    // 别的标签页占着旧版本时会一直卡在 blocked，给个出口别让调用方永远等
    req.onblocked = () => finish(null)
  })
  dbPromise = opening
  // 临时阻塞、打开超时或浏览器禁用存储不应永久关闭本页的缓存恢复机会。
  void opening.then((db) => {
    if (!db && dbPromise === opening) dbPromise = null
  })
  return opening
}

const OPEN_TIMEOUT_MS = 5_000
/** 开局前的读缓存上限：读的只是 Blob 引用或小 ROM，正常几十毫秒；超过就当未命中，直接走网络 */
const READ_TIMEOUT_MS = 8_000

/** 带上限的读请求，超时解析成 null。定时器必须清掉，否则快的读也会在稍后被误判 */
function askWithin<T>(req: IDBRequest<T>, ms: number): Promise<T | null> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), ms)
    req.onsuccess = () => { clearTimeout(timer); resolve(req.result) }
    req.onerror = () => { clearTimeout(timer); resolve(null) }
  })
}

/** 把一个 IDBRequest 包成 Promise；失败一律解析成 null，不抛 */
function ask<T>(req: IDBRequest<T>): Promise<T | null> {
  return new Promise((resolve) => {
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => resolve(null)
  })
}

/** 读缓存。命中返回字节，未命中返回 null */
export async function romCacheGet(key: string): Promise<ArrayBuffer | null> {
  if (!key) return null
  const db = await openDb()
  if (!db) return null
  let value: unknown
  try {
    value = await askWithin(db.transaction(STORE_BLOB, 'readonly').objectStore(STORE_BLOB).get(key), READ_TIMEOUT_MS)
  } catch {
    return null
  }
  if (!(value instanceof ArrayBuffer) || value.byteLength === 0) return null
  // 命中时间是异步更新的，不阻塞开局
  void touch(db, key)
  return value
}

/** 读取小 ROM 与下载响应的校验要求；缺少新元信息的旧缓存由调用方按未知状态处理。 */
export async function romCacheGetRecord(key: string): Promise<RomCacheArrayBufferRecord | null> {
  if (!key) return null
  const db = await openDb()
  if (!db) return null
  let value: unknown
  let meta: MetaEntry | null = null
  try {
    const tx = db.transaction([STORE_BLOB, STORE_META], 'readonly')
    const blobReq = tx.objectStore(STORE_BLOB).get(key)
    const metaReq = tx.objectStore(STORE_META).get(key)
    ;[value, meta] = await Promise.all([
      askWithin(blobReq, READ_TIMEOUT_MS),
      askWithin(metaReq, READ_TIMEOUT_MS),
    ]) as [unknown, MetaEntry | null]
  } catch {
    return null
  }
  if (!(value instanceof ArrayBuffer) || value.byteLength === 0) return null
  void touch(db, key)
  return {
    data: value,
    ...(typeof meta?.recordId === 'string' ? { recordId: meta.recordId } : {}),
    ...(typeof meta?.storedAt === 'number' && Number.isSafeInteger(meta.storedAt) ? { storedAt: meta.storedAt } : {}),
    ...(typeof meta?.integrityRequired === 'boolean' ? { integrityRequired: meta.integrityRequired } : {}),
    ...(meta?.integrityManifest && typeof meta.integrityManifest === 'object'
      ? { integrityManifest: meta.integrityManifest } : {}),
  }
}

/** 有大小上限的运行时先读索引，再按原存储类型取缓存，避免超限复制及 ArrayBuffer→Blob→ArrayBuffer 往返。 */
export async function romCacheGetBoundedRecord(
  key: string,
  maxBytes: number,
): Promise<RomCacheBoundedRecord | null> {
  if (!key || !Number.isSafeInteger(maxBytes) || maxBytes <= 0) return null
  const db = await openDb()
  if (!db) return null
  return new Promise((resolve) => {
    let settled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const finish = (record: RomCacheBoundedRecord | null) => {
      if (settled) return
      settled = true
      if (timer !== undefined) clearTimeout(timer)
      resolve(record)
    }
    timer = setTimeout(() => finish(null), READ_TIMEOUT_MS)
    try {
      const tx = db.transaction([STORE_BLOB, STORE_META], 'readonly')
      const metaStore = tx.objectStore(STORE_META)
      const metaReq = metaStore.get(key)
      metaReq.onsuccess = () => {
        const meta = metaReq.result as MetaEntry | undefined
        if (!meta || !Number.isSafeInteger(meta.size) || meta.size <= 0 || meta.size > maxBytes) {
          finish(null)
          return
        }
        // 在元数据请求事件仍激活的事务里取值；不能先 await 再开新事务，否则 IDB 会在回调后自动关闭。
        const valueReq = tx.objectStore(STORE_BLOB).get(key)
        valueReq.onsuccess = () => {
          const value = valueReq.result
          const valueSize = value instanceof Blob ? value.size : value instanceof ArrayBuffer ? value.byteLength : 0
          if (valueSize <= 0 || valueSize > maxBytes || valueSize !== meta.size) {
            finish(null)
            return
          }
          void touch(db, key)
          finish({
            value,
            ...(typeof meta.recordId === 'string' ? { recordId: meta.recordId } : {}),
            ...(typeof meta.storedAt === 'number' && Number.isSafeInteger(meta.storedAt) ? { storedAt: meta.storedAt } : {}),
            ...(typeof meta.integrityRequired === 'boolean' ? { integrityRequired: meta.integrityRequired } : {}),
            ...(meta.integrityManifest && typeof meta.integrityManifest === 'object'
              ? { integrityManifest: meta.integrityManifest } : {}),
          })
        }
        valueReq.onerror = () => finish(null)
      }
      metaReq.onerror = () => finish(null)
      tx.onabort = () => finish(null)
      tx.onerror = () => finish(null)
    } catch {
      finish(null)
    }
  })
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
    value = await askWithin(db.transaction(STORE_BLOB, 'readonly').objectStore(STORE_BLOB).get(key), READ_TIMEOUT_MS)
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

/** 读取光盘 Blob 与其校验印记；缺少旧元信息时仍返回 Blob，由调用方走一次完整校验。 */
export async function romCacheGetBlobRecord(key: string, type = 'application/octet-stream'): Promise<RomCacheBlobRecord | null> {
  if (!key) return null
  const db = await openDb()
  if (!db) return null
  let value: unknown
  let rawMeta: MetaEntry | null = null
  try {
    const tx = db.transaction([STORE_BLOB, STORE_META], 'readonly')
    const blobReq = tx.objectStore(STORE_BLOB).get(key)
    const metaReq = tx.objectStore(STORE_META).get(key)
    ;[value, rawMeta] = await Promise.all([
      askWithin(blobReq, READ_TIMEOUT_MS),
      askWithin(metaReq, READ_TIMEOUT_MS),
    ]) as [unknown, MetaEntry | null]
  } catch {
    return null
  }
  let blob: Blob | null = null
  if (value instanceof Blob && value.size > 0) blob = value.type === type ? value : new Blob([value], { type })
  else if (value instanceof ArrayBuffer && value.byteLength > 0) blob = new Blob([value], { type })
  if (!blob) return null
  void touch(db, key)
  const integrityCheckedAt = rawMeta?.integrityCheckedAt
  return {
    blob,
    ...(typeof rawMeta?.recordId === 'string' ? { recordId: rawMeta.recordId } : {}),
    ...(typeof rawMeta?.storedAt === 'number' && Number.isSafeInteger(rawMeta.storedAt) ? { storedAt: rawMeta.storedAt } : {}),
    ...(typeof rawMeta?.integrityTag === 'string' ? { integrityTag: rawMeta.integrityTag } : {}),
    ...(typeof integrityCheckedAt === 'number' && Number.isSafeInteger(integrityCheckedAt) ? { integrityCheckedAt } : {}),
    ...(typeof rawMeta?.integrityRequired === 'boolean' ? { integrityRequired: rawMeta.integrityRequired } : {}),
    ...(rawMeta?.integrityManifest && typeof rawMeta.integrityManifest === 'object'
      ? { integrityManifest: rawMeta.integrityManifest } : {}),
  }
}

/** 已经完整复验过的缓存只读写小型元信息，不重新读取大 Blob。 */
export async function romCacheMarkIntegrityVerified(
  key: string,
  integrityTag: string,
  expectedSize: number,
  identity: Pick<RomCacheBlobRecord, 'recordId' | 'storedAt'>,
  verifiedIntegrityManifest?: RomIntegrityManifest,
): Promise<void> {
  if (!key || !/^sha256:[a-f0-9]{64}$/i.test(integrityTag) || !Number.isSafeInteger(expectedSize) || expectedSize <= 0 ||
      (!identity.recordId && (!Number.isSafeInteger(identity.storedAt) || (identity.storedAt ?? 0) <= 0)) ||
      (verifiedIntegrityManifest && (verifiedIntegrityManifest.size !== expectedSize ||
        !Array.isArray(verifiedIntegrityManifest.blocks) ||
        verifiedIntegrityManifest.blocks.some((hash) => typeof hash !== 'string' || !/^[a-f0-9]{64}$/.test(hash))))) return
  return updateIntegrityMeta(key, expectedSize, identity, {
    ensureRecordId: true,
    integrityTag,
    integrityCheckedAt: Date.now(),
    ...(verifiedIntegrityManifest ? { integrityManifest: verifiedIntegrityManifest } : {}),
  })
}

/** 将已经按服务端清单复验过的缓存绑定到完整清单，后续可在本地验证，不等网络旁路。 */
export async function romCacheMarkIntegrityManifestVerified(
  key: string,
  manifest: RomIntegrityManifest,
  expectedSize: number,
  identity: Pick<RomCacheBlobRecord, 'recordId' | 'storedAt'>,
): Promise<void> {
  if (!key || !manifest || manifest.size !== expectedSize || !Number.isSafeInteger(expectedSize) || expectedSize <= 0 ||
      typeof manifest.key !== 'string' || typeof manifest.etag !== 'string' || !Array.isArray(manifest.blocks) ||
      manifest.blocks.some((hash) => typeof hash !== 'string' || !/^[a-f0-9]{64}$/.test(hash)) ||
      (!identity.recordId && (!Number.isSafeInteger(identity.storedAt) || (identity.storedAt ?? 0) <= 0))) return
  return updateIntegrityMeta(key, expectedSize, identity, { ensureRecordId: true, integrityManifest: manifest })
}

async function updateIntegrityMeta(
  key: string,
  expectedSize: number,
  identity: Pick<RomCacheBlobRecord, 'recordId' | 'storedAt'>,
  patch: Partial<Omit<MetaEntry, 'recordId'>> & { ensureRecordId?: boolean },
): Promise<void> {
  const db = await openDb()
  if (!db) return
  await new Promise<void>((resolve) => {
    let tx: IDBTransaction
    let ended = false
    const finish = () => {
      if (ended) return
      ended = true
      clearTimeout(timer)
      resolve()
    }
    const timer = setTimeout(finish, READ_TIMEOUT_MS)
    try {
      tx = db.transaction(STORE_META, 'readwrite')
      const metaStore = tx.objectStore(STORE_META)
      const metaReq = metaStore.get(key)
      metaReq.onsuccess = () => {
        const metaValue = metaReq.result as MetaEntry | undefined
        // 同键、同尺寸的重新下载也可能是另一份 Blob；迟到的复验只更新读取时见到的那一代。
        const sameRecord = identity.recordId
          ? metaValue?.recordId === identity.recordId
          : !metaValue?.recordId && metaValue?.storedAt === identity.storedAt
        if (!metaValue || metaValue.size !== expectedSize || !sameRecord) return
        try {
          const { ensureRecordId, ...fields } = patch
          metaStore.put({
            ...metaValue,
            ...fields,
            ...(ensureRecordId ? { recordId: metaValue.recordId || nextCacheRecordId() } : {}),
          } satisfies MetaEntry, key)
        } catch { finish() }
      }
      tx.oncomplete = finish
      tx.onabort = finish
      tx.onerror = finish
    } catch {
      finish()
    }
  })
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
export async function romCachePut(
  key: string,
  data: ArrayBuffer,
  integrityRequired?: boolean,
  verifiedIntegrityManifest?: RomIntegrityManifest | null,
): Promise<void> {
  if (data.byteLength > MAX_ENTRY_BYTES) {
    skip(key, data.byteLength, `超过单条上限（${Math.round(MAX_ENTRY_BYTES / 1048576)}MB）`)
  }
  return put(key, data, MAX_ENTRY_BYTES, undefined, integrityRequired, verifiedIntegrityManifest)
}

/**
 * 写缓存（光盘镜像）。
 *
 * 和 romCachePut 的区别只有两点：上限高得多，而且存的是 Blob ——
 * 几百 MB 到几 GB 的镜像从下载到入库全程不需要一整块连续内存（见 loadProgress.ts
 * 的 fetchBlobWithProgress）。同样不要 await，写盘慢不该让玩家干等。
 */
export async function romCachePutBlob(
  key: string,
  blob: Blob,
  verifiedIntegrityTag?: string,
  verifiedIntegrityManifest?: RomIntegrityManifest,
): Promise<void> {
  return put(key, blob, MAX_BLOB_ENTRY_BYTES, verifiedIntegrityTag, undefined, verifiedIntegrityManifest)
}

async function put(
  key: string,
  data: CacheValue,
  maxEntry: number,
  verifiedIntegrityTag?: string,
  integrityRequired?: boolean,
  verifiedIntegrityManifest?: RomIntegrityManifest | null,
): Promise<void> {
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
  if (!(await ensureRoom(db, size, budget, key))) return skip(key, size, '腾不出空间')

  const result = await putEntry(db, key, data, verifiedIntegrityTag, integrityRequired, verifiedIntegrityManifest)
  if (result !== 'quota') return
  // 配额是**整个源**共享的，存档、EmulatorJS-Cache、HTTP 缓存都在占，
  // estimate() 给的数字不一定跟得上。被拒了就多腾一倍再试一次，还不行就放弃。
  if (await ensureRoom(db, size * 2, budget, key)) {
    await putEntry(db, key, data, verifiedIntegrityTag, integrityRequired, verifiedIntegrityManifest)
  }
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
async function ensureRoom(db: IDBDatabase, need: number, budget: number, replacingKey = ''): Promise<boolean> {
  const entries = await readMeta(db)
  /*
    同一个内容键可能被两个标签页同时下载并先后写入。后一个写是“替换”，不是再占一份空间；
    若仍把旧条目的 size 算进 total，预算刚好时会无端淘汰另一款游戏，随后 put 又只是覆盖原键。
    玩家看到的结果是两款街机轮流玩时缓存反复消失，明明容量足够却每次重下。
  */
  let total = entries.reduce((sum, e) => sum + (e.key === replacingKey ? 0 : e.meta.size), 0)
  if (total + need <= budget) return true

  const victims: string[] = []
  // 最久没用的先走
  for (const e of [...entries].sort((a, b) => (a.meta.lastUsedAt || 0) - (b.meta.lastUsedAt || 0))) {
    if (e.key === replacingKey) continue
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
function putEntry(
  db: IDBDatabase,
  key: string,
  data: CacheValue,
  verifiedIntegrityTag?: string,
  integrityRequired?: boolean,
  verifiedIntegrityManifest?: RomIntegrityManifest | null,
): Promise<'ok' | 'quota' | 'fail'> {
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
      const meta: MetaEntry = {
        size: sizeOf(data),
        storedAt: now,
        lastUsedAt: now,
        recordId: nextCacheRecordId(),
        ...(verifiedIntegrityTag && /^sha256:[a-f0-9]{64}$/i.test(verifiedIntegrityTag)
          ? { integrityTag: verifiedIntegrityTag, integrityCheckedAt: now }
          : {}),
        ...(typeof integrityRequired === 'boolean' ? { integrityRequired } : {}),
        ...(verifiedIntegrityManifest && verifiedIntegrityManifest.size === sizeOf(data)
          ? { integrityManifest: verifiedIntegrityManifest } : {}),
      }
      tx.objectStore(STORE_META).put(meta, key)
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
