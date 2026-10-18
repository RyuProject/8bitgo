/** Windows ZIP → Sockdrive 后台任务客户端；原始文件继续复用 ROM multipart 上传。 */
import { api, ApiError } from './api'

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

function remembered(): Record<string, string> {
  try {
    const value = JSON.parse(localStorage.getItem(REMEMBER_KEY) || '{}')
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {}
  } catch { return {} }
}

const rememberId = (slug: string, lang?: string) => lang ? `${slug}:${lang}` : slug

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
}

export function rememberedSockdriveConversion(slug: string, lang?: string): string {
  return remembered()[rememberId(slug, lang)] || ''
}

export function sockdriveStagingKey(): string {
  const id = globalThis.crypto?.randomUUID?.() || `${Date.now().toString(16)}-${Math.random().toString(16).slice(2)}`
  return `sockdrive-staging/${id}.zip`
}

/** 时间版本不可复用，能同时避免 OPFS 混盘和两个管理员任务撞到同一目标目录。 */
export function nextSockdriveVersion(now = new Date()): string {
  return `v${now.getTime()}`
}

export const sockdriveConversionCapability = () =>
  api.get<SockdriveConversionCapability>('/api/admin/sockdrive-conversions/capability', true)

export async function createSockdriveConversion(request: CreateSockdriveConversion): Promise<SockdriveConversionJob> {
  let last: unknown
  for (let attempt = 0; attempt < 3; attempt++) {
    try { return await api.post<SockdriveConversionJob>('/api/admin/sockdrive-conversions', request, true) }
    catch (error) {
      last = error
      // sourceKey 是幂等键；只重试网络错误与 5xx，明确的参数/冲突错误交给管理员处理。
      if (error instanceof ApiError && error.status < 500) throw error
      if (attempt < 2) await new Promise((resolve) => window.setTimeout(resolve, 600 * 2 ** attempt))
    }
  }
  throw last
}

export const getSockdriveConversion = (id: string) =>
  api.get<SockdriveConversionJob>(`/api/admin/sockdrive-conversions/${encodeURIComponent(id)}`, true)

export const retrySockdriveConversion = (id: string) =>
  api.post<SockdriveConversionJob>(`/api/admin/sockdrive-conversions/${encodeURIComponent(id)}/retry`, undefined, true)

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
): Promise<SockdriveConversionJob> {
  for (;;) {
    if (signal?.aborted) throw new DOMException('页面已离开，后台转换仍会继续', 'AbortError')
    const job = await getSockdriveConversion(id)
    onUpdate?.(job)
    if (job.status === 'completed') return job
    if (job.status === 'failed') throw new Error(job.error || 'Sockdrive 转换失败')
    await new Promise<void>((resolve, reject) => {
      const onAbort = () => { window.clearTimeout(timer); reject(new DOMException('页面已离开，后台转换仍会继续', 'AbortError')) }
      const timer = window.setTimeout(() => { signal?.removeEventListener('abort', onAbort); resolve() }, 1800)
      signal?.addEventListener('abort', onAbort, { once: true })
    })
  }
}
