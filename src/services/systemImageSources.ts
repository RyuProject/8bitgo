import { api } from './api'

export type DosSystemImage = { file: string; label: string }

export type ConfiguredSystemMirror = {
  id: string
  label: string
  url: string
  enabled: boolean
  verifiedSha256: string
}

export type SystemImageFileSettings = {
  sha256: string
  r2Version: string
  mirrors: ConfiguredSystemMirror[]
}

export type AdminSystemImageSettings = {
  version: 1
  files: Record<string, SystemImageFileSettings>
}

export type PublicSystemImageSettings = {
  version: 1
  files: Record<string, { sha256: string; r2Version: string; mirrors: Array<{ id: string; label: string; url: string; sha256: string }> }>
}

const SHA256_RE = /^[a-f0-9]{64}$/i
const RANGE_BYTES = 64 * 1024
const VERIFY_MAX_BYTES = 120 * 1024 * 1024

export function fetchPublicSystemImageSettings(signal?: AbortSignal): Promise<PublicSystemImageSettings> {
  return api.get('/api/system-image-sources', false, signal)
}

export function fetchAdminSystemImageSettings(): Promise<AdminSystemImageSettings> {
  return api.get('/api/admin/system-image-sources', true)
}

export function saveAdminSystemImageSettings(settings: AdminSystemImageSettings): Promise<AdminSystemImageSettings> {
  return api.put('/api/admin/system-image-sources', settings, true)
}

export type SystemMirrorProbe = { elapsedMs: number; bytes: number; mbps: number }

/** 用真实跨域 GET + Range 测玩家浏览器能否读到该镜像的首块数据。 */
export async function probeSystemImageMirror(url: string, timeoutMs = 4000): Promise<SystemMirrorProbe> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  const started = performance.now()
  try {
    const response = await fetch(url, {
      method: 'GET',
      mode: 'cors',
      credentials: 'omit',
      cache: 'no-store',
      headers: { Range: `bytes=0-${RANGE_BYTES - 1}` },
      signal: controller.signal,
    })
    const range = response.headers.get('content-range') ?? ''
    const match = /^bytes 0-(\d+)\/(\d+)$/i.exec(range)
    if (response.status !== 206 || (range && (!match || Number(match[2]) <= Number(match[1])))) {
      await response.body?.cancel().catch(() => {})
      throw new Error('服务器未返回可读取的 206 分段响应（可能是 CORS 或 Range 不支持）')
    }
    const advertisedBytes = match ? Number(match[1]) + 1 : null
    const reader = response.body?.getReader()
    if (!reader) throw new Error('响应没有可读取的数据流')
    let bytes = 0
    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        bytes += value.byteLength
        if (bytes > RANGE_BYTES) {
          await reader.cancel().catch(() => {})
          throw new Error('服务器返回的探测速率数据超过 64 KB')
        }
      }
    } finally {
      reader.releaseLock()
    }
    if ((advertisedBytes !== null && bytes !== advertisedBytes) || bytes < 1) throw new Error('Range 响应长度不完整')
    const elapsedMs = Math.max(1, performance.now() - started)
    return { elapsedMs, bytes, mbps: (bytes * 8) / elapsedMs / 1000 }
  } finally {
    clearTimeout(timer)
  }
}

async function readCapped(response: Response, label: string): Promise<ArrayBuffer> {
  if (!response.ok) throw new Error(`${label} 返回 HTTP ${response.status}`)
  const declared = Number(response.headers.get('content-length') || 0)
  if (declared > VERIFY_MAX_BYTES) throw new Error(`${label} 超过 120 MB 校验上限`)
  const reader = response.body?.getReader()
  if (!reader) throw new Error(`${label} 没有可读取的数据流`)
  const chunks: Uint8Array[] = []
  let length = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      length += value.byteLength
      if (length > VERIFY_MAX_BYTES) {
        await reader.cancel().catch(() => {})
        throw new Error(`${label} 超过 120 MB 校验上限`)
      }
      chunks.push(value)
    }
  } finally {
    reader.releaseLock()
  }
  if (length < 1024 * 1024) throw new Error(`${label} 内容过小，不像系统镜像`)
  const combined = new Uint8Array(length)
  let offset = 0
  for (const chunk of chunks) {
    combined.set(chunk, offset)
    offset += chunk.byteLength
  }
  if (combined[0] !== 0x50 || combined[1] !== 0x4b) throw new Error(`${label} 不是 ZIP / js-dos 镜像文件`)
  return combined.buffer
}

async function digestHex(data: ArrayBuffer): Promise<string> {
  if (!globalThis.crypto?.subtle) throw new Error('当前浏览器不支持 SHA-256 校验，请使用 HTTPS 下的现代浏览器')
  const digest = await crypto.subtle.digest('SHA-256', data)
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')
}

/**
 * 管理员主动触发的完整性检查：顺序读取 R2 同源对象与候选外链，避免同时占用两份镜像内存。
 * 只有两份完整字节 SHA-256 相同，外链才会写入公开配置。
 */
export async function verifySystemImageMirror(file: string, url: string): Promise<{ sha256: string; r2Version: string; bytes: number }> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 180_000)
  try {
    const canonicalResponse = await fetch(`/system-images/${encodeURIComponent(file)}`, {
      cache: 'no-store',
      credentials: 'same-origin',
      signal: controller.signal,
    })
    const versionHeader = canonicalResponse.headers.get('etag') || canonicalResponse.headers.get('last-modified')
    const r2Version = versionHeader?.replace(/^W\//, '').replace(/"/g, '').trim() ?? ''
    if (!r2Version) throw new Error('R2 原件没有可读取的 ETag / Last-Modified，无法识别后续版本变化')
    let canonical: ArrayBuffer | null = await readCapped(canonicalResponse, 'R2 原件')
    const sha256 = await digestHex(canonical)
    const bytes = canonical.byteLength
    canonical = null

    const mirrorResponse = await fetch(url, {
      mode: 'cors',
      credentials: 'omit',
      cache: 'no-store',
      signal: controller.signal,
    })
    const mirror = await readCapped(mirrorResponse, '候选镜像')
    const mirrorSha256 = await digestHex(mirror)
    if (mirrorSha256 !== sha256) throw new Error('候选镜像与 R2 原件的 SHA-256 不一致，未启用该地址')
    if (!SHA256_RE.test(sha256)) throw new Error('无法生成有效的 R2 原件指纹')
    return { sha256, r2Version, bytes }
  } catch (error) {
    if (controller.signal.aborted) throw new Error('完整校验超时（3 分钟）')
    throw error
  } finally {
    clearTimeout(timer)
  }
}
