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
  /**
   * 这份数据还没成功同步到服务器。
   *
   * 存档要用它来定「读档该读哪份」：云端推送失败过（断网、超配额、令牌过期）的时候，
   * 本地这份才是玩家最后玩到的进度，云端那份是旧的。用标记而不是比 updatedAt ——
   * 本地时间戳来自玩家的机器，时钟不准（差几小时甚至几天的机器很常见）就会选错。
   *
   * 老数据里没有这个字段，读出来按 false 算：那些是「云端优先」时代写的，
   * 当时能写进本地就说明云端那一路也已经走过了。
   */
  dirty: boolean
}

export async function idbGet(key: string): Promise<IdbEntry | null> {
  const v = await tx<unknown>('readonly', (s) => s.get(key) as IDBRequest<unknown>)
  if (!v || typeof v !== 'object') return null
  const e = v as { data?: unknown; updatedAt?: unknown; dirty?: unknown }
  if (!(e.data instanceof Uint8Array)) return null
  return {
    data: e.data,
    updatedAt: typeof e.updatedAt === 'number' ? e.updatedAt : 0,
    dirty: e.dirty === true,
  }
}

export async function idbPut(
  key: string,
  data: Uint8Array,
  updatedAt = Date.now(),
  dirty = false,
): Promise<boolean> {
  // 存进去的必须是自己的副本：调用方可能复用同一段 buffer，
  // 而 IndexedDB 是异步落盘的，直接存原引用有可能存到被改过的数据
  const copy = new Uint8Array(data)
  const r = await tx<IDBValidKey>('readwrite', (s) => s.put({ data: copy, updatedAt, dirty }, key))
  return r !== null
}

/**
 * 只改同步状态，不重写数据。
 *
 * 用在「先写本地、再推云端」这个顺序里：数据落地的那一刻还不知道云端会不会成功，
 * 等结果回来再把标记落定。重新 put 一遍整份数据只是为了改一个布尔值，
 * DOS 的变更包能有几百 KB，没必要。
 */
export async function idbMark(key: string, dirty: boolean): Promise<void> {
  const cur = await idbGet(key)
  if (!cur || cur.dirty === dirty) return
  await tx<IDBValidKey>('readwrite', (s) => s.put({ data: cur.data, updatedAt: cur.updatedAt, dirty }, key))
}

export async function idbDelete(key: string): Promise<void> {
  await tx<undefined>('readwrite', (s) => s.delete(key))
}

export async function idbKeys(): Promise<string[]> {
  const keys = await tx<IDBValidKey[]>('readonly', (s) => s.getAllKeys())
  return (keys ?? []).map(String)
}
