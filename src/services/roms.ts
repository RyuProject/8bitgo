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
import { ROM_LANGS, romLangFor } from '@/config/languages'
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

/**
 * 补全根地址的协议头。
 *
 * 填 `assets.8bitgo.com`（少了 https://）时，拼出来的是 `assets.8bitgo.com/roms/...`
 * —— 这是个**相对路径**，fetch 会把它接到当前页面后面，变成
 * `你的域名/admin/assets.8bitgo.com/roms/...`。而这个路径会被 SSR 的兜底路由接住，
 * 返回 200 + 一个 HTML 页面，于是模拟器拿到网页当 ROM 解析，报「不是合法的 ROM」。
 * 状态码是 200，看日志根本看不出问题在哪。
 *
 * 以 / 开头的（同源路径，如 /roms）保持原样。
 */
function withScheme(base: string): string {
  if (!base) return ''
  if (/^https?:\/\//i.test(base)) return base
  // 协议相对写法 //host 要先判：它也以 / 开头，放在下面那条后面就永远轮不到。
  // SSR 时没有 location 可参照，必须补成绝对地址。
  if (base.startsWith('//')) return `https:${base}`
  // 以单个 / 开头的是同源路径（如 /roms），保持原样
  if (base.startsWith('/')) return base
  return `https://${base}`
}

/** 公开读取根地址 */
export function getRomBase(): string {
  return withScheme(trimSlash(readLocal(ROM_BASE_KEY) || import.meta.env.VITE_ROM_BASE_URL || ''))
}

/** 管理接口（Worker）地址，留空时退回公开根地址 */
export function getRomApi(): string {
  return withScheme(trimSlash(readLocal(ROM_API_KEY) || import.meta.env.VITE_ROM_API_URL || '')) || getRomBase()
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
  // 存的时候就把协议头补齐，后台输入框里显示的就是最终生效的地址，
  // 免得填了 assets.8bitgo.com 之后看着没问题、实际被当成相对路径
  if (cfg.base !== undefined) writeLocal(ROM_BASE_KEY, cfg.base ? withScheme(trimSlash(cfg.base)) : '')
  if (cfg.api !== undefined) writeLocal(ROM_API_KEY, cfg.api ? withScheme(trimSlash(cfg.api)) : '')
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

/**
 * 把对象 key 拼成可公开访问的 URL。
 *
 * 认三种写法：
 *   1. 完整 URL（http/https）—— 原样返回
 *   2. 以 `/` 开头 —— 当成站点自己的路径原样返回（例如 BIOS 放在 public/bios/ 里，
 *      填 `/bios/neogeo.zip`）。对象 key 本身不会以 `/` 开头（上传时 encodeKey 就把
 *      前导斜杠剥掉了），所以这条不会和真的 key 撞上。
 *   3. 其余 —— 当成对象存储的 key，拼上公开访问地址；没配地址时返回空串
 */
export function romUrlForKey(key: string, base = getRomBase()): string {
  if (/^https?:\/\//i.test(key)) return key
  if (key.startsWith('/')) return key
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

/**
 * 这款游戏一共绑定了哪些对象 key（通用 rom + 各语言 roms，去重）。
 *
 * 编辑弹窗里现在只填「按语言的 ROM」（roms），但后台列表 / 概览 / ROM 存储页
 * 过去都只看 game.rom 那一个字段 —— 只配了 roms.en 的游戏在后台一律显示「未绑定」，
 * 「自动匹配」会重复绑一次，删文件时也不会解绑。统一从这里取。
 */
export function romKeysOf(game: Pick<Game, 'rom' | 'roms'>): string[] {
  const keys = [game.rom, ...Object.values(game.roms ?? {})]
    .map((k) => (typeof k === 'string' ? k.trim() : ''))
    .filter(Boolean)
  return [...new Set(keys)]
}

/** 这款游戏是否已经绑定了任意一个 ROM */
export function hasRom(game: Pick<Game, 'rom' | 'roms'>): boolean {
  return romKeysOf(game).length > 0
}

/** 把某个对象 key 从游戏上解绑（通用 rom 与所有语言槽都清掉），返回要提交的补丁 */
export function unbindKeyPatch(game: Pick<Game, 'rom' | 'roms'>, key: string): Partial<Game> {
  const patch: Partial<Game> = {}
  if (game.rom === key) patch.rom = undefined
  const roms = { ...(game.roms ?? {}) }
  let touched = false
  for (const [lang, value] of Object.entries(roms)) {
    if (value === key) {
      delete roms[lang as RomLang]
      touched = true
    }
  }
  if (touched) patch.roms = Object.keys(roms).length ? roms : undefined
  return patch
}

/**
 * 这款游戏到底绑了哪几种语言的 ROM（按 ROM_LANGS 的顺序，只算真的填了 key 的）。
 * 播放器用它决定要不要显示「切换 ROM 语言」——只有一种语言时没什么可切的。
 */
export function romLangsOf(game: Pick<Game, 'roms'>): RomLang[] {
  const roms = game.roms ?? {}
  return ROM_LANGS.filter((l) => typeof roms[l] === 'string' && roms[l].trim() !== '')
}

/** 某个 key 属于哪个语言槽；不属于任何语言槽（通用 rom / 约定 key）时返回 undefined */
export function romLangOfKey(game: Pick<Game, 'roms'>, key: string): RomLang | undefined {
  if (!key) return undefined
  return ROM_LANGS.find((l) => game.roms?.[l] === key)
}

/**
 * 按语言选出该游戏应加载的 ROM key/URL：当前语言 → 英语 → 通用 rom。
 *
 * prefer 是玩家在播放器里手动选的语言，优先级最高 —— 那个下拉框里本来就只列
 * 确实存在的语言，所以命中不了就说明数据变了，照常走后面的回退。
 */
export function effectiveRomKey(game: Game, lang: Lang, prefer?: RomLang | null): string {
  if (prefer && game.roms?.[prefer]) return game.roms[prefer]
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
      if (!res.ok) return false
      // 地址配错时请求会落到本站的 SSR 兜底路由上，那边对任何路径都回 200 + HTML。
      // 只看 res.ok 的话会误判成「ROM 存在」，页面显示「即点即玩」，
      // 点下去才在模拟器里报一句莫名其妙的「不是合法的 ROM」。
      const type = res.headers.get('content-type') || ''
      if (/text\/html|application\/xhtml/i.test(type)) return false
      return true
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
  /** 用的是哪个语言槽。通用 rom 和约定 key 探测出来的没有语言，为 undefined */
  lang?: RomLang
}

/**
 * 解析某款游戏可直接播放的 ROM 地址：显式绑定 → 立即可用；否则按约定 key 探测。
 *
 * prefer：玩家在播放器工具栏里手动选的 ROM 语言，不传就跟着站点语言走。
 */
export function useRomUrl(game: Game | undefined, prefer?: RomLang | null): RomResolution {
  const lang = useLang()
  const [state, setState] = useState<RomResolution>({ status: 'idle', url: '' })

  useEffect(() => {
    if (!game) return
    // 显式绑定（按语言选出）优先
    const key = effectiveRomKey(game, lang, prefer)
    if (key) {
      const url = romUrlForKey(key)
      if (url) {
        setState({ status: 'found', url, key, lang: romLangOfKey(game, key) })
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
  }, [game, lang, prefer])

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

export interface RomHead {
  exists: boolean
  /** 字节数。跨域也读得到 —— Worker 的 Access-Control-Expose-Headers 里有 Content-Length */
  size?: number
  /** R2 单段上传时 ETag 就是内容的 MD5（带引号），可用来粗判是不是同一份文件 */
  etag?: string
}

/**
 * 探一下某个 key 上是不是已经有文件了，以及它多大。
 *
 * 用途是上传前的重复检查：同一个游戏的同一个语言槽（或同一张封面）只该有一份文件，
 * 直接 PUT 会静默覆盖，管理员根本不知道自己盖掉了什么。
 *
 * Worker 的 GET/HEAD 不需要口令（ROM 桶本来就是公开读），带上 Authorization 也无妨。
 * 探测失败一律当作「不存在」——它只是个提示，不该把上传本身拦下来。
 */
export async function headRom(key: string): Promise<RomHead> {
  const api = getRomApi()
  const clean = key.replace(/^\/+/, '')
  if (!api || !clean) return { exists: false }
  const res = await fetch(`${api}/${encodeKey(clean)}`, { method: 'HEAD', headers: authHeaders(), cache: 'no-store' })
  if (!res.ok) return { exists: false }
  const len = Number(res.headers.get('content-length'))
  return {
    exists: true,
    size: Number.isFinite(len) && len >= 0 ? len : undefined,
    etag: res.headers.get('etag') ?? undefined,
  }
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
