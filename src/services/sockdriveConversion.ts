/** 大型 DOS / Windows ZIP → Sockdrive 后台任务客户端；原始文件继续复用 ROM multipart 上传。 */
import { api, ApiError } from './api'
import { trackUploadActivity } from './uploadActivity'
import type { UploadActivityOptions } from './uploadActivity'
import { fingerprintRomUploadFile } from './romFingerprint'

export type SockdriveConversionStatus =
  | 'queued'
  | 'downloading'
  | 'converting'
  | 'uploading'
  | 'verifying'
  | 'completed'
  | 'failed'

export interface SockdriveConversionCapability {
  available: boolean
  reason: string
  maxSourceBytes: number
  format: string
  /** 生产 Worker 支持用同桶复制代替浏览器重复上传；旧 Worker 仍走兼容上传路径。 */
  sourceCopyAvailable?: boolean
}

export interface SockdriveConversionJob {
  id: string
  sourceKey: string
  targetPrefix: string
  status: SockdriveConversionStatus
  progress: number
  sourceSize: number
  outputBytes: number | null
  outputFiles: number | null
  gameSlug: string
  lang?: string | null
  targetRomKey?: string | null
  executable: string
  bound: boolean
  message: string
  error: string
  createdAt?: string
  updatedAt?: string
  completedAt?: string | null
}

export interface CreateSockdriveConversion {
  sourceKey: string
  sourceSize: number
  gameSlug: string
  lang?: string
  /** 已上传的同语言完整回退包；转换完成时与流式盘一起原子绑定。 */
  targetRomKey?: string
  /** 创建任务时数据库里的旧 key；空表示新增语言槽。 */
  expectedRomKey?: string
  executable: string
  version: string
  expectedSockdrive?: string
  encoding?: 'br' | 'gzip' | 'identity'
}

const REMEMBER_KEY = '8bitgo.sockdrive.conversions'
const PENDING_CREATE_KEY = '8bitgo.sockdrive.pending-creations'
const UPLOAD_IDENTITY_KEY = '8bitgo.sockdrive.upload-identities'
const SOCKDRIVE_UPLOAD_TTL = 7 * 24 * 60 * 60 * 1000

function remembered(): Record<string, string> {
  try {
    const value = JSON.parse(localStorage.getItem(REMEMBER_KEY) || '{}')
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {}
  } catch { return {} }
}

const rememberId = (slug: string, lang?: string) => lang ? `${slug}:${lang}` : slug

interface PendingSockdriveCreation {
  request: CreateSockdriveConversion
  savedAt: number
}

interface SockdriveUploadRecord {
  key: string
  version: string
  fileName: string
  fileSize: number
  lastModified: number
  fileFingerprint: string
  signature: string
  savedAt: number
}

export interface SockdriveUploadIdentity {
  key: string
  version: string
}

function pendingCreations(): Record<string, PendingSockdriveCreation> {
  try {
    const value = JSON.parse(localStorage.getItem(PENDING_CREATE_KEY) || '{}')
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {}
  } catch { return {} }
}

function writePendingCreations(value: Record<string, PendingSockdriveCreation>) {
  try {
    const cutoff = Date.now() - SOCKDRIVE_UPLOAD_TTL
    const entries = Object.entries(value)
      .filter(([, item]) => item && Number(item.savedAt) >= cutoff)
      .sort((a, b) => Number(b[1].savedAt) - Number(a[1].savedAt))
      .slice(0, 40)
    localStorage.setItem(PENDING_CREATE_KEY, JSON.stringify(Object.fromEntries(entries)))
  } catch {
    /* 这只是“上传完、建任务响应丢失”的恢复账本；写不进去不能阻止本次正常建任务。 */
  }
}

function uploadIdentities(): Record<string, SockdriveUploadRecord> {
  try {
    const value = JSON.parse(localStorage.getItem(UPLOAD_IDENTITY_KEY) || '{}')
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {}
  } catch { return {} }
}

function writeUploadIdentities(value: Record<string, SockdriveUploadRecord>) {
  try {
    const cutoff = Date.now() - SOCKDRIVE_UPLOAD_TTL
    const entries = Object.entries(value)
      .filter(([, item]) => item && Number(item.savedAt) >= cutoff)
      .sort((a, b) => Number(b[1].savedAt) - Number(a[1].savedAt))
      .slice(0, 40)
    localStorage.setItem(UPLOAD_IDENTITY_KEY, JSON.stringify(Object.fromEntries(entries)))
  } catch {
    // localStorage 不可用时仍可上传；仅退化为无法跨页面续传。
  }
}

export function rememberSockdriveConversion(slug: string, id: string | null, lang?: string) {
  try {
    const jobs = remembered()
    const key = rememberId(slug, lang)
    if (id) jobs[key] = id
    else delete jobs[key]
    localStorage.setItem(REMEMBER_KEY, JSON.stringify(jobs))
  } catch {
    /* localStorage 只恢复界面；任务真状态在 MySQL，无痕模式不影响后台继续。 */
  }
  // 同页的 ROM 一次上传入口与独立 Sockdrive 面板是兄弟组件；广播任务 ID 让两边共享重试入口。
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent('8bitgo:sockdrive-conversion', { detail: { slug, lang, id } }))
  }
}

export function rememberedSockdriveConversion(slug: string, lang?: string): string {
  return remembered()[rememberId(slug, lang)] || ''
}

/**
 * 原始 ZIP 已上传、但任务创建是否成功还不确定时保留完整请求。
 * sourceKey 是服务端幂等键；刷新后原样重发只会取回已有任务，不会再建第二份流式盘。
 */
export function rememberPendingSockdriveCreation(slug: string, request: CreateSockdriveConversion, lang?: string) {
  const entries = pendingCreations()
  entries[rememberId(slug, lang)] = { request, savedAt: Date.now() }
  writePendingCreations(entries)
}

export function rememberedPendingSockdriveCreation(slug: string, lang?: string): CreateSockdriveConversion | null {
  const entry = pendingCreations()[rememberId(slug, lang)]
  if (!entry?.request || entry.request.gameSlug !== slug || (entry.request.lang || undefined) !== lang) return null
  if (!Number.isFinite(Number(entry.savedAt)) || Date.now() - Number(entry.savedAt) >= SOCKDRIVE_UPLOAD_TTL) return null
  if (!/^sockdrive-staging\/[a-f0-9-]{16,}\.zip$/i.test(entry.request.sourceKey || '')) return null
  return entry.request
}

export function clearPendingSockdriveCreation(slug: string, lang?: string) {
  const entries = pendingCreations()
  delete entries[rememberId(slug, lang)]
  writePendingCreations(entries)
}

export function sockdriveStagingKey(): string {
  const id = globalThis.crypto?.randomUUID?.() || `${Date.now().toString(16)}-${Math.random().toString(16).slice(2)}`
  return `sockdrive-staging/${id}.zip`
}

/** 文件选择身份也钉住 staging key 与版本号；刷新后重选同一 ZIP 可续传同一个 multipart。 */
export async function sockdriveUploadIdentity(
  file: File,
  slug: string,
  lang: string | undefined,
  signature: string,
): Promise<SockdriveUploadIdentity> {
  const slot = rememberId(slug, lang)
  const fingerprint = await fingerprintRomUploadFile(file)
  const fresh = (): SockdriveUploadIdentity => ({ key: sockdriveStagingKey(), version: nextSockdriveVersion() })
  // 不支持轻量摘要时不按文件名 / 大小复用 key，避免碰到另一份内容或已完成任务。
  if (!fingerprint) return fresh()
  const entries = uploadIdentities()
  const previous = entries[slot]
  if (
    previous?.fileName === file.name && previous.fileSize === file.size && previous.lastModified === file.lastModified &&
    previous.fileFingerprint === fingerprint && previous.signature === signature &&
    Date.now() - Number(previous.savedAt) < SOCKDRIVE_UPLOAD_TTL &&
    /^sockdrive-staging\/[a-f0-9-]{16,}\.zip$/i.test(previous.key) && /^v[1-9]\d*$/.test(previous.version)
  ) return { key: previous.key, version: previous.version }

  const identity = fresh()
  entries[slot] = {
    ...identity, fileName: file.name, fileSize: file.size, lastModified: file.lastModified,
    fileFingerprint: fingerprint, signature, savedAt: Date.now(),
  }
  writeUploadIdentities(entries)
  return identity
}

export function clearSockdriveUploadIdentity(slug: string, lang: string | undefined, key: string) {
  const slot = rememberId(slug, lang)
  const entries = uploadIdentities()
  if (entries[slot]?.key !== key) return
  delete entries[slot]
  writeUploadIdentities(entries)
}

/** 时间版本不可复用，能同时避免 OPFS 混盘和两个管理员任务撞到同一目标目录。 */
export function nextSockdriveVersion(now = new Date()): string {
  // 两个标签页可能在同一毫秒为同一游戏发起任务；短随机尾码避免落到同一个不可覆盖目录。
  const random = new Uint32Array(1)
  if (globalThis.crypto?.getRandomValues) globalThis.crypto.getRandomValues(random)
  else random[0] = Math.floor(Math.random() * 0xffffffff)
  return `v${now.getTime()}${String(random[0] % 1_000_000).padStart(6, '0')}`
}

export const sockdriveConversionCapability = () =>
  api.get<SockdriveConversionCapability>('/api/admin/sockdrive-conversions/capability', true)

/** 这些错误没有证明服务器没执行请求；任务接口有 sourceKey / id 幂等保护，可以安全重试。 */
export function retryableSockdriveRequestError(error: unknown): boolean {
  if (error instanceof ApiError) {
    return error.status === 408 || error.status === 425 || error.status === 429 || error.status >= 500
  }
  return error instanceof TypeError || (error instanceof Error && /(?:failed to fetch|networkerror|network request failed)/i.test(error.message))
}

/** 401/403 也应保留已上传源文件：管理员修正登录或口令后，原 sourceKey 仍可继续建任务。 */
export function preserveSockdriveSourceAfterCreateError(error: unknown): boolean {
  return retryableSockdriveRequestError(error) || (error instanceof ApiError && (error.status === 401 || error.status === 403))
}

const wait = (ms: number, signal?: AbortSignal) => new Promise<void>((resolve, reject) => {
  if (signal?.aborted) return reject(new DOMException('页面已离开，后台转换仍会继续', 'AbortError'))
  const onAbort = () => {
    window.clearTimeout(timer)
    reject(new DOMException('页面已离开，后台转换仍会继续', 'AbortError'))
  }
  const timer = window.setTimeout(() => {
    signal?.removeEventListener('abort', onAbort)
    resolve()
  }, ms)
  signal?.addEventListener('abort', onAbort, { once: true })
})

async function retryRequest<T>(run: () => Promise<T>, attempts: number): Promise<T> {
  let last: unknown
  for (let attempt = 0; attempt < attempts; attempt++) {
    try { return await run() } catch (error) {
      last = error
      if (!retryableSockdriveRequestError(error) || attempt === attempts - 1) throw error
      await wait(700 * 2 ** attempt)
    }
  }
  throw last
}

export async function createSockdriveConversion(
  request: CreateSockdriveConversion,
  activityOptions?: UploadActivityOptions,
): Promise<SockdriveConversionJob> {
  // sourceKey 是幂等键；网关可能在服务端插入任务后才丢掉响应，原请求重发只会取回那一项。
  return trackUploadActivity('创建 Sockdrive 转换任务', () =>
    retryRequest(() => api.post<SockdriveConversionJob>('/api/admin/sockdrive-conversions', request, true), 5),
    activityOptions,
  )
}

export const getSockdriveConversion = (id: string) =>
  api.get<SockdriveConversionJob>(`/api/admin/sockdrive-conversions/${encodeURIComponent(id)}`, true)

export const retrySockdriveConversion = (id: string) =>
  trackUploadActivity('重新排队 Sockdrive 转换', () =>
    retryRequest(
      () => api.post<SockdriveConversionJob>(`/api/admin/sockdrive-conversions/${encodeURIComponent(id)}/retry`, undefined, true),
      5,
    ),
  )

export function sockdriveConversionLabel(job: SockdriveConversionJob): string {
  const labels: Record<SockdriveConversionStatus, string> = {
    queued: '等待服务器处理',
    downloading: '服务器正在读取原始 ZIP',
    converting: '正在制作流式磁盘',
    uploading: '正在发布 Sockdrive 分块',
    verifying: '正在公开校验并绑定',
    completed: 'Sockdrive 已完成',
    failed: '转换失败',
  }
  return labels[job.status] || job.status
}

export async function waitForSockdriveConversion(
  id: string,
  onUpdate?: (job: SockdriveConversionJob) => void,
  signal?: AbortSignal,
  onConnectionIssue?: (error: Error, attempt: number, retryInMs: number) => void,
  activityOptions?: UploadActivityOptions,
): Promise<SockdriveConversionJob> {
  return trackUploadActivity('服务器制作并发布 Sockdrive', async () => {
    let failures = 0
    for (;;) {
      if (signal?.aborted) throw new DOMException('页面已离开，后台转换仍会继续', 'AbortError')
      let job: SockdriveConversionJob
      try {
        job = await getSockdriveConversion(id)
        failures = 0
      } catch (error) {
        if (!retryableSockdriveRequestError(error)) throw error
        failures++
        // 后台任务在 MySQL 与独立队列里继续跑；一次 502/断网只代表这次“查询”失败，绝不能改成任务失败。
        const retryInMs = Math.min(15_000, 1_000 * 2 ** Math.min(4, failures - 1))
        onConnectionIssue?.(error instanceof Error ? error : new Error(String(error)), failures, retryInMs)
        await wait(retryInMs, signal)
        continue
      }
      onUpdate?.(job)
      if (job.status === 'completed') return job
      if (job.status === 'failed') throw new Error(job.error || 'Sockdrive 转换失败')
      await wait(1800, signal)
    }
  }, activityOptions)
}
