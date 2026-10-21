/** PS1 ISO → CD CHD：只传任务元数据，大文件仍由浏览器分片直传 R2。 */
import { api, ApiError } from './api'
import type { PspConversionCapability, PspConversionJob } from './pspConversion'
import { pspConversionLabel } from './pspConversion'

const REMEMBER_KEY = '8bitgo.psx.conversions'

function remembered(): Record<string, string> {
  try {
    const data = JSON.parse(localStorage.getItem(REMEMBER_KEY) || '{}')
    return data && typeof data === 'object' && !Array.isArray(data) ? data : {}
  } catch {
    return {}
  }
}

export function rememberPsxConversion(slug: string, lang: string, id: string | null) {
  try {
    const jobs = remembered()
    const key = `${slug}:${lang}`
    if (id) jobs[key] = id
    else delete jobs[key]
    localStorage.setItem(REMEMBER_KEY, JSON.stringify(jobs))
  } catch {
    // 无痕模式不影响服务器任务；已保存的游戏仍会在服务端完成原子绑定。
  }
}

export function rememberedPsxConversion(slug: string, lang: string): string {
  return remembered()[`${slug}:${lang}`] || ''
}

export function psxStagingKey(): string {
  // 旧 Worker 已把 psp-staging 设为私有读；复用这一安全前缀可避免新后端先部署时暴露源 ISO。
  return `psp-staging/${crypto.randomUUID()}.iso`
}

export function psxChdKey(isoKey: string): string {
  return /\.iso$/i.test(isoKey) ? isoKey.replace(/\.iso$/i, '.chd') : `${isoKey}.chd`
}

export const psxConversionCapability = () =>
  api.get<PspConversionCapability>('/api/admin/disc-conversions/capability?platform=psx', true)

export interface CreatePsxConversion {
  sourceKey: string
  targetKey: string
  sourceSize: number
  gameSlug?: string
  lang?: string
  expectedCurrentKey?: string
  overwrite?: boolean
}

export async function createPsxConversion(request: CreatePsxConversion): Promise<PspConversionJob> {
  let last: unknown
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return await api.post<PspConversionJob>('/api/admin/disc-conversions', { ...request, platform: 'psx' }, true)
    } catch (error) {
      last = error
      // 创建任务以 staging key 幂等；只重试可能是网络抖动的失败。
      if (error instanceof ApiError && error.status < 500) throw error
      if (attempt < 2) await new Promise((resolve) => window.setTimeout(resolve, 600 * 2 ** attempt))
    }
  }
  throw last
}

export const getPsxConversion = (id: string) =>
  api.get<PspConversionJob>(`/api/admin/disc-conversions/${encodeURIComponent(id)}`, true)

export async function waitForPsxConversion(
  id: string,
  onUpdate?: (job: PspConversionJob) => void,
  signal?: AbortSignal,
): Promise<PspConversionJob> {
  for (;;) {
    if (signal?.aborted) throw new DOMException('页面已离开，后台转换仍会继续', 'AbortError')
    const job = await getPsxConversion(id)
    if (job.platform !== 'psx') throw new Error('恢复的任务不是 PS1 转换任务')
    onUpdate?.(job)
    if (job.status === 'completed') return job
    if (job.status === 'failed') throw new Error(job.error || 'PS1 ISO 转换失败')
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

export const psxConversionLabel = pspConversionLabel
