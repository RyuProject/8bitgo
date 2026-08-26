/**
 * ROM 存储（Cloudflare R2）。
 *
 * 两个地址，各司其职：
 *   - 公开根地址 ROM_BASE：玩家读取 ROM 用，可以是 R2 自定义域名（如 https://assets.8bitgo.com）
 *     或 r2.dev 域名，需要在桶上配置 CORS（允许 GET / HEAD）；也可以直接填 Worker 地址。
 *   - 管理接口 ROM_API：本项目 worker/ 里的 Cloudflare Worker，后台上传 / 删除 / 列表用，需要口令。
 *     留空时退回使用 ROM_BASE（当 ROM_BASE 本身就是 Worker 时）。
 *   S3 API 地址（*.r2.cloudflarestorage.com）需要签名请求，浏览器不能直接用。
 *
 * 对象 key 约定：<前缀>/<platform>/<slug>.<后缀>，前缀默认 roms（对应桶里的 roms/gba、roms/nes …）。
 * 游戏未显式绑定 ROM 时，前台按约定 key 用 HEAD 探测。
 */
import { useEffect, useState } from 'react'
import type { Game } from '@/types'
import { platformMap } from '@/data/platforms'
import { isPlayable } from '@/emulator'
import type { Lang, RomLang } from '@/config/languages'
import { romLangFor } from '@/config/languages'
import { useLang } from '@/services/lang'

export const ROM_BASE_KEY = '8bitgo.rom.base'
export const ROM_API_KEY = '8bitgo.rom.api'
export const ROM_PREFIX_KEY = '8bitgo.rom.prefix'
export const ROM_TOKEN_KEY = '8bitgo.rom.token'

const listeners = new Set<() => void>()

function readLocal(key: string): string {
  try {
    return localStorage.getItem(key) ?? ''
  } catch {
    return ''
  }
}

function writeLocal(key: string, value: string) {
  try {
    if (value.trim()) localStorage.setItem(key, value.trim())
    else localStorage.removeItem(key)
  } catch {
    /* ignore */
  }
}

const trimSlash = (s: string) => s.trim().replace(/\/+$/, '')

/** 公开读取根地址 */
export function getRomBase(): string {
  return trimSlash(readLocal(ROM_BASE_KEY) || import.meta.env.VITE_ROM_BASE_URL || '')
}

/** 管理接口（Worker）地址，留空时退回公开根地址 */
export function getRomApi(): string {
  return trimSlash(readLocal(ROM_API_KEY) || import.meta.env.VITE_ROM_API_URL || '') || getRomBase()
}

/** 对象 key 前缀（不带首尾斜杠），默认 roms */
export function getRomPrefix(): string {
  const raw = readLocal(ROM_PREFIX_KEY) || import.meta.env.VITE_ROM_PREFIX
  const value = raw === undefined || raw === null ? 'roms' : raw
  return value.trim().replace(/^\/+|\/+$/g, '')
}

export function getRomToken(): string {
  try {
    return sessionStorage.getItem(ROM_TOKEN_KEY) ?? ''
  } catch {
    return ''
  }
}

export interface RomConfig {
  base: string
  api: string
  prefix: string
  token: string
}

export function getRomConfig(): RomConfig {
  return { base: getRomBase(), api: getRomApi(), prefix: getRomPrefix(), token: getRomToken() }
}

export function saveRomConfig(cfg: Partial<RomConfig>) {
  if (cfg.base !== undefined) writeLocal(ROM_BASE_KEY, cfg.base)
  if (cfg.api !== undefined) writeLocal(ROM_API_KEY, cfg.api)
  if (cfg.prefix !== undefined) writeLocal(ROM_PREFIX_KEY, cfg.prefix.replace(/^\/+|\/+$/g, ''))
  if (cfg.token !== undefined) {
    try {
      if (cfg.token) sessionStorage.setItem(ROM_TOKEN_KEY, cfg.token)
      else sessionStorage.removeItem(ROM_TOKEN_KEY)
    } catch {
      /* ignore */
    }
  }
  probeCache.clear()
  for (const l of listeners) l()
}

export function subscribeRomConfig(listener: () => void) {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export function isS3ApiUrl(url: string): boolean {
  return /r2\.cloudflarestorage\.com/i.test(url)
}

/** key 的每一段单独编码，保留斜杠 */
export function encodeKey(key: string): string {
  return key
    .replace(/^\/+/, '')
    .split('/')
    .map((seg) => encodeURIComponent(seg))
    .join('/')
}

/** 把对象 key 拼成可公开访问的 URL */
export function romUrlForKey(key: string, base = getRomBase()): string {
  if (/^https?:\/\//i.test(key)) return key
  return base ? `${base}/${encodeKey(key)}` : ''
}

/** 游戏明确绑定了 ROM 时返回其 URL，否则返回空串 */
export function explicitRomUrl(game: Game): string {
  return game.rom ? romUrlForKey(game.rom) : ''
}

/** 约定 key：<前缀>/<platform>/<slug>.<ext>，zip 优先 */
export function conventionalKeys(game: Game): string[] {
  const exts = platformMap[game.platform]?.romExtensions ?? ['.zip']
  const ordered = ['.zip', ...exts.filter((e) => e !== '.zip')]
  const prefix = getRomPrefix()
  return ordered.map((ext) => `${prefix ? `${prefix}/` : ''}${game.platform}/${game.slug}${ext}`)
}

/** 给封面 / 视频生成默认 key：covers/<slug>.<ext> 或 videos/<slug>.<ext> */
export function defaultMediaKey(kind: 'covers' | 'videos', slug: string, fileName: string): string {
  const ext = (fileName.match(/\.[a-z0-9]+$/i)?.[0] ?? '').toLowerCase()
  const name = (slug || fileName.replace(/\.[a-z0-9]+$/i, '')).toLowerCase().replace(/[\s_]+/g, '-')
  return `${kind}/${name}${ext || (kind === 'videos' ? '.mp4' : '.jpg')}`
}

/** 按语言选出该游戏应加载的 ROM key/URL：当前语言 → 英语 → 通用 rom */
export function effectiveRomKey(game: Game, lang: Lang): string {
  const slot = romLangFor(lang)
  return game.roms?.[slot] || game.roms?.en || game.rom || ''
}

/** 给某语言的 ROM 生成默认 key：<前缀>/<platform>/<slug>.<lang>.<ext> */
export function defaultRomKeyForLang(platform: string, slug: string, lang: RomLang, fileName: string): string {
  const ext = (fileName.match(/\.[a-z0-9]+$/i)?.[0] ?? '.zip').toLowerCase()
  const prefix = getRomPrefix()
  const name = slug || fileName.replace(/\.[a-z0-9]+$/i, '').toLowerCase().replace(/[\s_]+/g, '-')
  return `${prefix ? `${prefix}/` : ''}${platform}/${name}.${lang}${ext}`
}

/** 给上传的文件生成默认 key */
export function defaultKeyFor(platform: string, slug: string, fileName: string): string {
  const ext = (fileName.match(/\.[a-z0-9]+$/i)?.[0] ?? '.zip').toLowerCase()
  const prefix = getRomPrefix()
  const name = slug || fileName.replace(/\.[a-z0-9]+$/i, '').toLowerCase().replace(/[\s_]+/g, '-')
  return `${prefix ? `${prefix}/` : ''}${platform}/${name}${ext}`
}

const probeCache = new Map<string, Promise<boolean>>()

/** HEAD 探测某个 URL 是否存在（带超时，结果缓存） */
export function probeUrl(url: string, timeoutMs = 4000): Promise<boolean> {
  const cached = probeCache.get(url)
  if (cached) return cached
  const p = (async () => {
    const ctrl = new AbortController()
    const timer = window.setTimeout(() => ctrl.abort(), timeoutMs)
    try {
      const res = await fetch(url, { method: 'HEAD', signal: ctrl.signal })
      return res.ok
    } catch {
      return false
    } finally {
      window.clearTimeout(timer)
    }
  })()
  probeCache.set(url, p)
  return p
}

export interface RomResolution {
  status: 'idle' | 'checking' | 'found' | 'missing'
  url: string
  key?: string
}

/** 解析某款游戏可直接播放的 ROM 地址：显式绑定 → 立即可用；否则按约定 key 探测 */
export function useRomUrl(game: Game | undefined): RomResolution {
  const lang = useLang()
  const [state, setState] = useState<RomResolution>({ status: 'idle', url: '' })

  useEffect(() => {
    if (!game) return
    // 显式绑定（按语言选出）优先
    const key = effectiveRomKey(game, lang)
    if (key) {
      const url = romUrlForKey(key)
      if (url) {
        setState({ status: 'found', url, key })
        return
      }
    }
    const base = getRomBase()
    if (!base || !isPlayable(game.platform)) {
      setState({ status: 'missing', url: '' })
      return
    }

    let cancelled = false
    setState({ status: 'checking', url: '' })
    ;(async () => {
      for (const key of conventionalKeys(game)) {
        const url = romUrlForKey(key, base)
        if (await probeUrl(url)) {
          if (!cancelled) setState({ status: 'found', url, key })
          return
        }
      }
      if (!cancelled) setState({ status: 'missing', url: '' })
    })()

    return () => {
      cancelled = true
    }
  }, [game, lang])

  return state
}

/* ---------------- Worker 管理接口（后台用） ---------------- */

export interface RomObject {
  key: string
  size: number
  uploaded?: string
}

function authHeaders(): Record<string, string> {
  const token = getRomToken()
  return token ? { Authorization: `Bearer ${token}` } : {}
}

function explainStatus(status: number, what: string): Error {
  if (status === 401 || status === 403) return new Error(`${what}被拒绝：请在「ROM 存储」页填写与 Worker 一致的 ADMIN_TOKEN`)
  if (status === 404 || status === 405) return new Error(`${what}不可用：该地址不是本项目的 Worker，请部署 worker/ 并填写 Worker 地址`)
  if (status === 413) return new Error(`${what}失败：文件超过 Worker 单次请求体上限`)
  return new Error(`${what}失败：HTTP ${status}`)
}

export async function pingRomApi(api = getRomApi()): Promise<{ isWorker: boolean; writable: boolean }> {
  const res = await fetch(`${api}/ping`, { cache: 'no-store' })
  if (!res.ok) return { isWorker: false, writable: false }
  const data = (await res.json().catch(() => null)) as { service?: string; writable?: boolean } | null
  return { isWorker: data?.service === '8bitgo-roms', writable: Boolean(data?.writable) }
}

export async function listRomObjects(prefix = getRomPrefix()): Promise<RomObject[]> {
  const api = getRomApi()
  if (!api) throw new Error('尚未配置 Worker 地址')
  const out: RomObject[] = []
  let cursor = ''
  for (let i = 0; i < 50; i++) {
    const url = new URL(`${api}/list`)
    if (prefix) url.searchParams.set('prefix', prefix.endsWith('/') ? prefix : `${prefix}/`)
    if (cursor) url.searchParams.set('cursor', cursor)
    const res = await fetch(url.toString(), { headers: authHeaders() })
    if (!res.ok) throw explainStatus(res.status, '列表')
    const data = (await res.json()) as { objects?: RomObject[]; cursor?: string; truncated?: boolean }
    out.push(...(data.objects ?? []))
    if (!data.truncated || !data.cursor) break
    cursor = data.cursor
  }
  return out
}

export interface UploadResult {
  key: string
  url: string
  size: number
}

/** 通过 Worker 上传文件到 R2（PUT），带进度回调 */
export function uploadRom(file: File, key: string, onProgress?: (pct: number) => void): Promise<UploadResult> {
  const api = getRomApi()
  if (!api) return Promise.reject(new Error('尚未配置 Worker 地址，无法上传'))
  if (!getRomToken()) return Promise.reject(new Error('请先在「ROM 存储」页填写 Worker 口令（ADMIN_TOKEN）'))
  const cleanKey = key.replace(/^\/+/, '')

  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest()
    xhr.open('PUT', `${api}/${encodeKey(cleanKey)}`)
    xhr.setRequestHeader('Authorization', `Bearer ${getRomToken()}`)
    xhr.setRequestHeader('Content-Type', file.type || 'application/octet-stream')
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable && onProgress) onProgress(Math.round((e.loaded / e.total) * 100))
    }
    xhr.onerror = () => reject(new Error('网络错误：无法连接 Worker（检查地址与 CORS）'))
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        probeCache.clear()
        resolve({ key: cleanKey, url: romUrlForKey(cleanKey), size: file.size })
      } else {
        reject(explainStatus(xhr.status, '上传'))
      }
    }
    xhr.send(file)
  })
}

export async function deleteRom(key: string): Promise<void> {
  const api = getRomApi()
  const res = await fetch(`${api}/${encodeKey(key)}`, { method: 'DELETE', headers: authHeaders() })
  if (!res.ok) throw explainStatus(res.status, '删除')
  probeCache.clear()
}

/** 根据文件名猜测对应的游戏 slug：roms/nes/super-mario-bros.zip -> super-mario-bros */
export function slugFromKey(key: string): string {
  const file = key.split('/').pop() ?? key
  return file
    .replace(/\.(zip|7z|nes|unf|fds|sfc|smc|fig|gba|gbc|gb|z64|n64|v64|md|gen|bin|smd|nds|ws|wsc|cue|iso|img|pbp|chd|exe|com|swf|jar)$/i, '')
    .toLowerCase()
    .replace(/[\s_]+/g, '-')
}

/** 从 key 里推断平台：roms/nes/x.zip -> nes */
export function platformFromKey(key: string): string {
  const parts = key.split('/')
  const prefix = getRomPrefix()
  const idx = prefix && parts[0] === prefix ? 1 : 0
  return parts.length > idx + 1 ? parts[idx] : ''
}
