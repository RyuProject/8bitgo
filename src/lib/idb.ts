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
   * 同一毫秒里也能分清两次写入的凭证。
   *
   * 只拿 updatedAt 做版本守卫仍有一个很窄但真实的洞：两次快速存档、或两个标签页，
   * 完全可能在同一毫秒写入。那时旧上传的回调会把新档误标成“已经上云”。
   * 老数据没有这个字段，继续用时间戳守卫，等下一次写入就会自然补齐。
   */
  revision?: string
  /** 这份本地档最后一次确认对应的服务端版本；自动补传拿它做乐观锁。 */
  cloudRevision?: string
  /** 待同步档属于哪个账号；换号后绝不能把上一个人的进度补传到新账号。 */
  cloudOwner?: string
  /** 冲突 / 超限不能靠反复重试解决，记下来避免后台请求死循环。 */
  syncBlocked?: 'conflict' | 'too-large' | 'quota'
  /** 生成通用存档文件头时要带回去的核心与格式信息。 */
  saveMetadata?: Record<string, string>
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
  const e = v as {
    data?: unknown
    updatedAt?: unknown
    dirty?: unknown
    revision?: unknown
    cloudRevision?: unknown
    cloudOwner?: unknown
    syncBlocked?: unknown
    saveMetadata?: unknown
  }
  if (!(e.data instanceof Uint8Array)) return null
  return {
    data: e.data,
    updatedAt: typeof e.updatedAt === 'number' ? e.updatedAt : 0,
    dirty: e.dirty === true,
    revision: typeof e.revision === 'string' ? e.revision : undefined,
    cloudRevision: typeof e.cloudRevision === 'string' ? e.cloudRevision : undefined,
    cloudOwner: typeof e.cloudOwner === 'string' ? e.cloudOwner : undefined,
    syncBlocked: e.syncBlocked === 'conflict' || e.syncBlocked === 'too-large' || e.syncBlocked === 'quota'
      ? e.syncBlocked
      : undefined,
    saveMetadata: e.saveMetadata && typeof e.saveMetadata === 'object'
      ? e.saveMetadata as Record<string, string>
      : undefined,
  }
}

export interface IdbPutOptions {
  cloudRevision?: string
  cloudOwner?: string
  syncBlocked?: IdbEntry['syncBlocked']
  saveMetadata?: Record<string, string>
}

export async function idbPut(
  key: string,
  data: Uint8Array,
  updatedAt = Date.now(),
  dirty = false,
  revision?: string,
  options: IdbPutOptions = {},
): Promise<boolean> {
  // 存进去的必须是自己的副本：调用方可能复用同一段 buffer，
  // 而 IndexedDB 是异步落盘的，直接存原引用有可能存到被改过的数据
  const copy = new Uint8Array(data)
  const r = await tx<IDBValidKey>('readwrite', (s) => s.put({
    data: copy,
    updatedAt,
    dirty,
    revision,
    cloudRevision: options.cloudRevision,
    cloudOwner: options.cloudOwner,
    syncBlocked: options.syncBlocked,
    saveMetadata: options.saveMetadata,
  }, key))
  return r !== null
}

/**
 * 只改同步状态，不重写数据。
 *
 * 用在「先写本地、再推云端」这个顺序里：数据落地的那一刻还不知道云端会不会成功，
 * 等结果回来再把标记落定。重新 put 一遍整份数据只是为了改一个布尔值，
 * DOS 的变更包能有几百 KB，没必要。
 */
export async function idbMark(
  key: string,
  dirty: boolean,
  expectUpdatedAt?: number,
  expectRevision?: string,
  updates: Pick<IdbPutOptions, 'cloudRevision' | 'syncBlocked'> = {},
): Promise<boolean> {
  /*
    ⚠️⚠️ `expectUpdatedAt` 不是可选的讲究，是防丢档的。

    这个函数原来是跨两个事务的 read-modify-write，而且最早还**只认 key、不认版本** ——
    于是同一个存档位上有两次并发推送时：
      1. 存档 A：idbPut(A, dirty=true)，PUT A 上路；
      2. 玩家没看到反馈又按了一次（N64/PSX 的快照推云端要好几秒，而快捷键那条路
         连防连点都没有）→ 存档 B：idbPut(B, dirty=true)，本地现在是 B；
      3. PUT A 先回 200 → idbMark(key, false) 读到的是 **B 的数据**，
         写回 {data: B, dirty: false} —— 云端是 A，本地是 B 却被标成「已同步」；
      4. PUT B 随后失败（令牌过期 / 断网 / 超配额）→ pushSave 不会把标记改回去；
      5. 下次进游戏 pullSave 看 dirty=false → 读云端的 A。**B 没了。**
    另一条不需要任何失败的变体：两个 PUT 都成功但到达顺序反了，云端留下更旧的 A，
    而本地 B 已被标成 clean，同样丢 B。

    带上推送时的版本之后，「这份已经不是我推的那份了」不能清标记。还有一个更隐蔽的
    到达顺序：后来者 B 已经上传并标成 clean，旧请求 A 才最后回 200；这时云端又可能被 A
    覆盖，所以必须把 B 重新标成 dirty。否则本地虽然保住了 B，下次读档仍会拿云端的 A。

    这里还必须把 get + put 放进**同一个 readwrite 事务**。若先读、事务结束、再开一个事务写，
    另一个标签页可以恰好在两者之间写入 B；本页随后仍会把刚读到的 A 整份写回去，
    版本判断虽然做了，数据却还是被回滚成 A。IndexedDB 会串行同一对象仓库的 readwrite 事务，
    所以在一个事务里做条件更新，检查与落盘之间才没有缝。
  */
  const db = await openDb()
  if (!db) return false
  return new Promise<boolean>((resolve) => {
    let settled = false
    const finish = (ok: boolean) => {
      if (settled) return
      settled = true
      resolve(ok)
    }
    try {
      const transaction = db.transaction(STORE, 'readwrite')
      const store = transaction.objectStore(STORE)
      const request = store.get(key) as IDBRequest<unknown>
      request.onerror = () => finish(false)
      transaction.onabort = () => finish(false)
      transaction.onerror = () => finish(false)
      request.onsuccess = () => {
        const raw = request.result
        if (!raw || typeof raw !== 'object') return finish(false)
        const cur = raw as {
          data?: unknown
          updatedAt?: unknown
          dirty?: unknown
          revision?: unknown
          cloudRevision?: unknown
          syncBlocked?: unknown
        }
        if (!(cur.data instanceof Uint8Array)) return finish(false)
        const versionChanged =
          (expectUpdatedAt !== undefined && cur.updatedAt !== expectUpdatedAt) ||
          // 新写入都有 revision；老数据没有时仍靠 updatedAt 保持兼容。
          (expectRevision !== undefined && cur.revision !== expectRevision)
        if (versionChanged) {
          if (!dirty && cur.dirty !== true) {
            // 旧上传晚到会把云端倒退；把较新的本地档重新标成待同步，至少保证下次读档不倒退。
            const put = store.put({ ...cur, dirty: true }, key)
            put.onsuccess = () => finish(false)
            put.onerror = () => finish(false)
            return
          }
          return finish(false)
        }
        const hasCloudRevision = Object.prototype.hasOwnProperty.call(updates, 'cloudRevision')
        const hasSyncBlocked = Object.prototype.hasOwnProperty.call(updates, 'syncBlocked')
        const unchanged =
          (cur.dirty === true) === dirty &&
          (!hasCloudRevision || cur.cloudRevision === updates.cloudRevision) &&
          (!hasSyncBlocked || cur.syncBlocked === updates.syncBlocked)
        if (unchanged) return finish(true)
        const put = store.put({
          ...cur,
          dirty,
          ...(hasCloudRevision ? { cloudRevision: updates.cloudRevision } : {}),
          // undefined 表示清掉旧的阻塞原因；成功同步或新存档都要能恢复自动补传。
          ...(hasSyncBlocked ? { syncBlocked: updates.syncBlocked } : {}),
        }, key)
        put.onsuccess = () => finish(true)
        put.onerror = () => finish(false)
      }
    } catch {
      finish(false)
    }
  })
}

export async function idbDelete(key: string): Promise<void> {
  await tx<undefined>('readwrite', (s) => s.delete(key))
}

export async function idbKeys(): Promise<string[]> {
  const keys = await tx<IDBValidKey[]>('readonly', (s) => s.getAllKeys())
  return (keys ?? []).map(String)
}
