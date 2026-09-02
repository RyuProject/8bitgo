/**
 * 大文件分片上传 + 断点续传（后台专用）。
 *
 * ## 为什么存在
 *
 * 后台传 100MB 的游戏时，报的错是「网络错误：无法连接 Worker（检查地址与 CORS）」——
 * 但 Worker 是好的。真实原因是 **Cloudflare 的请求体上限由边缘节点执行**
 * （Free / Pro 100 MB，Business 200 MB，Enterprise 500 MB），超了直接 reset 连接，
 * 浏览器拿不到 413，XHR 只会触发 onerror。Worker 代码一行都没运行 ——
 * 失败时 `npx wrangler tail` 里连一条日志都没有，正是这个原因的指纹。
 *
 * 另一半原因是单发 PUT 本身太脆：国内上行几百 KB/s ~ 几 MB/s，100MB 要占用一条连接好几分钟，
 * 中间任何一次 TCP reset / Wi-Fi 切换 / 代理超时，整个 100MB 从 0 重来。这解释了「有的时候」。
 *
 * 分片把这两件事一起解决：上限按**单个请求**算，8MB 一片离上限很远；断了只重传那一片。
 *
 * ## 账本记在哪
 *
 * R2 的 Workers binding 没有 listParts，complete 时必须由调用方把每一片的
 * {partNumber, etag} 全部报回来。所以「传到哪了」这份账只能记在这边（localStorage）：
 *   - uploadId 和已传分片本身活在 R2 里，跨刷新、跨 Worker 冷启动都在
 *   - 但换浏览器 / 清了站点数据就续不上了，只能重开一次（残留分片由「ROM 存储」页清理）
 *
 * ## 续传的前提：文件身份必须对得上
 *
 * 恢复前校验 文件名 + 字节数 + lastModified + 分片大小，四个全中才接着传。
 * 少了这道校验，换了个文件接着传会拼出一个**损坏但看起来正常**的对象 ——
 * 大小对、etag 有、下载下来解压报错，而且完全静默。
 */
import { encodeKey, explainRomStatus, getRomApi, getRomToken, guessUploadType, romUrlForKey } from './roms'
import type { UploadProgress, UploadResult } from './roms'

/**
 * 一片 8MB。R2 的约束是「除最后一片外所有片必须等大，且不小于 5MB，最多 10000 片」，
 * 所以这个值一旦改了，**旧的续传记录就作废**（下面的身份校验会带上 partSize，自动作废）。
 */
export const PART_SIZE = 8 * 1024 * 1024
/** 3 并发：够把国内上行跑满，又不至于让某一片长期卡在队列里超时 */
const CONCURRENCY = 3
/** 单片重试次数（含首次）。网络抖动一两次很常见，一直重试就只是在耗时间 */
const ATTEMPTS = 3
const MAX_PARTS = 10000

const STORE_KEY = '8bitgo.rom.multipart'
/** 一周没动过的记录直接丢：那个 uploadId 大概率早就被 R2 清了，留着只会误导 */
const STORE_TTL = 7 * 24 * 60 * 60 * 1000
const STORE_MAX = 20

export interface PendingUpload {
  /** 最终对象 key */
  key: string
  uploadId: string
  /** Worker 那边的标记对象，用来在「ROM 存储」页列出残留 */
  marker: string
  partSize: number
  fileName: string
  fileSize: number
  lastModified: number
  parts: { partNumber: number; etag: string }[]
  updatedAt: number
}

/** 上传过程里 HTTP 层面的失败。fatal 表示重试没有意义（uploadId 作废、分片对不上） */
class UploadHttpError extends Error {
  status: number
  fatal: boolean
  constructor(message: string, status: number, fatal = false) {
    super(message)
    this.status = status
    this.fatal = fatal
  }
}

/** 这个 Worker 还没部署分片接口（老版本）。roms.ts 收到它会退回单发 PUT */
export class MultipartUnsupportedError extends Error {}

/* ---------------- 本地账本 ---------------- */

function readStore(): Record<string, PendingUpload> {
  try {
    const raw = localStorage.getItem(STORE_KEY)
    const data = raw ? (JSON.parse(raw) as Record<string, PendingUpload>) : {}
    return data && typeof data === 'object' ? data : {}
  } catch {
    return {}
  }
}

function writeStore(store: Record<string, PendingUpload>) {
  try {
    // 过期的先丢，再按时间留最近 STORE_MAX 条 —— localStorage 是有配额的，
    // 而这些记录只在「刚失败、马上重传」的窗口里有用
    const now = Date.now()
    const kept = Object.values(store)
      .filter((p) => now - p.updatedAt < STORE_TTL)
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, STORE_MAX)
    localStorage.setItem(STORE_KEY, JSON.stringify(Object.fromEntries(kept.map((p) => [p.key, p]))))
  } catch {
    /* 存不下就退化成「不能续传」，不影响这次上传本身 */
  }
}

function saveState(state: PendingUpload) {
  const store = readStore()
  store[state.key] = { ...state, updatedAt: Date.now() }
  writeStore(store)
}

function clearState(key: string) {
  const store = readStore()
  delete store[key]
  writeStore(store)
}

/** 本浏览器记着的未完成上传，新的在前 */
export function listPendingUploads(): PendingUpload[] {
  return Object.values(readStore()).sort((a, b) => b.updatedAt - a.updatedAt)
}

/** File 才有身份可校验；从 zip 里解出来的 Blob 没有名字和时间，只能不续传 */
function identityOf(file: Blob): { fileName: string; lastModified: number } | null {
  const f = file as File
  if (typeof f.name !== 'string' || !f.name) return null
  if (typeof f.lastModified !== 'number' || !Number.isFinite(f.lastModified)) return null
  return { fileName: f.name, lastModified: f.lastModified }
}

/**
 * 找出可以接着传的记录。四项全中才认：
 * 同一个 key、同样的字节数、同样的文件名 + 修改时间、同样的分片大小。
 */
function resumableFor(key: string, file: Blob, ident: { fileName: string; lastModified: number }, partSize: number): PendingUpload | null {
  const found = readStore()[key]
  if (!found || !found.uploadId) return null
  if (found.fileSize !== file.size || found.partSize !== partSize) return null
  if (found.fileName !== ident.fileName || found.lastModified !== ident.lastModified) return null
  if (!Array.isArray(found.parts)) return null
  const total = Math.max(1, Math.ceil(file.size / partSize))
  // 记录里出现越界的片号说明这份账本已经不可信了，宁可重传
  if (found.parts.some((p) => !p.etag || p.partNumber < 1 || p.partNumber > total)) return null
  return found
}

/* ---------------- 与 Worker 的四次对话 ---------------- */

interface Ctx {
  api: string
  token: string
}

async function askJson<T>(ctx: Ctx, url: string, init: RequestInit, what: string): Promise<T> {
  let res: Response
  try {
    res = await fetch(url, {
      ...init,
      headers: { Authorization: `Bearer ${ctx.token}`, ...(init.headers ?? {}) },
    })
  } catch {
    // fetch 抛出来的是 TypeError('Failed to fetch')，直接冒出去既难懂又会被当成
    // 「不可重试」。包成 status 0 的网络错误，上面才知道这次是可以续传的
    throw new UploadHttpError(`${what}失败：无法连接 Worker（网络中断或跨域被拒）`, 0)
  }
  const data = (await res.json().catch(() => null)) as (T & { error?: string; fatal?: boolean }) | null
  if (!res.ok) {
    // 老版本 Worker 上，对着一个 key 发 POST 只会得到 405 / 404 —— 那是「没部署分片接口」，
    // 不是「上传失败」，要能和真失败区分开
    if (res.status === 404 || res.status === 405) throw new MultipartUnsupportedError(what)
    throw new UploadHttpError(data?.error || explainRomStatus(res.status, what).message, res.status, Boolean(data?.fatal))
  }
  // 地址填成了本站域名时会落到 SSR 兜底路由，回的是 200 + 一个 HTML 页面（roms.ts 里
  // 那个「200 + HTML」的坑）。这里拿不到 JSON 就必须报错，否则后面读 data.uploadId 才炸
  if (!data) throw new UploadHttpError(`${what}失败：Worker 返回的不是 JSON（地址是不是填成了站点域名？）`, res.status)
  return data
}

async function createUpload(ctx: Ctx, key: string, file: Blob, ident: { fileName: string; lastModified: number } | null, partSize: number): Promise<PendingUpload> {
  const data = await askJson<{ uploadId: string; marker: string }>(
    ctx,
    `${ctx.api}/${encodeKey(key)}?uploads`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      // contentType 只有开始时能设，complete() 不收 —— 漏了封面图会变成提示下载
      body: JSON.stringify({ contentType: file.type || guessUploadType(key), size: file.size, name: ident?.fileName ?? '' }),
    },
    '开始分片上传',
  )
  return {
    key,
    uploadId: data.uploadId,
    marker: data.marker ?? '',
    partSize,
    fileName: ident?.fileName ?? '',
    fileSize: file.size,
    lastModified: ident?.lastModified ?? 0,
    parts: [],
    updatedAt: Date.now(),
  }
}

/** 传一片。用 XHR 而不是 fetch：只有 XHR 能报上传进度 */
function putPart(ctx: Ctx, state: PendingUpload, partNumber: number, blob: Blob, onLoaded: (bytes: number) => void): Promise<string> {
  const url = `${ctx.api}/${encodeKey(state.key)}?uploadId=${encodeURIComponent(state.uploadId)}&partNumber=${partNumber}`
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest()
    xhr.open('PUT', url)
    xhr.setRequestHeader('Authorization', `Bearer ${ctx.token}`)
    xhr.setRequestHeader('Content-Type', 'application/octet-stream')

    /**
     * 卡死检测。XHR 自带的 timeout 是「整片的总时长」，上行慢的时候会把正常的传输也判死；
     * 这里改成盯**有没有进展**：45 秒一个字节都没动就主动 abort，交给外面重试这一片。
     * 没有它的话，一条半死的连接能把整次上传永远挂在那儿（正是「传一半没反应」那种现象）。
     */
    let lastAt = Date.now()
    const watchdog = window.setInterval(() => {
      if (Date.now() - lastAt > 45_000) {
        window.clearInterval(watchdog)
        xhr.abort()
      }
    }, 5_000)
    const done = () => window.clearInterval(watchdog)

    xhr.upload.onprogress = (e) => {
      lastAt = Date.now()
      if (e.lengthComputable) onLoaded(e.loaded)
    }
    xhr.onerror = () => {
      done()
      reject(new UploadHttpError('网络中断', 0))
    }
    xhr.onabort = () => {
      done()
      reject(new UploadHttpError('这一片 45 秒没有任何进展，已中断重试', 0))
    }
    xhr.onload = () => {
      done()
      const data = (() => {
        try {
          return JSON.parse(xhr.responseText) as { etag?: string; error?: string; fatal?: boolean }
        } catch {
          return null
        }
      })()
      if (xhr.status >= 200 && xhr.status < 300 && data?.etag) {
        onLoaded(blob.size)
        resolve(data.etag)
        return
      }
      if (xhr.status === 404 || xhr.status === 405) {
        reject(new MultipartUnsupportedError('传分片'))
        return
      }
      reject(new UploadHttpError(data?.error || explainRomStatus(xhr.status, '传分片').message, xhr.status, Boolean(data?.fatal)))
    }
    xhr.send(blob)
  })
}

/** 这些状态码重试多少次都一样：口令不对、片太大、uploadId 作废 */
function retryable(err: unknown): boolean {
  if (err instanceof MultipartUnsupportedError) return false
  if (!(err instanceof UploadHttpError)) return false
  if (err.fatal) return false
  return !(err.status === 400 || err.status === 401 || err.status === 403 || err.status === 409 || err.status === 413)
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** 可重试的错误就退避重试，其余立刻抛 */
async function withRetry<T>(run: () => Promise<T>, attempts: number): Promise<T> {
  let last: unknown
  for (let i = 0; i < attempts; i++) {
    if (i > 0) await sleep(600 * 2 ** (i - 1) + Math.random() * 400)
    try {
      return await run()
    } catch (err) {
      last = err
      if (!retryable(err)) throw err
    }
  }
  throw last
}

async function putPartWithRetry(ctx: Ctx, state: PendingUpload, partNumber: number, blob: Blob, onLoaded: (bytes: number) => void): Promise<string> {
  let last: unknown
  for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
    if (attempt > 0) await sleep(600 * 2 ** (attempt - 1) + Math.random() * 400)
    try {
      return await putPart(ctx, state, partNumber, blob, onLoaded)
    } catch (err) {
      last = err
      // 重试要从 0 字节重新算这一片的进度，否则进度条会往前虚报
      onLoaded(0)
      if (!retryable(err)) throw err
    }
  }
  throw last
}

async function completeUpload(ctx: Ctx, state: PendingUpload): Promise<number> {
  const data = await askJson<{ size: number }>(
    ctx,
    `${ctx.api}/${encodeKey(state.key)}?uploadId=${encodeURIComponent(state.uploadId)}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        parts: [...state.parts].sort((a, b) => a.partNumber - b.partNumber),
        marker: state.marker,
      }),
    },
    '合并分片',
  )
  return Number(data?.size) || state.fileSize
}

async function abortUpload(ctx: Ctx, key: string, uploadId: string, marker: string): Promise<void> {
  const qs = new URLSearchParams({ uploadId })
  if (marker) qs.set('marker', marker)
  await fetch(`${ctx.api}/${encodeKey(key)}?${qs.toString()}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${ctx.token}` },
  })
}

/* ---------------- 主流程 ---------------- */

/**
 * 分片上传一个文件；同一个 key + 同一个文件时自动从上次断掉的地方接着传。
 *
 * 失败时**故意保留**本地续传记录：管理员重新选同一个文件再点一次上传，
 * 就从下一片开始，不用把已经传上去的几十 MB 再传一遍。
 * 只有「这次上传已经作废」（uploadId 过期、分片对不上）才会清掉记录并 abort ——
 * 否则会卡在「续传 → 失败 → 续传」的死循环里。
 */
export async function uploadRomMultipart(file: Blob, key: string, onProgress?: UploadProgress): Promise<UploadResult> {
  const ctx: Ctx = { api: getRomApi(), token: getRomToken() }
  const partSize = PART_SIZE
  const total = Math.max(1, Math.ceil(file.size / partSize))
  if (total > MAX_PARTS) throw new Error(`文件太大：${total} 片超过 R2 的 10000 片上限`)

  const ident = identityOf(file)
  const resumedState = ident ? resumableFor(key, file, ident, partSize) : null
  const state = resumedState ?? (await createUpload(ctx, key, file, ident, partSize))
  const resumed = resumedState ? resumedState.parts.length : 0
  if (ident) saveState(state)

  /** 除最后一片外都是 partSize —— R2 要求「除末片外等大」，这也是身份校验要带上 partSize 的原因 */
  const sizeOfPart = (n: number) => Math.min(partSize, file.size - (n - 1) * partSize)
  const finished = new Set(state.parts.map((p) => p.partNumber))
  /** 每片当前已上传的字节数（含正在传的那几片），进度条按它们的和算 */
  const loaded = new Map<number, number>()
  for (const n of finished) loaded.set(n, sizeOfPart(n))

  const report = () => {
    let sum = 0
    for (const v of loaded.values()) sum += v
    // 封顶 99%：合并分片还要花一两秒，先跳到 100% 再卡住会让人以为卡死了
    const pct = Math.min(99, Math.round((sum / Math.max(1, file.size)) * 100))
    onProgress?.(pct, { parts: total, done: finished.size, resumed })
  }
  report()

  const queue = Array.from({ length: total }, (_, i) => i + 1).filter((n) => !finished.has(n))
  let failure: unknown = null

  const runner = async () => {
    for (;;) {
      if (failure) return
      const n = queue.shift()
      if (n === undefined) return
      const start = (n - 1) * partSize
      const blob = file.slice(start, start + sizeOfPart(n))
      try {
        const etag = await putPartWithRetry(ctx, state, n, blob, (bytes) => {
          loaded.set(n, bytes)
          report()
        })
        state.parts.push({ partNumber: n, etag })
        finished.add(n)
        loaded.set(n, sizeOfPart(n))
        // 每传完一片就落一次账：浏览器崩了 / 关了页面也只丢正在传的那几片
        if (ident) saveState(state)
        report()
      } catch (err) {
        failure = err
        return
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, Math.max(1, queue.length)) }, () => runner()))
  if (failure) throw await explainFailure(failure, ctx, state, total, Boolean(ident))

  let size: number
  try {
    // 值得多试两次：分片全都已经在 R2 上了，只差这一个请求，
    // 因为一次网络抖动就把几十 MB 判成失败太可惜
    size = await withRetry(() => completeUpload(ctx, state), 3)
  } catch (err) {
    throw await explainFailure(err, ctx, state, total, Boolean(ident))
  }

  clearState(key)
  onProgress?.(100, { parts: total, done: total, resumed })
  return { key, url: romUrlForKey(key), size }
}

/**
 * 把失败翻译成人话，并决定「这次上传还能不能续」。
 *
 * 不能续的三种情况都要 abort，否则那些分片会**一直按存储计费**，
 * 而且从任何界面都看不见（binding 没有 listMultipartUploads，只能靠标记对象）：
 *   1. Worker 还没部署分片接口 —— 上层会退回单发 PUT，这个 uploadId 不会再被用到
 *   2. uploadId 作废 / 分片对不上（fatal）—— 再续也只会在 complete 那步失败
 *   3. 文件没有身份可校验（从 zip 解出来的 Blob）—— 本来就不支持续传
 */
async function explainFailure(err: unknown, ctx: Ctx, state: PendingUpload, total: number, resumable: boolean): Promise<unknown> {
  // 口令不对 / 过期是**可以修好**的，不能因此把已经传上去的分片扔掉 ——
  // 填对口令重新点一次就能接着传，abort 掉才是真的白传
  const authProblem = err instanceof UploadHttpError && (err.status === 401 || err.status === 403)
  const fatal =
    !authProblem &&
    (err instanceof MultipartUnsupportedError || (err instanceof UploadHttpError && (err.fatal || !retryable(err))))
  if (!resumable || fatal) {
    await abortUpload(ctx, state.key, state.uploadId, state.marker).catch(() => {})
    clearState(state.key)
  } else {
    saveState(state)
  }

  if (err instanceof MultipartUnsupportedError) return err
  const base = err instanceof Error ? err.message : String(err)
  const at = `已传 ${state.parts.length}/${total} 片`
  if (!resumable) return new Error(`${base}（${at}，这次的分片已清理）`)
  if (fatal) return new Error(`${base}（本次分片上传已作废，续传记录已清理，请重新上传）`)
  return new Error(`${base}（${at}；重新选同一个文件再点上传，会从第 ${state.parts.length + 1} 片继续）`)
}

/* ---------------- 残留清理（「ROM 存储」页用） ---------------- */

export interface OrphanUpload {
  marker: string
  key: string
  uploadId: string
  size: number
  name: string
  at: string
}

/**
 * 列出桶里所有未完成的分片上传。
 *
 * 数据来自 Worker 写的标记对象，所以**跨浏览器可见** ——
 * 本地那份 localStorage 记录只够自己续传，别人机器上失败留下的残留得靠这个才看得见。
 */
export async function listOrphanUploads(): Promise<OrphanUpload[]> {
  const api = getRomApi()
  const token = getRomToken()
  if (!api || !token) return []
  const res = await fetch(`${api}/multipart`, { headers: { Authorization: `Bearer ${token}` }, cache: 'no-store' })
  // 老版本 Worker 没这个接口，当成「没有残留」，不要在页面上报错
  if (res.status === 404 || res.status === 405) return []
  if (!res.ok) throw explainRomStatus(res.status, '读取未完成的分片上传')
  const data = (await res.json()) as { uploads?: OrphanUpload[] }
  return data.uploads ?? []
}

/** 放弃一次残留的分片上传：R2 里的分片和标记一起清掉，本地记录也顺手删了 */
export async function abortOrphanUpload(item: OrphanUpload): Promise<void> {
  const ctx: Ctx = { api: getRomApi(), token: getRomToken() }
  if (item.key && item.uploadId) {
    await abortUpload(ctx, item.key, item.uploadId, item.marker)
  } else if (item.marker) {
    // 标记里连 key 都没有（不该出现，除非被手工改过）：至少把标记删掉，别让列表永远清不空
    await fetch(`${ctx.api}/multipart?marker=${encodeURIComponent(item.marker)}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${ctx.token}` },
    })
  }
  const local = readStore()[item.key]
  if (local?.uploadId === item.uploadId) clearState(item.key)
}

