/** PSP ISO → CHD 后台任务客户端。文件上传仍复用 romMultipart，这里只管理任务状态。 */
import { api, ApiError } from './api'

export type PspConversionStatus =
  | 'queued'
  | 'downloading'
  | 'converting'
  | 'verifying'
  | 'uploading'
  | 'completed'
  | 'failed'

export interface PspConversionCapability {
  available: boolean
  reason: string
  maxIsoBytes: number
  format: string
}

export interface PspConversionJob {
  id: string
  sourceKey: string
  targetKey: string
  status: PspConversionStatus
  progress: number
  sourceSize: number
  outputSize: number | null
  gameSlug: string | null
  lang: string | null
  bound: boolean
  message: string
  error: string
  createdAt?: string
  updatedAt?: string
  completedAt?: string | null
}

export interface CreatePspConversion {
  sourceKey: string
  targetKey: string
  sourceSize: number
  gameSlug?: string
  lang?: string
  expectedCurrentKey?: string
  overwrite?: boolean
}

const REMEMBER_KEY = '8bitgo.psp.conversions'

function remembered(): Record<string, string> {
  try {
    const value = JSON.parse(localStorage.getItem(REMEMBER_KEY) || '{}')
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {}
  } catch {
    return {}
  }
}

function identity(slug: string, lang: string) {
  return `${slug}:${lang}`
}

export function rememberPspConversion(slug: string, lang: string, id: string | null) {
  try {
    const jobs = remembered()
    const key = identity(slug, lang)
    if (id) jobs[key] = id
    else delete jobs[key]
    localStorage.setItem(REMEMBER_KEY, JSON.stringify(jobs))
  } catch {
    /* 无痕模式不影响转换本身；已有游戏仍由服务端原子绑定。 */
  }
}

export function rememberedPspConversion(slug: string, lang: string): string {
  return remembered()[identity(slug, lang)] || ''
}

export function pspStagingKey(): string {
  const id = globalThis.crypto?.randomUUID?.() || `${Date.now().toString(16)}-${Math.random().toString(16).slice(2)}`
  return `psp-staging/${id}.iso`
}

export function pspChdKey(isoKey: string): string {
  // 当前槽可能原来绑的是 CSO/CHD；选了 ISO 后不能把 ISO 字节继续写进 .cso 这个旧名字。
  return /\.[^./]+$/.test(isoKey) ? isoKey.replace(/\.[^./]+$/, '.chd') : `${isoKey}.chd`
}

export const pspConversionCapability = () =>
  api.get<PspConversionCapability>('/api/admin/psp-conversions/capability', true)

export async function createPspConversion(request: CreatePspConversion): Promise<PspConversionJob> {
  let last: unknown
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return await api.post<PspConversionJob>('/api/admin/psp-conversions', request, true)
    } catch (error) {
      last = error
      // sourceKey 在服务端是唯一幂等键；只重试网络错误和 5xx，明确的 4xx 必须交给管理员处理。
      if (error instanceof ApiError && error.status < 500) throw error
      if (attempt < 2) await new Promise((resolve) => window.setTimeout(resolve, 600 * 2 ** attempt))
    }
  }
  throw last
}

export const getPspConversion = (id: string) =>
  api.get<PspConversionJob>(`/api/admin/psp-conversions/${encodeURIComponent(id)}`, true)

export const retryPspConversion = (id: string) =>
  api.post<PspConversionJob>(`/api/admin/psp-conversions/${encodeURIComponent(id)}/retry`, undefined, true)

export function pspConversionLabel(job: PspConversionJob): string {
  const labels: Record<PspConversionStatus, string> = {
    queued: '等待服务器处理',
    downloading: '服务器正在读取 ISO',
    converting: '正在压缩为 CHD',
    verifying: '正在完整校验 CHD',
    uploading: '正在发布最终 CHD',
    completed: 'CHD 已完成',
    failed: '转换失败',
  }
  return labels[job.status] || job.status
}

/**
 * 轮询只负责等状态；关闭标签页不会取消服务器任务。AbortSignal 只停止当前页面继续问。
 */
export async function waitForPspConversion(
  id: string,
  onUpdate?: (job: PspConversionJob) => void,
  signal?: AbortSignal,
): Promise<PspConversionJob> {
  for (;;) {
    if (signal?.aborted) throw new DOMException('页面已离开，后台转换仍会继续', 'AbortError')
    const job = await getPspConversion(id)
    onUpdate?.(job)
    if (job.status === 'completed') return job
    if (job.status === 'failed') throw new Error(job.error || 'PSP ISO 转换失败')
    await new Promise<void>((resolve, reject) => {
      const onAbort = () => {
        window.clearTimeout(timer)
        reject(new DOMException('页面已离开，后台转换仍会继续', 'AbortError'))
      }
      const timer = window.setTimeout(() => {
        signal?.removeEventListener('abort', onAbort)
        resolve()
      }, 1500)
      signal?.addEventListener('abort', onAbort, { once: true })
    })
  }
}
