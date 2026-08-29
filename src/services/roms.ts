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
  const prefix = getRomPrefix()
  const at = (name: string) => `${prefix ? `${prefix}/` : ''}${game.platform}/${name}`
  /**
   * Flash 单独一条路：
   *   1. 不探 <slug>.zip —— Ruffle 不认 zip，探到了只会让详情页显示一个点不动的「开始游戏」
   *   2. 补上多 SWF 包的约定 <slug>/root.swf（见 lib/swfBundle.ts）
   */
  if (game.platform === 'flash') return [at(`${game.slug}.swf`), at(`${game.slug}/root.swf`)]
  const exts = platformMap[game.platform]?.romExtensions ?? ['.zip']
  const ordered = ['.zip', ...exts.filter((e) => e !== '.zip')]
  return ordered.map((ext) => at(`${game.slug}${ext}`))
}

/* ---------------- 多文件 ROM（Flash 多 SWF 包） ---------------- */

/**
 * 多文件包的存放目录：<前缀>/<platform>/<slug>[.<lang>]
 *
 * 和单文件 ROM 是同一套约定，只是把「<slug>.swf 这个对象」换成「<slug>/ 这个目录」；
 * 按语言分槽时同样带语言后缀，各语言各一个目录，互不覆盖。
 */
export function bundleDirFor(platform: string, slug: string, lang?: RomLang): string {
  const prefix = getRomPrefix()
  const name = lang ? `${slug}.${lang}` : slug
  return `${prefix ? `${prefix}/` : ''}${platform}/${name}`
}

/** key 所在的目录，没有目录就返回空串 */
export function dirOfKey(key: string): string {
  const i = key.lastIndexOf('/')
  return i < 0 ? '' : key.slice(0, i)
}

/**
 * 这个 key 是不是躺在多文件包目录里。
 * 单文件 ROM 是 <前缀>/<平台>/<文件>；多出一层，就说明它属于某个包。
 */
export function isBundleKey(key: string): boolean {
  if (/^https?:/i.test(key) || key.startsWith('/')) return false
  const parts = key.split('/').filter(Boolean)
  const prefix = getRomPrefix()
  const i = prefix && parts[0] === prefix ? 1 : 0
  return parts.length >= i + 3
}

/** 列出某个目录下的全部对象 */
export function listRomDir(dir: string): Promise<RomObject[]> {
  return listRomObjects(dir.replace(/\/+$/, ''))
}

/**
 * 删掉整个包目录（keep 里的 key 保留），返回真正删掉的 key。
 * 逐个串行删：Worker 那边一个 key 一个请求，几十个并发打过去没有意义。
 */
export async function deleteRomDir(dir: string, keep: string[] = []): Promise<string[]> {
  const removed: string[] = []
  for (const o of await listRomDir(dir)) {
    if (keep.includes(o.key)) continue
    await deleteRom(o.key)
    removed.push(o.key)
  }
  return removed
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

/**
 * 这些平台的**文件名本身就是标识**，重命名等于换了一个游戏。
 *
 * 街机（MAME / FBNeo）不看文件内容，它拿压缩包的基本名去查内置的 romset 表：
 * `kof97.zip` 认识，`the-king-of-fighters-97.en.zip` 不认识，直接报
 * 「Romset is unknown」—— 连 zip 都不会打开。
 *
 * 播放器把云端 ROM 的 URL 原样交给核心，所以**对象 key 的最后一段就是核心看到的文件名**。
 * 这类平台的默认 key 必须保留上传时的原文件名，不能套 <slug> 那套约定。
 */
const FILENAME_IS_IDENTITY = new Set(['arcade'])

/** 这个平台的 ROM 是不是靠文件名认身份 */
export function keepsOriginalFileName(platform: string): boolean {
  return FILENAME_IS_IDENTITY.has(platform)
}

/**
 * 把文件名清理成能安全放进对象 key 的形式：小写，只留字母数字和 . _ -
 *
 * 注意这只是「保住一个正确的名字」，救不了本来就错的名字 ——
 * `The King of Fighters 97 (NGH-2320).zip` 清理完还是不叫 kof97，FBNeo 照样不认。
 * 正确的 romset 名（kof97、mslug3、sfa3…）本来就全是小写字母数字，清理不会动它们。
 */
export function safeFileName(fileName: string): string {
  return fileName.trim().toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '')
}

/**
 * 给某语言的 ROM 生成默认 key：<前缀>/<platform>/<slug>.<lang>.<ext>
 *
 * 街机例外：保留原文件名、也不加语言后缀 —— Neo Geo 的地区版本本来就是不同的
 * romset（kof97 / kof97h / kof97k…），各自有各自的名字，语言后缀反而会把名字弄坏。
 */
export function defaultRomKeyForLang(platform: string, slug: string, lang: RomLang, fileName: string): string {
  const prefix = getRomPrefix()
  const at = (name: string) => `${prefix ? `${prefix}/` : ''}${platform}/${name}`
  if (keepsOriginalFileName(platform)) return at(safeFileName(fileName))
  const ext = (fileName.match(/\.[a-z0-9]+$/i)?.[0] ?? '.zip').toLowerCase()
  const name = slug || fileName.replace(/\.[a-z0-9]+$/i, '').toLowerCase().replace(/[\s_]+/g, '-')
  return at(`${name}.${lang}${ext}`)
}

/** 给上传的文件生成默认 key。街机同样保留原文件名，理由见 FILENAME_IS_IDENTITY */
export function defaultKeyFor(platform: string, slug: string, fileName: string): string {
  const prefix = getRomPrefix()
  const at = (name: string) => `${prefix ? `${prefix}/` : ''}${platform}/${name}`
  if (keepsOriginalFileName(platform)) return at(safeFileName(fileName))
  const ext = (fileName.match(/\.[a-z0-9]+$/i)?.[0] ?? '.zip').toLowerCase()
  const name = slug || fileName.replace(/\.[a-z0-9]+$/i, '').toLowerCase().replace(/[\s_]+/g, '-')
  return at(`${name}${ext}`)
}

const probeCache = new Map<string, Promise<string>>()

/**
 * 把对象的 ETag 写进查询串，给浏览器 HTTP 缓存和 EmulatorJS IndexedDB 缓存换 key。
 *
 * R2 允许覆盖同一个对象 key；若播放地址永远不变，两个缓存都会继续交出旧 ROM。
 * ETag 随对象内容变化，既不会让没更新的 ROM 重复下载，也不依赖人工清缓存。
 */
function versionedRomUrl(url: string, etag: string | null): string {
  const version = etag?.replace(/^W\//, '').replaceAll('"', '').trim()
  if (!version) return url
  const separator = url.includes('?') ? '&' : '?'
  return `${url}${separator}romv=${encodeURIComponent(version)}`
}

/** HEAD 探测 ROM，并把内容 ETag 带回播放 URL（带超时，结果缓存） */
export function probeRomUrl(url: string, timeoutMs = 4000): Promise<string> {
  const cached = probeCache.get(url)
  if (cached) return cached
  const p = (async () => {
    const ctrl = new AbortController()
    const timer = window.setTimeout(() => ctrl.abort(), timeoutMs)
    try {
      // no-store 很关键：这里正是为了发现「同一个 URL 的对象内容已经换了」，
      // 若 HEAD 自己也吃浏览器缓存，就永远读不到新的 ETag。
      const res = await fetch(url, { method: 'HEAD', cache: 'no-store', signal: ctrl.signal })
      if (!res.ok) return ''
      // 地址配错时请求会落到本站的 SSR 兜底路由上，那边对任何路径都回 200 + HTML。
      // 只看 res.ok 的话会误判成「ROM 存在」，页面显示「即点即玩」，
      // 点下去才在模拟器里报一句莫名其妙的「不是合法的 ROM」。
      const type = res.headers.get('content-type') || ''
      if (/text\/html|application\/xhtml/i.test(type)) return ''
      return versionedRomUrl(url, res.headers.get('etag'))
    } catch {
      return ''
    } finally {
      window.clearTimeout(timer)
    }
  })()
  probeCache.set(url, p)
  return p
}

/** 后台只关心对象是否存在；播放器才需要上面的版本化 URL。 */
export async function probeUrl(url: string, timeoutMs = 4000): Promise<boolean> {
  return Boolean(await probeRomUrl(url, timeoutMs))
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
  // SSR 阶段不会运行 effect，但数据库已经明确绑定 ROM 时，我们至少知道「有在线版本，
  // 正在准备地址」。初始态直接设 checking，避免搜索引擎和首屏用户先看到
  // 「选择本地 ROM」，水合后又突然变成「开始游戏」这种自相矛盾的文案。
  const [state, setState] = useState<RomResolution>(() => ({
    status: game && effectiveRomKey(game, lang, prefer) ? 'checking' : 'idle',
    url: '',
  }))

  useEffect(() => {
    if (!game) return
    let cancelled = false
    // 显式绑定（按语言选出）优先。即使数据库已经明确绑定，也要做一次 HEAD：
    // 除了确认对象还在，更重要的是拿 ETag 给播放地址做内容版本化。
    const key = effectiveRomKey(game, lang, prefer)
    if (key) {
      const url = romUrlForKey(key)
      if (url) {
        setState({ status: 'checking', url: '' })
        void probeRomUrl(url).then((resolvedUrl) => {
          if (cancelled) return
          setState(
            resolvedUrl
              ? { status: 'found', url: resolvedUrl, key, lang: romLangOfKey(game, key) }
              : { status: 'missing', url: '' },
          )
        })
        return () => {
          cancelled = true
        }
      }
    }
    const base = getRomBase()
    if (!base || !isPlayable(game.platform)) {
      setState({ status: 'missing', url: '' })
      return
    }

    setState({ status: 'checking', url: '' })
    ;(async () => {
      for (const key of conventionalKeys(game)) {
        const url = romUrlForKey(key, base)
        const resolvedUrl = await probeRomUrl(url)
        if (resolvedUrl) {
          if (!cancelled) setState({ status: 'found', url: resolvedUrl, key })
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

/**
 * 按扩展名猜 Content-Type。
 *
 * Worker 自己也有一份兜底（`guessType(key)`），但只在请求**没带** Content-Type 时才用；
 * XHR 一定会带，拿不到类型时带的是 application/octet-stream，于是 Worker 的兜底永远轮不上。
 * 多 SWF 包里逐个上传的是 Blob（从 zip 里解出来的，没有 type），所以在这边补齐。
 */
function guessUploadType(key: string): string {
  const ext = key.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1] ?? ''
  const map: Record<string, string> = {
    swf: 'application/x-shockwave-flash',
    xml: 'text/xml',
    txt: 'text/plain; charset=utf-8',
    json: 'application/json',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    png: 'image/png',
    gif: 'image/gif',
    mp3: 'audio/mpeg',
    wav: 'audio/wav',
    flv: 'video/x-flv',
    zip: 'application/zip',
  }
  return map[ext] ?? 'application/octet-stream'
}

/**
 * 通过 Worker 上传文件到 R2（PUT），带进度回调。
 *
 * 收 Blob 而不只是 File：多 SWF 包是在浏览器里解开 zip 之后逐个上传的，
 * 手上只有 Blob，没有 File。
 */
export function uploadRom(file: Blob, key: string, onProgress?: (pct: number) => void): Promise<UploadResult> {
  const api = getRomApi()
  if (!api) return Promise.reject(new Error('尚未配置 Worker 地址，无法上传'))
  if (!getRomToken()) return Promise.reject(new Error('请先在「ROM 存储」页填写 Worker 口令（ADMIN_TOKEN）'))
  const cleanKey = key.replace(/^\/+/, '')

  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest()
    xhr.open('PUT', `${api}/${encodeKey(cleanKey)}`)
    xhr.setRequestHeader('Authorization', `Bearer ${getRomToken()}`)
    xhr.setRequestHeader('Content-Type', file.type || guessUploadType(cleanKey))
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

/**
 * 根据 key 猜对应的游戏 slug：
 *   roms/nes/super-mario-bros.zip        -> super-mario-bros
 *   roms/flash/jyqx3/root.swf            -> jyqx3     （多文件包认目录名，不是包里的文件名）
 *   roms/flash/jyqx3.zh-Hans/root.swf    -> jyqx3     （剥掉语言后缀）
 *
 * 多文件包这条很关键：按老逻辑取最后一段，同一个包里的五个 swf 会分别猜成
 * root / war / map …，「自动匹配」既对不上游戏，还可能把 war.swf 绑成 ROM。
 */
export function slugFromKey(key: string): string {
  const parts = key.split('/').filter(Boolean)
  const prefix = getRomPrefix()
  const i = prefix && parts[0] === prefix ? 1 : 0
  const name = parts.length >= i + 3 ? parts[i + 1] : (parts[parts.length - 1] ?? key)
  const noExt = name
    .replace(/\.(zip|7z|nes|unf|fds|sfc|smc|fig|gba|gbc|gb|z64|n64|v64|md|gen|bin|smd|nds|ws|wsc|cue|iso|img|pbp|chd|exe|com|swf|jar)$/i, '')
    .toLowerCase()
    .replace(/[\s_]+/g, '-')
  const lang = ROM_LANGS.find((l) => noExt.endsWith(`.${l.toLowerCase()}`))
  return lang ? noExt.slice(0, -(lang.length + 1)) : noExt
}

/** 从 key 里推断平台：roms/nes/x.zip -> nes */
export function platformFromKey(key: string): string {
  const parts = key.split('/')
  const prefix = getRomPrefix()
  const idx = prefix && parts[0] === prefix ? 1 : 0
  return parts.length > idx + 1 ? parts[idx] : ''
}
