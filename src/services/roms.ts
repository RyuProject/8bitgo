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
import { useCallback, useEffect, useRef, useState } from 'react'
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

/**
 * 构建时写死的那一份配置（**不看 localStorage**）。
 *
 * 用来判断「后台存的值和内置默认是不是同一个」—— 一样就不该往 localStorage 里落，
 * 见 saveRomConfig。
 */
const BUILTIN = {
  base: () => withScheme(trimSlash(import.meta.env.VITE_ROM_BASE_URL || '')),
  api: () => withScheme(trimSlash(import.meta.env.VITE_ROM_API_URL || '')),
  prefix: () => {
    const raw = import.meta.env.VITE_ROM_PREFIX
    return raw === undefined || raw === null ? 'roms' : String(raw).replace(/^\/+|\/+$/g, '')
  },
}

/**
 * 这几项当前是不是被浏览器本地的值盖着（而不是用构建时的配置）。
 *
 * 后台用它提醒管理员：本地覆盖**只影响他自己这台浏览器**，改 .env.production 对他不生效，
 * 而他看到的故障别人多半看不到 —— 这个不对称最容易把排查带沟里。
 */
export function romConfigOverrides(): { base: boolean; api: boolean; prefix: boolean } {
  return {
    base: Boolean(readLocal(ROM_BASE_KEY)),
    api: Boolean(readLocal(ROM_API_KEY)),
    prefix: Boolean(readLocal(ROM_PREFIX_KEY)),
  }
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
  /*
    存的时候就把协议头补齐，后台输入框里显示的就是最终生效的地址，
    免得填了 assets.8bitgo.com 之后看着没问题、实际被当成相对路径。

    ⚠️ 和内置默认一模一样的值**不落 localStorage**（写空串 = 删掉那个键）。

    这一条是踩过之后补的：表单是拿 getRomConfig() 初始化的，而它返回的是「当前生效值」，
    也就是构建时的 VITE_ROM_BASE_URL。于是管理员只要打开这一页点过一次保存 ——
    哪怕一个字都没改 —— 就把当时的地址冻成了自己浏览器里的一份私有副本。
    之后 .env.production 再怎么改，对他这台浏览器都不生效，而别人全都正常：
    「只有我打不开」这种最难查的故障就是这么来的。
    存成空的之后 getRomBase() 会自然回落到构建时的值，效果完全一样，只是不再冻住。
  */
  if (cfg.base !== undefined) {
    const base = cfg.base ? withScheme(trimSlash(cfg.base)) : ''
    writeLocal(ROM_BASE_KEY, base === BUILTIN.base() ? '' : base)
  }
  if (cfg.api !== undefined) {
    const api = cfg.api ? withScheme(trimSlash(cfg.api)) : ''
    writeLocal(ROM_API_KEY, api === BUILTIN.api() ? '' : api)
  }
  if (cfg.prefix !== undefined) {
    const prefix = cfg.prefix.replace(/^\/+|\/+$/g, '')
    writeLocal(ROM_PREFIX_KEY, prefix === BUILTIN.prefix() ? '' : prefix)
  }
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
  // HTML5 游戏通常是一整套网站文件；约定把入口放在独立目录的 index.html，
  // 同时兼容只有一个 HTML 文件的小作品。
  if (game.platform === 'html5') return [at(`${game.slug}/index.html`), at(`${game.slug}.html`)]
  const exts = platformMap[game.platform]?.romExtensions ?? ['.zip']
  const ordered = ['.zip', ...exts.filter((e) => e !== '.zip')]
  return ordered.map((ext) => at(`${game.slug}${ext}`))
}

/** key 自带完整地址（外链或站内绝对路径），不需要根地址就能探 */
const selfContainedKey = (key: string) => /^https?:\/\//i.test(key) || key.startsWith('/')

/**
 * 首帧就能断定「这游戏待会儿要去探云端 ROM」吗？—— useRomUrl 的初始态用它。
 *
 * 为什么不能只看 effectiveRomKey（这是原来的写法）：那个只认后台**显式绑定**的语言槽，
 * 而绝大多数游戏是靠约定 key（<前缀>/<platform>/<slug>.zip）探出来的，压根没有绑定记录。
 * 于是这些游戏的首帧落到 idle —— 主按钮先写「选择本地 ROM」，effect 一跑变「正在准备
 * 在线版本…」，探完又变「开始游戏」。三段文案，正是初始态那段注释想避免的那种自相矛盾。
 *
 * **只看构建时的根地址，故意不看 localStorage 覆盖**：初始态必须在服务端渲染和水合时
 * 算出同一个值，而那份覆盖只存在于管理员自己那台浏览器里。少数派多闪一下，
 * 换来所有人都不会 hydration mismatch。
 */
export function romProbeExpected(game: Game | undefined, lang: Lang, prefer?: RomLang | null): boolean {
  if (!game) return false
  const explicit = romCandidates(game, lang, prefer).map((c) => c.key)
  // 外链 / 站内绝对路径不依赖根地址
  if (explicit.some(selfContainedKey)) return true
  // 根地址没配就是没接云端 ROM，这时老实显示「选择本地 ROM」，不要空转一帧
  if (!BUILTIN.base()) return false
  return explicit.length > 0 || conventionalKeys(game).length > 0
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

/** 上传到对象存储的媒体类别。目录名就是 key 的第一段。 */
export type MediaKind = 'covers' | 'videos' | 'logos' | 'friend-links'

/** 给封面 / 视频 / logo / 友链图生成默认 key：<kind>/<slug>.<ext> */
export function defaultMediaKey(kind: MediaKind, slug: string, fileName: string): string {
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

export interface RomCandidate {
  key: string
  /** 通用 rom 没有语言槽，所以这里可能为空 */
  lang?: RomLang
}

/**
 * 回退链靠前的那几个：英语和日语多半就是原版，简繁互为对方最好的替代。
 *
 * 只是**优先级**，不是全集 —— 真正的全集是 ROM_LANGS，由下面 romCandidates 兜底接上。
 */
const FALLBACK_PRIORITY: RomLang[] = ['en', 'ja', 'zh-Hans', 'zh-Hant']

/**
 * 按语言列出 ROM 候选：当前语言 → 英语 → 日语 → 简体 → 繁体 → **其余所有语言槽** → 旧版通用 rom。
 *
 * 两个中文槽都在回退里，是因为后台允许分别上传简繁版本；不能因为简体槽为空，
 * 就在繁体槽明明有文件时误报「没有当前语言版本」。同一个 key 只保留第一次出现，
 * 避免管理员把多个语言槽绑到同一个对象时重复发 HEAD 请求。
 *
 * prefer 是玩家在播放器里手动选的语言，优先级最高；后面的回退仍保留，防止所选槽
 * 对应的 R2 对象后来被删掉时，播放器直接变成不可用。
 *
 * ⚠️ 结尾那个 `...ROM_LANGS` 不能省。这里原本是手写的五项
 * `[requested, 'en', 'ja', 'zh-Hans', 'zh-Hant']`，而 ROM_LANGS 有八项 ——
 * fr / de / es / it 四个槽**永远不会被当作回退**。后果是：一款游戏只传了西语版
 * （超级玛丽兄弟的 es 槽就是这么来的），站点语言又不是西语时，界面报
 * 「游戏没有当前语言版本」，而那个 ROM 明明就躺在 R2 上。
 * 所以现在从 ROM_LANGS 派生，以后往里加语言槽不用再记得改这儿。
 */
export function romCandidates(game: Pick<Game, 'rom' | 'roms'>, lang: Lang, prefer?: RomLang | null): RomCandidate[] {
  const requested = prefer ?? romLangFor(lang)
  const order: RomLang[] = [requested, ...FALLBACK_PRIORITY, ...ROM_LANGS]
  const candidates: RomCandidate[] = []
  const seen = new Set<string>()

  for (const candidateLang of order) {
    const key = game.roms?.[candidateLang]?.trim()
    if (!key || seen.has(key)) continue
    seen.add(key)
    candidates.push({ key, lang: candidateLang })
  }

  // game.rom 是旧数据里的无语言版本；继续兼容，避免升级后让原本能玩的游戏消失。
  const generic = game.rom?.trim()
  if (generic && !seen.has(generic)) candidates.push({ key: generic })
  return candidates
}

/** 返回语言回退链里的第一个候选；实际播放会继续探测后续候选是否存在。 */
export function effectiveRomKey(game: Game, lang: Lang, prefer?: RomLang | null): string {
  return romCandidates(game, lang, prefer)[0]?.key ?? ''
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

/**
 * 探测结果缓存。
 *
 * 只缓存**有结论**的那两种：拿到了对象，或者服务器明确说没有（404 / 403 / 410，
 * 以及回了 HTML 的情况）。网络抖动、HEAD 超时、R2 回 5xx 都**不算结论**。
 *
 * 以前它们和 404 一视同仁地被永久缓存，后果是：一次 4 秒超时就能让这款游戏
 * 在整个单页应用会话里一直显示「游戏没有当前语言版本 / 选择 ROM 开始游戏」——
 * ROM 明明好好躺在 R2 上，来回切页面也没用，只有整页刷新才能恢复。
 */
const probeCache = new Map<string, Promise<ProbeOutcome>>()

/** 单次探测的结果。certain=false 表示「这一次没问出结论」，不该被记住 */
export interface ProbeOutcome {
  url: string
  certain: boolean
  /**
   * 失败原因，**只给诊断用**，不参与任何判断逻辑。
   *
   * 加它是因为排查「ROM 明明在、页面却说没有」时，这一层原本什么都不说：
   * `probeOnce` 的 catch 把异常整个吞掉，CORS 被拒、被插件拦、超时、断网
   * 在上层看起来一模一样，只能靠人去浏览器控制台里手动复现。见 reportProbeFailure。
   */
  reason?: 'http' | 'html' | 'network' | 'timeout'
  /** reason === 'http' 时服务器给的状态码 */
  status?: number
}

/**
 * 这些状态码是服务器给出的**答复**：对象就是不在，再问一百次也一样，可以放心缓存。
 * 反过来 5xx、429 和连不上都属于「没问出结果」，必须留给下一次重新问。
 */
const DEFINITE_MISS_STATUS = new Set([400, 401, 403, 404, 405, 410, 451])

/**
 * 把对象的 ETag 写进查询串，给浏览器 HTTP 缓存和 EmulatorJS IndexedDB 缓存换 key。
 *
 * R2 允许覆盖同一个对象 key；若播放地址永远不变，两个缓存都会继续交出旧 ROM。
 * ETag 随对象内容变化，既不会让没更新的 ROM 重复下载，也不依赖人工清缓存。
 */
export function versionedRomUrl(url: string, etag: string | null): string {
  const version = etag?.replace(/^W\//, '').replaceAll('"', '').trim()
  if (!version) return url
  const separator = url.includes('?') ? '&' : '?'
  return `${url}${separator}romv=${encodeURIComponent(version)}`
}

/** 探一次。区分「没有」和「没问出来」，后者留给上层重试 */
async function probeOnce(url: string, timeoutMs: number, allowHtml: boolean): Promise<ProbeOutcome> {
  const ctrl = new AbortController()
  const timer = window.setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    // no-store 很关键：这里正是为了发现「同一个 URL 的对象内容已经换了」，
    // 若 HEAD 自己也吃浏览器缓存，就永远读不到新的 ETag。
    const res = await fetch(url, { method: 'HEAD', cache: 'no-store', signal: ctrl.signal })
    if (!res.ok) return { url: '', certain: DEFINITE_MISS_STATUS.has(res.status), reason: 'http', status: res.status }
    // 地址配错时请求会落到本站的 SSR 兜底路由上，那边对任何路径都回 200 + HTML。
    // 只看 res.ok 的话会误判成「ROM 存在」，页面显示「即点即玩」，
    // 点下去才在模拟器里报一句莫名其妙的「不是合法的 ROM」。
    const type = res.headers.get('content-type') || ''
    if (!allowHtml && /text\/html|application\/xhtml/i.test(type)) return { url: '', certain: true, reason: 'html' }
    return { url: versionedRomUrl(url, res.headers.get('etag')), certain: true }
  } catch {
    // 超时（abort）、断网、CORS 被拒、被浏览器插件拦掉，全都是「没问出来」。
    // fetch 对这几种一律抛一个不带信息的 TypeError（CORS 的细节只在控制台里，
    // 脚本读不到），所以只能靠 signal 把「超时」这一种单独认出来。
    return { url: '', certain: false, reason: ctrl.signal.aborted ? 'timeout' : 'network' }
  } finally {
    window.clearTimeout(timer)
  }
}

/**
 * HEAD 探测 ROM，并把内容 ETag 带回播放 URL。
 *
 * 没问出结论时**当场重试一次**（隔 300ms，躲开瞬时抖动），仍然没有结论就把这次的
 * 结果从缓存里摘掉 —— 下次再问会真的再发一次请求，而不是复读一个失败。
 * 只重试一次是为了兜住耗时：上层要按语言槽依次探好几个候选，每多一轮就多等一个超时。
 */
export function probeRom(url: string, timeoutMs = 4000, allowHtml = false): Promise<ProbeOutcome> {
  // 同一个 URL 作为 ROM 时必须拒绝 HTML，作为 HTML5 入口时又必须接受；缓存键要把两种语义分开。
  const cacheKey = `${allowHtml ? 'html' : 'rom'}:${url}`
  const cached = probeCache.get(cacheKey)
  if (cached) return cached
  // 先声明再赋值：下面的闭包要拿自己这条 promise 跟缓存比对（同步段跑不到那里，
  // 等真的用上时 p 早就赋好了）
  let p: Promise<ProbeOutcome> | undefined
  p = (async () => {
    let outcome = await probeOnce(url, timeoutMs, allowHtml)
    if (!outcome.certain) {
      await new Promise((r) => window.setTimeout(r, 300))
      outcome = await probeOnce(url, timeoutMs, allowHtml)
    }
    if (!outcome.certain) {
      // 只摘掉自己这一条：期间可能已经有别的调用重新写了缓存，别把人家的结果删了
      if (probeCache.get(cacheKey) === p) probeCache.delete(cacheKey)
    }
    return outcome
  })()
  probeCache.set(cacheKey, p)
  return p
}

/**
 * 只要地址、不关心「为什么没有」的调用方用这个（后台的存在性检查等）。
 *
 * 播放器不能用它 —— 它把 certain 丢了，而「服务器说没有」和「这次没问出来」
 * 恰恰要区别对待：前者该报错，后者该自动重试。见 useRomUrl。
 */
export function probeRomUrl(url: string, timeoutMs = 4000, allowHtml = false): Promise<string> {
  return probeRom(url, timeoutMs, allowHtml).then((o) => o.url)
}

/**
 * 清掉这些地址的探测缓存，下次访问会重新发 HEAD。
 *
 * 给「重试」按钮用：确定性的失败（404）本来是该缓存的，但后台刚把 ROM 传上去、
 * 或者刚改完绑定时，玩家手里的页面还记着上一轮的「没有」。不传参数就全清。
 */
export function clearRomProbeCache(urls?: string[]): void {
  if (!urls) return probeCache.clear()
  for (const url of urls) {
    probeCache.delete(`rom:${url}`)
    probeCache.delete(`html:${url}`)
  }
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
  /**
   * missing 的原因是「**没问出来**」（超时 / 断网 / CORS / 5xx），不是服务器说没有。
   *
   * 两者对玩家是完全不同的两件事：真没有就该去挑别的语言或本地文件，
   * 而读不到只是这会儿的事，等一等或者换个网就好了。文案要分开说。
   */
  unreachable?: boolean
  /** 重新探测一遍，并先把这款游戏所有候选地址的缓存结论清掉 */
  retry: () => void
}

/**
 * 「没问出来」时自动重试的退避节奏（毫秒）。
 *
 * 为什么要自动重试：探测失败最常见的原因是网络抖一下、或者切后台时请求被掐掉，
 * 而这时候界面会一路掉到「游戏没有当前语言版本」—— ROM 明明好好躺在 R2 上。
 * 让玩家自己去点「重新检查」是把我们的问题推给他。
 *
 * 三次、由密到疏，全部用完约 8 秒；期间状态保持 checking（按钮显示「正在确认」），
 * 不会先闪一下错误再自己好。确定性的失败（404）一次都不重试 —— 问一百次也一样。
 */
const AUTO_RETRY_DELAYS = [800, 2000, 5000]

/** 一个候选探完之后留下的痕迹，只为诊断 */
interface ProbeTrace {
  key: string
  url: string
  outcome: ProbeOutcome
}

/**
 * 彻底放弃时在控制台留一条能直接定位的诊断。
 *
 * 为什么值得专门写：这个故障（「ROM 明明躺在 R2 上，页面却说没有当前语言版本」）
 * 排查一次的成本高得离谱 —— 页面上只有一句话，控制台一个字都没有，
 * 得先去翻数据库绑定、再去服务端手取对象、最后才想到是浏览器这一次 HEAD 的事。
 * 而这三件事里究竟是哪一件，这里全都知道，只是以前没说出来。
 *
 * 三种最常见的成因都在下面点了名：
 *   · localStorage 覆盖 —— 后台「ROM 存储」页保存过配置的浏览器会冻一份地址副本，
 *     只影响那一个人（多半就是管理员自己），改 .env.production 也不生效
 *   · CORS —— assets 域名直接绑在 R2 桶上（Worker 没跑）时要在桶上配 CORS；
 *     走 Worker 的话是它的 ALLOWED_ORIGINS
 *   · 浏览器插件 —— 钱包类插件会 hook fetch
 */
function reportProbeFailure(game: Pick<Game, 'slug' | 'platform'>, traces: ProbeTrace[], unreachable: boolean) {
  const base = getRomBase()
  const overridden = Boolean(readLocal(ROM_BASE_KEY))
  const lines = traces.map(({ key, url, outcome }) => {
    const why = outcome.reason === 'http' ? `HTTP ${outcome.status}` : (outcome.reason ?? '未知')
    return `  ${outcome.certain ? '确定没有' : '没问出来'}（${why}）  ${key}\n    ${url}`
  })
  console.warn(
    [
      `[8bitgo/rom] ${game.slug}（${game.platform}）所有候选都没探到，界面会显示「${unreachable ? '暂时读取不到 ROM' : '没有当前语言版本'}」。`,
      `根地址：${base || '(空)'}${overridden ? `  ⚠️ 来自 localStorage['${ROM_BASE_KEY}']，不是构建时的 VITE_ROM_BASE_URL` : ''}`,
      traces.length ? '候选：' : '候选：(一个都没有 —— 后台没绑过语言槽，约定文件名也没探到)',
      ...lines,
      unreachable
        ? '这几次都是「没问出来」：多半是 CORS（assets 域名要么走 Worker 并放行本站 Origin，要么在 R2 桶上配 CORS 允许 GET/HEAD）、断网，或者被浏览器插件拦了。开无痕窗口再试一次能排掉插件。'
        : '服务器明确说没有：核对后台的语言槽绑定，以及对象是否真的在桶里（注意大小写和 .lang 后缀）。',
    ].join('\n'),
  )
}

/**
 * 解析某款游戏可直接播放的 ROM 地址：显式绑定 → 立即可用；否则按约定 key 探测。
 *
 * prefer：玩家在播放器工具栏里手动选的 ROM 语言，不传就跟着站点语言走。
 */
export function useRomUrl(game: Game | undefined, prefer?: RomLang | null): RomResolution {
  const lang = useLang()
  /*
    SSR 阶段不会运行 effect，但只要待会儿会去探（显式绑定 **或**约定 key，见
    romProbeExpected），我们此刻就已经知道「有在线版本，正在准备地址」。
    初始态直接设 checking，避免搜索引擎和首屏用户先看到「选择本地 ROM」，
    水合后又突然变成「开始游戏」这种自相矛盾的文案。
  */
  const [state, setState] = useState<Omit<RomResolution, 'retry'>>(() => ({
    status: romProbeExpected(game, lang, prefer) ? 'checking' : 'idle',
    url: '',
  }))
  const [attempt, setAttempt] = useState(0)
  /** 这一轮已经自动重试过几次。换游戏 / 换语言 / 玩家手动重试都要清零 */
  const autoRetries = useRef(0)

  /**
   * 重试。先清掉这款游戏所有候选地址的探测结论 —— 否则「服务器明确说没有」那一类
   * 是会被缓存的（本该如此），可玩家点重试的场景恰恰就是「刚传上去 / 刚改完绑定」，
   * 不清就等于按了个没用的按钮。
   */
  const retry = useCallback(() => {
    if (game) {
      const keys = [...romCandidates(game, lang, prefer).map((c) => c.key), ...conventionalKeys(game)]
      clearRomProbeCache(keys.map((key) => romUrlForKey(key)).filter(Boolean))
    }
    autoRetries.current = 0
    setAttempt((n) => n + 1)
  }, [game, lang, prefer])

  /*
    换游戏 / 换语言时把自动重试的次数清零。
    必须声明在下面那个主 effect **之前** —— effect 按声明顺序跑，这样切换游戏时先清零
    再开始探测；而只有 attempt 变化（自动重试自己触发的那一次）时这个 effect 不跑，
    计数才累加得下去，不会变成无限重试。
  */
  useEffect(() => {
    autoRetries.current = 0
  }, [game, lang, prefer])

  useEffect(() => {
    if (!game) return
    let cancelled = false
    let timer = 0
    setState({ status: 'checking', url: '' })
    ;(async () => {
      const candidates = romCandidates(game, lang, prefer)
      /** 有没有哪个候选是「没问出来」，而不是服务器明确说没有。决定要不要自动重试 */
      let uncertain = false
      /** 每个候选探出来的结果，只在最终放弃时用来打诊断 */
      const traces: ProbeTrace[] = []
      // 每个显式语言槽都要实际探测：绑定记录还在，不代表 R2 对象一定还在。
      // 当前槽丢失时继续按英语 → 日语 → 中文 → 其余语言槽回退，不能在第一个 404 就停住。
      for (const candidate of candidates) {
        const url = romUrlForKey(candidate.key)
        if (!url) continue
        // iframe 导航不受 fetch CORS 限制；第三方 HTML5 游戏常常允许嵌入，却不允许跨域 HEAD。
        // 完整 URL 直接交给播放器，让 iframe 自己加载，才能复现普通网页嵌入的工作方式。
        if (game.platform === 'html5' && /^https?:\/\//i.test(candidate.key)) {
          if (!cancelled) setState({ status: 'found', url, key: candidate.key, lang: candidate.lang })
          return
        }
        const outcome = await probeRom(url, 4000, game.platform === 'html5')
        if (outcome.url) {
          if (!cancelled) setState({ status: 'found', url: outcome.url, key: candidate.key, lang: candidate.lang })
          return
        }
        traces.push({ key: candidate.key, url, outcome })
        if (!outcome.certain) {
          /*
            「没问出来」就**立刻收手**，别把剩下的候选挨个耗一遍。

            这一类失败（断网 / CORS / 被插件拦 / 超时）是**主机级**的，不是这个 key 的事 ——
            同一个域名下的其它候选必然一样失败。而每个候选要花「4 秒超时 ×2 + 300ms」，
            回退链补全到八个语言槽之后，硬探到底最坏要 66 秒，再叠上三轮自动重试
            就是四分多钟的「正在确认文件」。收手之后一轮最多 8 秒多，退避重试才有意义。
          */
          uncertain = true
          break
        }
      }

      // 只要后台绑定过语言槽或旧版通用 rom，整条绑定链都失效就应明确报缺版本；
      // 不能再猜一个约定文件名，否则会绕过管理员配置，加载到不受控的旧对象。
      if (candidates.length > 0) {
        if (!cancelled) finish(uncertain, traces)
        return
      }

      const base = getRomBase()
      if (!base || !isPlayable(game.platform)) {
        // 这是配置问题（根地址没配、平台不支持），重试一万次也一样，不进重试。
        // 「平台还不支持」是正常状态（未上线的平台），不值得报；根地址空着是真的配错了。
        if (!base && isPlayable(game.platform)) {
          console.warn(
            `[8bitgo/rom] 没有配置 ROM 根地址（VITE_ROM_BASE_URL 或 localStorage['${ROM_BASE_KEY}']），` +
              `${game.slug} 这类没绑过语言槽的游戏只能靠约定文件名探测，现在一个都探不了。`,
          )
        }
        if (!cancelled) setState({ status: 'missing', url: '' })
        return
      }

      // 完全没有绑定记录的老游戏仍按历史约定探测文件名。
      for (const key of conventionalKeys(game)) {
        const url = romUrlForKey(key, base)
        const outcome = await probeRom(url, 4000, game.platform === 'html5')
        if (outcome.url) {
          if (!cancelled) setState({ status: 'found', url: outcome.url, key })
          return
        }
        traces.push({ key, url, outcome })
        // 同上：主机级的失败，接着探别的约定文件名只是白等
        if (!outcome.certain) {
          uncertain = true
          break
        }
      }
      if (!cancelled) finish(uncertain, traces)
    })()

    /**
     * 一轮探完都没拿到地址时怎么收场。
     *
     * 没问出来（uncertain）且还有重试额度 → 排下一轮，**状态保持 checking**：
     * 界面继续显示「正在确认文件」，不会先闪一下「没有这个版本」再自己好。
     * 额度用完才落到 missing，并把 unreachable 带上去，让文案说人话。
     */
    function finish(uncertain: boolean, traces: ProbeTrace[]) {
      if (uncertain && autoRetries.current < AUTO_RETRY_DELAYS.length) {
        const wait = AUTO_RETRY_DELAYS[autoRetries.current]
        autoRetries.current += 1
        timer = window.setTimeout(() => setAttempt((n) => n + 1), wait)
        return
      }
      // 只在真正放弃的那一下报一次；重试途中不吵
      if (game) reportProbeFailure(game, traces, uncertain)
      setState({ status: 'missing', url: '', unreachable: uncertain })
    }

    return () => {
      cancelled = true
      window.clearTimeout(timer)
    }
  }, [game, lang, prefer, attempt])

  /*
    网络恢复时立刻重来一轮。断网期间每一次探测都必然失败，重试额度会被白白烧光，
    玩家插回网线看到的还是「暂时读取不到」—— 而这时候只要再问一次就好了。
    只在「读不到」这一种 missing 上挂监听：真的 404 时联网事件不该触发任何请求。
  */
  useEffect(() => {
    if (state.status !== 'missing' || !state.unreachable) return
    const again = () => {
      autoRetries.current = 0
      setAttempt((n) => n + 1)
    }
    window.addEventListener('online', again)
    return () => window.removeEventListener('online', again)
  }, [state.status, state.unreachable])

  return { ...state, retry }
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

export function explainRomStatus(status: number, what: string): Error {
  if (status === 401 || status === 403) return new Error(`${what}被拒绝：请在「ROM 存储」页填写与 Worker 一致的 ADMIN_TOKEN`)
  if (status === 404 || status === 405) return new Error(`${what}不可用：该地址不是本项目的 Worker，请部署 worker/ 并填写 Worker 地址`)
  if (status === 413) return new Error(`${what}失败：请求体超限（Cloudflare 单请求 100MB，或 Worker 的 MAX_UPLOAD_MB）`)
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
    if (!res.ok) throw explainRomStatus(res.status, '列表')
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

/**
 * 单发 PUT 的适用上限，超过就走分片上传（见 romMultipart.ts）。
 *
 * 24MB 不是随手定的：
 *   - 平台的请求体上限是 100MB，单发 PUT 传到 100MB 附近必挂（边缘直接 reset，拿不到 413）
 *   - 但小文件走分片是白搭三次往返 —— NES / GBA / 封面图都在几 MB 以内
 * 所以阈值放在「一次传完还算稳」和「失败一次代价开始变大」的交界上。
 */
export const MULTIPART_THRESHOLD = 24 * 1024 * 1024

export interface UploadStage {
  /** 分片总数 */
  parts: number
  /** 已经传完的片数 */
  done: number
  /** 这次是接着上次传的，恢复了几片；0 表示从头传 */
  resumed: number
}

/** 上传进度回调。第二个参数只有分片上传才有，单发 PUT 时是 undefined */
export type UploadProgress = (pct: number, stage?: UploadStage) => void

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
export function guessUploadType(key: string): string {
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
    // 封面统一压成 WebP 之后必须有这一条：Blob（不是 File）没有 type，
    // 少了它封面会被当成 application/octet-stream 存进 R2，浏览器直接下载而不是显示
    webp: 'image/webp',
    avif: 'image/avif',
    mp4: 'video/mp4',
    webm: 'video/webm',
    mp3: 'audio/mpeg',
    wav: 'audio/wav',
    flv: 'video/x-flv',
    zip: 'application/zip',
  }
  return map[ext] ?? 'application/octet-stream'
}

/**
 * 通过 Worker 上传文件到 R2，带进度回调。
 *
 * 小文件一次 PUT 完事；超过 MULTIPART_THRESHOLD 的自动改走**分片上传 + 断点续传**，
 * 因为单发 PUT 在 100MB 附近必挂 —— Cloudflare 的请求体上限由边缘节点执行，
 * 超限时连接直接被 reset，浏览器拿不到 413，只会看到一句「无法连接 Worker」。
 * 详细缘由和账本记在哪，见 romMultipart.ts 开头。
 *
 * 签名故意保持不变：后台四个上传入口（ROM / 整包 SWF / 封面视频 / 平台 BIOS）
 * 一行都不用改就能吃到分片和续传。
 *
 * 收 Blob 而不只是 File：多 SWF 包是在浏览器里解开 zip 之后逐个上传的，
 * 手上只有 Blob，没有 File。（Blob 没有名字和修改时间，所以不支持续传，只能重传。）
 */
export async function uploadRom(file: Blob, key: string, onProgress?: UploadProgress): Promise<UploadResult> {
  const api = getRomApi()
  if (!api) throw new Error('尚未配置 Worker 地址，无法上传')
  if (!getRomToken()) throw new Error('请先在「ROM 存储」页填写 Worker 口令（ADMIN_TOKEN）')
  const cleanKey = key.replace(/^\/+/, '')

  if (file.size > MULTIPART_THRESHOLD) {
    // 动态 import：分片那套只有后台用得上，静态引会被打进播放器的首屏包里
    const mp = await import('./romMultipart')
    try {
      const result = await mp.uploadRomMultipart(file, cleanKey, onProgress)
      probeCache.clear()
      return result
    } catch (err) {
      // Worker 还没部署分片接口（忘了 wrangler deploy）时退回单发 PUT。
      // 大文件照样会失败，但小一点的文件不该因为后端没更新就整个传不了。
      if (!(err instanceof mp.MultipartUnsupportedError)) throw err
      console.warn('[rom] Worker 没有分片接口，退回单发 PUT；大文件请部署 worker/ 的新版本')
    }
  }

  return singlePut(file, cleanKey, api, onProgress)
}

/** 一次 PUT 传完。只适合小文件，大文件见 uploadRom 里的分片分支 */
function singlePut(file: Blob, cleanKey: string, api: string, onProgress?: UploadProgress): Promise<UploadResult> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest()
    xhr.open('PUT', `${api}/${encodeKey(cleanKey)}`)
    xhr.setRequestHeader('Authorization', `Bearer ${getRomToken()}`)
    xhr.setRequestHeader('Content-Type', file.type || guessUploadType(cleanKey))
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable && onProgress) onProgress(Math.round((e.loaded / e.total) * 100))
    }
    xhr.onerror = () =>
      reject(
        new Error(
          // 「检查地址与 CORS」这句话曾经把人带到完全错误的方向上：文件超过平台上限时
          // 边缘直接 reset 连接，表现和 Worker 不通一模一样。大文件优先提这个可能。
          file.size > 90 * 1024 * 1024
            ? '上传中断：文件接近或超过 Cloudflare 单请求 100MB 上限。请部署 worker/ 的新版本以启用分片上传'
            : '网络错误：无法连接 Worker（检查地址与 CORS）',
        ),
      )
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        probeCache.clear()
        resolve({ key: cleanKey, url: romUrlForKey(cleanKey), size: file.size })
      } else {
        reject(explainRomStatus(xhr.status, '上传'))
      }
    }
    xhr.send(file)
  })
}

export async function deleteRom(key: string): Promise<void> {
  const api = getRomApi()
  const res = await fetch(`${api}/${encodeKey(key)}`, { method: 'DELETE', headers: authHeaders() })
  if (!res.ok) throw explainRomStatus(res.status, '删除')
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
