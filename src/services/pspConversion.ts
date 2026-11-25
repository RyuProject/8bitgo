/** PSP ISO → CHD 后台任务客户端。文件上传仍复用 romMultipart，这里只管理任务状态。 */
import { api, ApiError } from './api'
import { waitForConversionJob } from './conversionPoll.js'
import { trackUploadActivity } from './uploadActivity'
import { fingerprintRomUploadFile } from './romFingerprint'

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
  platform?: 'psp' | 'psx'
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
  platform?: 'psp' | 'psx'
  sourceKey: string
  targetKey: string
  sourceSize: number
  gameSlug?: string
  lang?: string
  expectedCurrentKey?: string
  overwrite?: boolean
}

const REMEMBER_KEY = '8bitgo.psp.conversions'
const PENDING_CREATE_KEY = '8bitgo.disc.conversion.pending'
const STAGING_KEY = '8bitgo.disc.conversion.staging'
const DISC_UPLOAD_TTL = 7 * 24 * 60 * 60 * 1000

type DiscPlatform = 'psp' | 'psx'

interface DiscStagingEntry {
  platform: DiscPlatform
  slot: string
  targetKey: string
  fileName: string
  fileSize: number
  lastModified: number
  fileFingerprint: string
  key: string
  savedAt: number
}

interface PendingDiscCreation {
  platform: DiscPlatform
  slug: string
  lang: string
  request: CreatePspConversion
  savedAt: number
}

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

export async function pspStagingKey(file?: File, slug = '', lang = '', targetKey = ''): Promise<string> {
  if (file) return discStagingKey('psp', file, slug, lang, targetKey)
  const id = globalThis.crypto?.randomUUID?.() || `${Date.now().toString(16)}-${Math.random().toString(16).slice(2)}`
  return `psp-staging/${id}.iso`
}

function discSlot(platform: DiscPlatform, slug: string, lang: string): string {
  return `${platform}:${slug}:${lang}`
}

function readDiscStaging(): Record<string, DiscStagingEntry> {
  try {
    const value = JSON.parse(localStorage.getItem(STAGING_KEY) || '{}')
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {}
  } catch {
    return {}
  }
}

function writeDiscStaging(value: Record<string, DiscStagingEntry>) {
  try {
    const cutoff = Date.now() - DISC_UPLOAD_TTL
    const entries = Object.entries(value)
      .filter(([, item]) => item && Number(item.savedAt) >= cutoff)
      .sort((a, b) => Number(b[1].savedAt) - Number(a[1].savedAt))
      .slice(0, 40)
    localStorage.setItem(STAGING_KEY, JSON.stringify(Object.fromEntries(entries)))
  } catch {
    // 本地账本只用于失败后续传；无痕模式仍可正常上传，只是需要从头开始。
  }
}

/** 同一槽位重选同一 ISO 时复用 staging key，让 romMultipart 能接着上次未完成的分片上传。 */
export async function discStagingKey(
  platform: DiscPlatform,
  file: File,
  slug: string,
  lang: string,
  targetKey: string,
): Promise<string> {
  const fileFingerprint = await fingerprintRomUploadFile(file)
  const createKey = () => globalThis.crypto?.randomUUID?.() || `${Date.now().toString(16)}-${Math.random().toString(16).slice(2)}`
  // 无法读取摘要时仍正常上传，但不根据弱元数据复用旧 key，以免复用已完成任务的结果。
  if (!fileFingerprint) return `psp-staging/${createKey()}.iso`
  const slot = discSlot(platform, slug, lang)
  const entries = readDiscStaging()
  const previous = entries[slot]
  if (
    previous?.platform === platform && previous.slot === slot && previous.targetKey === targetKey &&
    previous.fileName === file.name && previous.fileSize === file.size && previous.lastModified === file.lastModified &&
    previous.fileFingerprint === fileFingerprint &&
    Date.now() - Number(previous.savedAt) < DISC_UPLOAD_TTL &&
    /^psp-staging\/[a-f0-9-]{16,}\.iso$/i.test(previous.key)
  ) return previous.key

  const key = `psp-staging/${createKey()}.iso`
  entries[slot] = {
    platform, slot, targetKey, fileName: file.name, fileSize: file.size,
    lastModified: file.lastModified, fileFingerprint, key, savedAt: Date.now(),
  }
  writeDiscStaging(entries)
  return key
}

export function clearDiscStagingKey(platform: DiscPlatform, slug: string, lang: string, key: string) {
  const slot = discSlot(platform, slug, lang)
  const entries = readDiscStaging()
  if (entries[slot]?.key !== key) return
  delete entries[slot]
  writeDiscStaging(entries)
}

function readPendingDiscCreations(): Record<string, PendingDiscCreation> {
  try {
    const value = JSON.parse(localStorage.getItem(PENDING_CREATE_KEY) || '{}')
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {}
  } catch {
    return {}
  }
}

function writePendingDiscCreations(value: Record<string, PendingDiscCreation>) {
  try {
    const cutoff = Date.now() - DISC_UPLOAD_TTL
    const entries = Object.entries(value)
      .filter(([, item]) => item && Number(item.savedAt) >= cutoff)
      .sort((a, b) => Number(b[1].savedAt) - Number(a[1].savedAt))
      .slice(0, 40)
    localStorage.setItem(PENDING_CREATE_KEY, JSON.stringify(Object.fromEntries(entries)))
  } catch {
    // 服务端任务本身仍会运行；这份小账本只恢复管理员页面，不承载任务状态。
  }
}

/** 上传完成后先保存原样建任务请求；响应丢失或刷新时重发同一 sourceKey 会命中服务端幂等记录。 */
export function rememberPendingDiscConversion(
  platform: DiscPlatform,
  slug: string,
  lang: string,
  request: CreatePspConversion,
) {
  const entries = readPendingDiscCreations()
  const slot = discSlot(platform, slug, lang)
  entries[slot] = { platform, slug, lang, request: { ...request, platform }, savedAt: Date.now() }
  writePendingDiscCreations(entries)
}

export function rememberedPendingDiscConversion(
  platform: DiscPlatform,
  slug: string,
  lang: string,
): CreatePspConversion | null {
  const slot = discSlot(platform, slug, lang)
  const entry = readPendingDiscCreations()[slot]
  if (!entry || entry.platform !== platform || entry.slug !== slug || entry.lang !== lang ||
      !Number.isFinite(Number(entry.savedAt)) || Date.now() - Number(entry.savedAt) >= DISC_UPLOAD_TTL || entry.request?.platform !== platform ||
      !/^psp-staging\/[a-f0-9-]{16,}\.iso$/i.test(entry.request.sourceKey || '')) return null
  return entry.request
}

export function clearPendingDiscConversion(platform: DiscPlatform, slug: string, lang: string) {
  const entries = readPendingDiscCreations()
  delete entries[discSlot(platform, slug, lang)]
  writePendingDiscCreations(entries)
}

export function pspChdKey(isoKey: string): string {
  // 当前槽可能原来绑的是 CSO/CHD；选了 ISO 后不能把 ISO 字节继续写进 .cso 这个旧名字。
  return /\.[^./]+$/.test(isoKey) ? isoKey.replace(/\.[^./]+$/, '.chd') : `${isoKey}.chd`
}

export const pspConversionCapability = () =>
  api.get<PspConversionCapability>('/api/admin/psp-conversions/capability', true)

export async function createPspConversion(request: CreatePspConversion): Promise<PspConversionJob> {
  return trackUploadActivity('创建 PSP 转码任务', async () => {
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
  })
}

export const getPspConversion = (id: string, signal?: AbortSignal) =>
  api.get<PspConversionJob>(`/api/admin/psp-conversions/${encodeURIComponent(id)}`, true, signal)

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
  return waitForConversionJob(() => getPspConversion(id, signal), {
    signal,
    onUpdate,
    isCompleted: (job) => job.status === 'completed',
    isFailed: (job) => job.status === 'failed',
    failureMessage: (job) => job.error || 'PSP ISO 转换失败',
  })
}
