/**
 * 一个很小的 IndexedDB 键值库，专门放二进制。
 *
 * 为什么不用 localStorage：存档是二进制，塞进 localStorage 要先转 base64（体积涨 1/3），
 * 而且 localStorage 整个域名一共就 5MB —— 几份 GBA 快照就满了。
 *
 * 用途：没登录的玩家，存档就落在这里（"存在浏览器上"）。
 * 浏览器可能在清理缓存时把它删掉，这一点在界面上要跟玩家说清楚。
 */
const DB_NAME = '8bitgo'
const STORE = 'saves'

let dbPromise: Promise<IDBDatabase | null> | null = null

function openDb(): Promise<IDBDatabase | null> {
  if (dbPromise) return dbPromise
  dbPromise = new Promise((resolve) => {
    // 无痕模式、禁用了站点数据、SSR —— 这些情况下直接当作「没有本地存储」，不要抛错
    if (typeof indexedDB === 'undefined') return resolve(null)
    let req: IDBOpenDBRequest
    try {
      req = indexedDB.open(DB_NAME, 1)
    } catch {
      return resolve(null)
    }
    req.onupgradeneeded = () => {
      const db = req.result
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE)
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => resolve(null)
    // 有的浏览器在别的标签页占着旧版本时会一直卡在 blocked，给个上限别让调用方永远等
    req.onblocked = () => resolve(null)
  })
  return dbPromise
}

function tx<T>(mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest<T>): Promise<T | null> {
  return openDb().then(
    (db) =>
      new Promise<T | null>((resolve) => {
        if (!db) return resolve(null)
        try {
          const request = run(db.transaction(STORE, mode).objectStore(STORE))
          request.onsuccess = () => resolve(request.result)
          request.onerror = () => resolve(null)
        } catch {
          resolve(null)
        }
      }),
  )
}

export interface IdbEntry {
  data: Uint8Array
  updatedAt: number
}

export async function idbGet(key: string): Promise<IdbEntry | null> {
  const v = await tx<unknown>('readonly', (s) => s.get(key) as IDBRequest<unknown>)
  if (!v || typeof v !== 'object') return null
  const e = v as { data?: unknown; updatedAt?: unknown }
  if (!(e.data instanceof Uint8Array)) return null
  return { data: e.data, updatedAt: typeof e.updatedAt === 'number' ? e.updatedAt : 0 }
}

export async function idbPut(key: string, data: Uint8Array, updatedAt = Date.now()): Promise<boolean> {
  // 存进去的必须是自己的副本：调用方可能复用同一段 buffer，
  // 而 IndexedDB 是异步落盘的，直接存原引用有可能存到被改过的数据
  const copy = new Uint8Array(data)
  const r = await tx<IDBValidKey>('readwrite', (s) => s.put({ data: copy, updatedAt }, key))
  return r !== null
}

export async function idbDelete(key: string): Promise<void> {
  await tx<undefined>('readwrite', (s) => s.delete(key))
}

export async function idbKeys(): Promise<string[]> {
  const keys = await tx<IDBValidKey[]>('readonly', (s) => s.getAllKeys())
  return (keys ?? []).map(String)
}
