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
import type { Lang, RomSlotLang } from '@/config/languages'
import { ROM_LANGS, romLangFor } from '@/config/languages'
import { useLang } from '@/services/lang'
import { romArchiveRef } from '@/lib/romArchiveUrl'
import { isRomPackUrl, romPackKey } from '../../shared/rom-pack-format.js'
import { isStreamingDiscPlatform } from '../../shared/streaming-disc-platforms.js'
import { html5EntryProblem, isHtml5EntryUrl, normalizeHtml5Entry } from '@/emulator/html5Entry'
import { builtinWebGameFor } from '../../shared/builtin-web-games.js'
import { chooseFasterRomRoute, chooseRomHost, ROM_ROUTE_RACE_MIN_BYTES, type RomHost } from './romRoute'
import { alternateRomUrls, downloadRomUrl } from './romHosts'
import { rankRomRoutes, recordRomRouteFailure, recordRomRouteSuccess, romRouteOrigin } from './romRouteHealth'
import { diagLog } from './startupDiagnostics'
import { coverCdnHint, type CoverCdnHint } from './cnHost'
import { reportCoverCdnFailure, selectedCoverCdn, startCoverCdnProbe, subscribeCoverCdn } from './coverCdn'
import { trackUploadActivity } from './uploadActivity'
import type { UploadActivityOptions } from './uploadActivity'
import { createRequestTimeout, withRequestTimeout } from './requestTimeout'
import { createRomIntegrityManifest, isIntegrityKey } from './romIntegrityData'

export const ROM_BASE_KEY = '8bitgo.rom.base'
export const ROM_API_KEY = '8bitgo.rom.api'
export const ROM_PREFIX_KEY = '8bitgo.rom.prefix'
export const ROM_TOKEN_KEY = '8bitgo.rom.token'
/** 服务端签发的短期上传凭据（romUploadCredential.ts 写入）：{ token, expiresAt } */
export const ROM_CREDENTIAL_KEY = '8bitgo.rom.credential'
/** 2026-11-22 管理员把字段提示里的占位词原样填进口令框，上传一律 401；这个词永远不是真口令 */
const PLACEHOLDER_TOKEN = 'ADMIN_TOKEN'

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

/**
 * ROM 加速镜像（腾讯 EdgeOne 的 cn-assets.8bitgo.com，回源 assets.8bitgo.com）。
 *
 * 管理员在后台「ROM 存储」覆盖过根地址时不启用：镜像只回源构建期那个 assets 域，
 * 拿它去顶替别的根地址，下到的就是另一个桶里的同名对象。
 */
export function getRomMirrorBase(): string {
  if (readLocal(ROM_BASE_KEY)) return ''
  return withScheme(trimSlash(import.meta.env.VITE_ROM_MIRROR_URL || ''))
}

/**
 * 把主 ROM 域上的地址换成镜像域上的同一个对象（路径和 romv 原样保留）。
 * 外链、站内路径、封面域都不在主域上，返回空串 —— 调用方照旧用原地址。
 */
/** HEAD 探测结束后，最多再为线路测速等这么久（毫秒）；见 romRoute.ts 的 chooseRomHost */
export const ROM_HOST_WAIT_MS = 1500

export function romMirrorUrl(url: string, base = getRomBase(), mirror = getRomMirrorBase()): string {
  if (!url || !base || !mirror || base === mirror || !url.startsWith(`${base}/`)) return ''
  return `${mirror}${url.slice(base.length)}`
}

/**
 * 大陆入口专用的封面根地址（EdgeOne 加速域，回源 image.8bitgo.com）。
 * 没配时为空串，大陆入口也照旧用主封面域。
 */
export function getCnCoverBase(): string {
  return withScheme(trimSlash(import.meta.env.VITE_CN_COVER_URL || ''))
}

/** 供首屏测速使用；当前站点对应的域仍作为首次测速失败时的安全默认值。 */
export function coverCdnProbeConfig() {
  const primary = withScheme(trimSlash(import.meta.env.VITE_COVER_URL || '')) || getRomBase()
  const cn = getCnCoverBase()
  const candidates = [...new Set([primary, cn].filter(Boolean))]
  // 边缘已经按访客所在地定了（大陆入口、或 Cloudflare 按国家改写）就直接用，不再测速
  const hint = coverCdnHint()
  return {
    candidates,
    preferred: (hint === 'cn' ? cn || primary : primary || cn) || getRomBase(),
    decided: hint !== '',
    cnBase: cn,
    transformEnabled: import.meta.env.VITE_COVER_TRANSFORM === '1',
  }
}

/**
 * 封面组件挂载后才启动测速，避免 SSR/hydrate 两侧看到不同地址。
 * 页面只传真实 covers/ key，测速器不会为外链或站内静态图片发请求。
 */
export function startCoverCdnSelection(key: string): void {
  startCoverCdnProbe(key, coverCdnProbeConfig())
}

export function subscribeCoverCdnSelection(listener: () => void): () => void {
  return subscribeCoverCdn(listener)
}

/** 封面加载失败时上报；同一域名短时间内多张图失败会切到另一个封面域 */
export function reportCoverLoadFailure(url: string): void {
  reportCoverCdnFailure(url, coverCdnProbeConfig().candidates)
}

/**
 * 封面公开读取根地址（独立 image 桶 image.8bitgo.com）；未配置时退回 ROM 根地址。
 * SSR 和客户端首次渲染都按站点域名给出同一默认值；浏览器完成 hydration 后，测速结果可覆盖默认值。
 */
export function getCoverBase(): string {
  const config = coverCdnProbeConfig()
  return selectedCoverCdn(config.candidates, config.preferred) || config.preferred
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

/** 管理员手填的 Worker 口令（只有它进设置表单；自动凭据不会被当成手填值存回去） */
export function getRomManualToken(): string {
  try {
    const value = (sessionStorage.getItem(ROM_TOKEN_KEY) ?? '').trim()
    return value === PLACEHOLDER_TOKEN ? '' : value
  } catch {
    return ''
  }
}

/** 还有效的自动凭据；离过期不到一分钟就当没有，免得请求发到一半过期 */
export function getRomAutoCredential(): { token: string; expiresAt: number } | null {
  try {
    const raw = sessionStorage.getItem(ROM_CREDENTIAL_KEY)
    if (!raw) return null
    const data = JSON.parse(raw) as { token?: unknown; expiresAt?: unknown }
    if (typeof data.token !== 'string' || !data.token || typeof data.expiresAt !== 'number') return null
    return data.expiresAt - Date.now() > 60_000 ? { token: data.token, expiresAt: data.expiresAt } : null
  } catch {
    return null
  }
}

/** 实际发给 Worker 的口令：手填的优先（排障 / 服务端没配签名密钥时用），否则用自动凭据 */
export function getRomToken(): string {
  return getRomManualToken() || getRomAutoCredential()?.token || ''
}

/** 自动凭据写入 / 清除后通知订阅者（上传按钮的可用状态跟着变） */
export function notifyRomConfigChanged() {
  for (const l of listeners) l()
}

export interface RomConfig {
  base: string
  api: string
  prefix: string
  /** 实际生效的口令（手填或自动凭据），判断「能不能上传」用 */
  token: string
  /** 手填的那份，只给设置表单显示和保存 */
  manualToken: string
}

export function getRomConfig(): RomConfig {
  return { base: getRomBase(), api: getRomApi(), prefix: getRomPrefix(), token: getRomToken(), manualToken: getRomManualToken() }
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
  // 只存手填口令。去掉首尾空白；占位词「ADMIN_TOKEN」当作没填，让自动凭据接手
  const manual = cfg.manualToken ?? cfg.token
  if (manual !== undefined) {
    const value = manual.trim()
    try {
      if (value && value !== PLACEHOLDER_TOKEN) sessionStorage.setItem(ROM_TOKEN_KEY, value)
      else sessionStorage.removeItem(ROM_TOKEN_KEY)
    } catch {
      /* ignore */
    }
  }
  clearRomProbeCache()
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
  // 外链封面没有 -96 缩略图，coverThumbKey 会返回空串。空串若继续拼根地址，
  // 玩家页背景图就会请求 https://assets.8bitgo.com/，而不是退回原图。
  if (!key.trim()) return ''
  if (/^https?:\/\//i.test(key)) return key
  if (key.startsWith('/')) return key
  // 封面走独立的 image 桶（image.8bitgo.com），和 ROM 主桶隔离缓存命名空间，
  // 免得大 ROM 下载把高频小封面从边缘缓存顶掉。新桶缺图时由 Worker 透明回退老桶。
  const useBase = key.startsWith('covers/') ? getCoverBase() || base : base
  if (!useBase) return ''
  const url = `${useBase}/${encodeKey(key)}`
  // 明文 ROM 优先走独立下载域；后台改过存储根地址时不能把自定义桶误送到生产域。
  // 历史 8BG 密文仍走原线路，只有主机故障时才由备用链尝试其它域。
  return key.startsWith('covers/') || isRomPackUrl(key) ? url : downloadRomUrl(url) || url
}

export type GameMediaKind = 'cover' | 'video'

/** 给外链媒体代理生成短版本戳；后台换 URL 后边缘缓存会自然换一条。 */
function mediaVersion(value: string): string {
  let hash = 2166136261
  for (let index = 0; index < value.length; index++) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, 16777619)
  }
  return (hash >>> 0).toString(36)
}

/**
 * 游戏封面 / 视频专用地址。
 *
 * R2 key 与站内路径仍直连；完整外链改走按 slug 回查数据库的同源接口。
 * 这样普通页面与 PSP 的 COEP 隔离页面得到同一份 SSR 标记，不会在 hydrate 前先发起一轮
 * 注定被浏览器拦掉的第三方请求，也不用把任意目标 URL 暴露给一个开放代理。
 */
export function gameMediaUrl(
  game: { slug: string; cover?: string; video?: string },
  kind: GameMediaKind,
): string {
  const value = String(game[kind] || '').trim()
  if (!value) return ''
  if (!/^https?:\/\//i.test(value)) {
    if (kind === 'video') return cnPreviewVideoUrl(value, coverCdnHint(), getRomMirrorBase()) || romUrlForKey(value)
    return romUrlForKey(value)
  }
  return `/api/games/${encodeURIComponent(game.slug)}/media/${kind}?v=${mediaVersion(value)}`
}

/**
 * 大陆访客的卡片预览视频改走 ROM 加速镜像（cn-assets，EdgeOne 香港节点，回源 assets 的同一个 Worker）。
 * 只改 R2 对象 key；站内路径、外链代理照旧。边缘没判成大陆、没配镜像、后台覆盖过根地址
 * （getRomMirrorBase 此时为空）都返回空串，调用方退回原地址。
 * 判定用 coverCdnHint：服务端渲染和 hydrate 读的是同一个值，不会出现 src 对不上。
 * 加载失败由 GameCover 退回 gameVideoFallbackUrl。
 */
export function cnPreviewVideoUrl(key: string, hint: CoverCdnHint, mirror: string): string {
  if (hint !== 'cn' || !mirror || !key || key.startsWith('/') || /^https?:\/\//i.test(key)) return ''
  return `${mirror}/${encodeKey(key)}`
}

/** 预览视频的备用地址：镜像失败时换回主线路；和当前地址相同则返回空串 */
export function gameVideoFallbackUrl(game: { slug: string; video?: string }, current: string): string {
  const value = String(game.video || '').trim()
  if (!value || /^https?:\/\//i.test(value)) return ''
  const primary = romUrlForKey(value)
  return primary && primary !== current ? primary : ''
}

/**
 * 封面缩放档位：卡片实际 222~254 CSS 像素，1x 屏取 240、2x 屏取 480。
 * 只开两档是为了守住 Image Transformations 免费额度（每月 5,000 个唯一变换）：
 * 650 张封面 × 2 档，即使 format=auto 的 AVIF / WebP 分开计也在额度内。
 */
const COVER_WIDTHS = [240, 480] as const

/**
 * 封面的 Cloudflare Image Transformations srcset；不适用时返回空串，调用方照旧用原图。
 *
 * 只处理本站封面域下的 `covers/` 原图：外链走同源代理，缩略图本来就只有 96 像素。
 * 用 `/cdn-cgi/image/` 而不是在 Worker 里转码，是因为变换结果由 Cloudflare 边缘直接缓存，
 * 而且按浏览器 Accept 自动给 AVIF / WebP；源图仍经 Worker 读 R2，缓存寿命跟着源图
 * 的 s-maxage=600 走，所以「换封面 10 分钟内生效」不变。
 * fit=scale-down 保证 480 档不会把 300 像素的老封面放大糊掉。
 *
 * 构建期开关 VITE_COVER_TRANSFORM=1：本地开发的封面根地址没有 /cdn-cgi/，开了只会全部 404。
 *
 * 大陆入口的封面域是 EdgeOne，它把 `/cdn-cgi/image/...` 原样回源给 image.8bitgo.com，
 * 变换仍由 Cloudflare 做。但 EdgeOne 的缓存键不看 Accept：format=auto 时第一个访客
 * 拿到 AVIF，就会把 AVIF 发给不认 AVIF 的浏览器。所以那条路固定 format=webp。
 */
export function coverSrcSet(
  src: string,
  base = import.meta.env.VITE_COVER_TRANSFORM === '1' ? getCoverBase() : '',
  format: 'auto' | 'webp' = base && base === getCnCoverBase() ? 'webp' : 'auto',
): string {
  const prefix = `${base}/covers/`
  if (!base || !/^https:\/\//i.test(base) || !src.startsWith(prefix)) return ''
  const path = src.slice(base.length + 1)
  return COVER_WIDTHS.map(
    (width) => `${base}/cdn-cgi/image/width=${width},quality=80,format=${format},fit=scale-down/${path} ${width}w`,
  ).join(', ')
}

const IMAGE_EXT_RE = /\.(png|jpe?g|webp|avif)$/i

/**
 * 封面的 96×96 缩略图 key：`covers/xxx.webp` → `covers/xxx-96.webp`。
 *
 * 只拼字符串，不探活 —— 老封面上传时还没有缩略图这一步，那种 key 取不到；
 * 由 Worker 在 GET 时退回原图（见 worker/src/index.js 的 -96 兜底），
 * 前端再用 onError 兜一层，所以这里不用等任何请求。
 *
 * @returns 缩略图 key；外链地址和无法识别的 key 返回空串（调用方应当直接用原图）
 */
export function coverThumbKey(key: string): string {
  if (!key || /^https?:\/\//i.test(key)) return ''
  const dot = key.lastIndexOf('.')
  if (dot <= 0 || dot === key.length - 1) return ''
  const ext = key.slice(dot)
  // 只认图片：ROM 之类（.gba / .zip / .swf…）不生成缩略图，也别把它们的 key 改成 -96
  if (!IMAGE_EXT_RE.test(ext)) return ''
  return `${key.slice(0, dot)}-96${ext}`
}

/** 游戏明确绑定了 ROM 时返回其 URL，否则返回空串 */
export function explicitRomUrl(game: Game): string {
  return game.rom ? romUrlForKey(game.rom) : ''
}

/** 约定 key：先探明文 <slug>.<ext>，再探旧的 <slug>.<ext>.8bg；zip 优先。 */
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
  // 内置页保留站内入口；其它 HTML5 游戏必须由后台绑定网页 URL，不按 ROM key 猜文件。
  if (game.platform === 'html5') {
    const builtin = builtinWebGameFor(game.slug)
    return builtin ? [builtin.entry] : []
  }
  const exts = platformMap[game.platform]?.romExtensions ?? ['.zip']
  // 流式光盘运行时需要直接看到容器并按后缀选解析器；外层 ZIP 即使能探到也一定启动不了。
  // 后台上传守卫已经拒绝新 ZIP，这里也别让历史遗留的 `<slug>.zip` 抢在 ISO 前面。
  const streamingDisc = isStreamingDiscPlatform(game.platform)
  const ordered = streamingDisc ? exts.filter((e) => e !== '.zip') : ['.zip', ...exts.filter((e) => e !== '.zip')]
  const legacy = ordered.map((ext) => at(`${game.slug}${ext}`))
  // 新内容优先用可直接流式读取的明文对象，历史 8BG 只作兼容回退；流式光盘不走浏览器解包。
  // PS1 的新 ROM 已改为直接绑定裸盘（CHD 还要走 Range），因此约定探测也先查裸文件，
  // 只有历史对象确实不存在时才回退到旧 8BG；否则会对每个现存 CHD 先制造一个 404。
  if (streamingDisc) return legacy
  if (game.platform === 'psx') return [...legacy, ...legacy.map((key) => `${key}.8bg`)]
  return [...legacy, ...legacy.map((key) => `${key}.8bg`)]
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
export function romProbeExpected(game: Game | undefined, lang: Lang, prefer?: RomSlotLang | null): boolean {
  if (!game) return false
  if (game.platform === 'html5' && builtinWebGameFor(game.slug)?.externalLaunchUrl) return false
  const explicit = (game.platform === 'html5' ? playbackRomCandidates(game, lang, prefer) : romCandidates(game, lang, prefer)).map((c) => c.key)
  const conventional = conventionalKeys(game)
  // 需要播放器加载的外链 / 站内绝对路径不依赖根地址；内置网页游戏正是后一种。
  if (explicit.some(selfContainedKey) || conventional.some(selfContainedKey)) return true
  // 根地址没配就是没接云端 ROM，这时老实显示「选择本地 ROM」，不要空转一帧
  if (!BUILTIN.base()) return false
  return explicit.length > 0 || conventional.length > 0
}

/* ---------------- 多文件 ROM（Flash 多 SWF 包） ---------------- */

/**
 * 多文件包的存放目录：<前缀>/<platform>/<slug>[.<lang>]
 *
 * 和单文件 ROM 是同一套约定，只是把「<slug>.swf 这个对象」换成「<slug>/ 这个目录」；
 * 按语言分槽时同样带语言后缀，各语言各一个目录，互不覆盖。
 */
export function bundleDirFor(platform: string, slug: string, lang?: RomSlotLang): string {
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

/** 删掉整包前先验证 Worker 确认的 key；旧 Worker 才退回逐文件删除。 */
async function deleteRomBatch(keys: string[]): Promise<boolean> {
  const res = await fetch(`${getRomApi()}/bulk`, {
    method: 'POST',
    headers: { ...authHeaders(), 'Content-Type': 'application/json' },
    body: JSON.stringify({ keys }),
  })
  const data = (await res.json().catch(() => null)) as { ok?: boolean; deleted?: string[]; error?: string } | null
  if (res.status === 404 || res.status === 405 || (res.status === 400 && data?.error?.startsWith('POST 需要'))) return false
  if (!res.ok) throw new Error(data?.error || explainRomStatus(res.status, '整包删除').message)
  const confirmed = new Set(data?.deleted ?? [])
  if (data?.ok !== true || !Array.isArray(data.deleted) || confirmed.size !== keys.length || keys.some((key) => !confirmed.has(key))) {
    throw new Error('Worker 未确认整包删除的全部文件；请刷新 R2 列表核查')
  }
  clearRomProbeCache()
  return true
}

/** 删掉整个包目录（keep 里的 key 保留），返回真正删掉的 key。 */
export async function deleteRomDir(dir: string, keep: string[] = []): Promise<string[]> {
  const removed: string[] = []
  const keepSet = new Set(keep)
  const keys = (await listRomDir(dir)).map((o) => o.key).filter((key) => !keepSet.has(key))
  for (let i = 0; i < keys.length; i += 1000) {
    const batch = keys.slice(i, i + 1000)
    if (batch.length > 1 && await deleteRomBatch(batch)) {
      removed.push(...batch)
      continue
    }
    // 已部署的旧 Worker 没有 /bulk；串行回退确保整包清理仍然能用。
    for (const key of batch) {
      await deleteRom(key)
      removed.push(key)
    }
  }
  return removed
}

/**
 * 只删除调用方已经逐项核验过的 key，不因其中有一个包内文件就重新扫描并删除整个目录。
 * 「解绑并删除」会先把全目录对象纳入全库引用检查；这里若再扩大范围，检查后新上传的兄弟文件
 * 就可能绕过引用保护。批量接口只接收这份精确清单，旧 Worker 则逐个删除。
 */
export async function deleteRomObjectsExactly(keys: string[]): Promise<{ removed: string[]; failed: string[] }> {
  const cfg = getRomConfig()
  if (!cfg.api || !cfg.token) throw new Error('未配置 Worker 地址或口令，无法删除 R2 上的文件')

  const uniqueKeys = [...new Set(keys.map((key) => key.trim()).filter((key) => key && !/^https?:/i.test(key) && !key.startsWith('/')))]
  const removed: string[] = []
  const failed: string[] = []
  for (let i = 0; i < uniqueKeys.length; i += 1000) {
    const batch = uniqueKeys.slice(i, i + 1000)
    if (batch.length > 1) {
      try {
        if (await deleteRomBatch(batch)) {
          removed.push(...batch)
          continue
        }
      } catch {
        // 批量删除失败可能是权限或网络问题，不能改用逐项重试掩盖失败原因。
        failed.push(...batch)
        continue
      }
    }
    for (const key of batch) {
      try {
        await deleteRom(key)
        removed.push(key)
      } catch {
        failed.push(key)
      }
    }
  }
  return { removed, failed }
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
export function romKeysOf(game: Pick<Game, 'rom' | 'roms' | 'romBackups'>): string[] {
  const keys = [game.rom, ...Object.values(game.roms ?? {}), ...Object.values(game.romBackups ?? {})]
    .map((k) => (typeof k === 'string' ? k.trim() : ''))
    .filter(Boolean)
  return [...new Set(keys)]
}

/** 这款游戏是否已经绑定了任意一个 ROM */
export function hasRom(game: Pick<Game, 'rom' | 'roms' | 'romBackups'>): boolean {
  return romKeysOf(game).length > 0
}

/** 把某个对象 key 从游戏上解绑（通用 rom 与所有语言槽都清掉），返回要提交的补丁 */
export function unbindKeyPatch(game: Pick<Game, 'rom' | 'roms' | 'romBackups' | 'romAssets'>, key: string): Partial<Game> {
  const patch: Partial<Game> = {}
  if (game.rom === key) patch.rom = undefined
  const roms = { ...game.roms }
  let touched = false
  for (const [lang, value] of Object.entries(roms)) {
    if (value === key) {
      delete roms[lang]
      touched = true
    }
  }
  if (touched) patch.roms = Object.keys(roms).length ? roms : undefined
  const romAssets = { ...game.romAssets }
  let assetsTouched = false
  for (const [lang, value] of Object.entries(game.roms ?? {})) {
    if (value === key && Object.prototype.hasOwnProperty.call(romAssets, lang)) {
      delete romAssets[lang]
      assetsTouched = true
    }
  }
  if (assetsTouched) patch.romAssets = Object.keys(romAssets).length ? romAssets : {}
  const romBackups = { ...game.romBackups }
  let backupTouched = false
  for (const [lang, value] of Object.entries(romBackups)) {
    if (value === key) {
      delete romBackups[lang]
      backupTouched = true
    }
  }
  if (backupTouched) patch.romBackups = Object.keys(romBackups).length ? romBackups : undefined
  return patch
}

/**
 * 这款游戏到底绑了哪几种语言的 ROM（内置槽按固定顺序，自定义槽随后按代码排序）。
 * 播放器用它决定要不要显示「切换 ROM 语言」——只有一种语言时没什么可切的。
 */
export function romLangsOf(game: Pick<Game, 'roms'>): RomSlotLang[] {
  const roms = game.roms ?? {}
  const present = new Set(Object.entries(roms).filter(([, value]) => typeof value === 'string' && value.trim()).map(([code]) => code))
  const builtinCodes = new Set<string>(ROM_LANGS)
  return [...ROM_LANGS.filter((code) => present.has(code)), ...[...present].filter((code) => !builtinCodes.has(code)).sort()]
}

/** 某个 key 属于哪个语言槽；不属于任何语言槽（通用 rom / 约定 key）时返回 undefined */
export function romLangOfKey(game: Pick<Game, 'roms'>, key: string): RomSlotLang | undefined {
  if (!key) return undefined
  return Object.entries(game.roms ?? {}).find(([, value]) => value === key)?.[0]
}

export interface RomCandidate {
  key: string
  /** 通用 rom 没有语言槽，所以这里可能为空 */
  lang?: RomSlotLang
  /** true 表示同一语言槽的备用地址；启动入口等设置仍跟随 lang。 */
  backup?: boolean
  /** 数据库仍绑旧 key，但播放器先尝试旁边的 `<key>.8bg`；便于整库原地渐进迁移。 */
  derivedPacked?: boolean
}

/** 网络类失败本来会停止整条回退链；唯一例外是紧跟主地址的同语言备用源。 */
export function shouldTryRomCandidateAfterUncertain(current: RomCandidate, next?: RomCandidate): boolean {
  // 明文原件和旁边派生的 .8bg 是同一个对象的两种形态，必须当成一组：一个问不出来时仍给另一个机会，
  // 否则渐进迁移期间一次 HEAD / CORS 波动就可能挡住尚未转换或已经转换的游戏。
  if (
    next
    && (current.derivedPacked || next.derivedPacked)
    && current.lang === next.lang
    && current.backup === next.backup
  ) return true
  return !current.backup && Boolean(next?.backup && next.lang === current.lang)
}

/** 运行期失败后只往后走，绝不能又选回已经失败的主包形成重启死循环。 */
export function nextRomCandidateKey(keys: readonly string[], current: string, failed: ReadonlySet<string>): string | undefined {
  const at = keys.indexOf(current)
  return at < 0 ? undefined : keys.slice(at + 1).find((key) => !failed.has(key))
}

/**
 * 回退链靠前的那几个：英语和日语多半就是原版，简繁互为对方最好的替代。
 *
 * 只是**优先级**，不是全集 —— ROM_LANGS 与游戏自身的自定义槽由下面 romCandidates 一起兜底。
 */
const FALLBACK_PRIORITY: RomSlotLang[] = ['en', 'ja', 'zh-Hans', 'zh-Hant']

/**
 * 按语言列出 ROM 候选：每个语言的主地址 → 同语言备用地址，然后才到下一种语言；
 * 语言顺序是当前语言 → 英语 → 日语 → 简体 → 繁体 → 其余内置和自定义槽 → 旧版通用 rom。
 *
 * 两个中文槽都在回退里，是因为后台允许分别上传简繁版本；不能因为简体槽为空，
 * 就在繁体槽明明有文件时误报「没有当前语言版本」。同一个 key 只保留第一次出现，
 * 避免管理员把多个语言槽绑到同一个对象时重复发 HEAD 请求。
 *
 * prefer 是玩家在播放器里手动选的语言，优先级最高；后面的回退仍保留，防止所选槽
 * 对应的 R2 对象后来被删掉时，播放器直接变成不可用。
 *
 * ⚠️ 内置槽和游戏已有的自定义槽都要接到回退链。这里原本是手写的五项
 * `[requested, 'en', 'ja', 'zh-Hans', 'zh-Hant']`，而 ROM_LANGS 有八项 ——
 * fr / de / es / it 四个槽**永远不会被当作回退**。后果是：一款游戏只传了西语版
 * （超级玛丽兄弟的 es 槽就是这么来的），站点语言又不是西语时，界面报
 * 「游戏没有当前语言版本」，而那个 ROM 明明就躺在 R2 上。
 * 所以从 ROM_LANGS 和游戏实际绑定的槽派生，后台自定义语言也会自然进入回退链。
 */
export function romCandidates(game: Pick<Game, 'rom' | 'roms' | 'romBackups'>, lang: Lang, prefer?: RomSlotLang | null): RomCandidate[] {
  const requested = prefer ?? romLangFor(lang)
  const order: RomSlotLang[] = [requested, ...FALLBACK_PRIORITY, ...ROM_LANGS, ...Object.keys(game.roms ?? {}).sort()]
  const candidates: RomCandidate[] = []
  const seen = new Set<string>()

  for (const candidateLang of order) {
    const key = game.roms?.[candidateLang]?.trim()
    if (key && !seen.has(key)) {
      seen.add(key)
      candidates.push({ key, lang: candidateLang })
    }
    // 备用必须紧跟自己的主地址，保证“同语言切源”优先于跨语言回退。
    const backup = game.romBackups?.[candidateLang]?.trim()
    if (backup && !seen.has(backup)) {
      seen.add(backup)
      candidates.push({ key: backup, lang: candidateLang, backup: true })
    }
  }

  // game.rom 是旧数据里的无语言版本；继续兼容，避免升级后让原本能玩的游戏消失。
  const generic = game.rom?.trim()
  if (generic && !seen.has(generic)) candidates.push({ key: generic })
  return candidates
}

/**
 * 真正用于播放探测的候选。明文原件优先，旧 8BG 仍是后备；完整外链不擅自改 URL，
 * 流式光盘 / HTML5 也明确不走浏览器解包。
 */
export function playbackRomCandidates(game: Pick<Game, 'platform' | 'rom' | 'roms' | 'romBackups' | 'runtime'>, lang: Lang, prefer?: RomSlotLang | null): RomCandidate[] {
  const raw = romCandidates(game, lang, prefer)
  // Play! 的 System 2x6 包必须保持普通 ZIP；加密成 8BG 后 libchdr 无法按随机访问读取 CHD。
  if (game.platform === 'arcade' && game.runtime === 'play') return raw
  // PS1 后台允许显式绑定旧 8BG，但不能从裸 CHD/ISO 再派生 `.8bg` 地址：
  // 新上传的原始 CHD 必须直接命中，否则会先请求不存在的 `.chd.8bg`，还会绕过 Range 流式读取。
  if (game.platform === 'html5') {
    // 旧数据里可能只填了裸域名；规范成网页地址后直接交给 iframe，避免被拼成 download.8bitgo.com 的 ROM key。
    return raw
      .map((candidate) => ({ ...candidate, key: normalizeHtml5Entry(candidate.key) }))
      .filter((candidate) => !html5EntryProblem(candidate.key))
  }
  if (isStreamingDiscPlatform(game.platform) || game.platform === 'psx') return raw
  const out: RomCandidate[] = []
  const seen = new Set<string>()
  for (const candidate of raw) {
    if (!seen.has(candidate.key)) {
      seen.add(candidate.key)
      out.push(candidate)
    }
    if (!selfContainedKey(candidate.key) && !isRomPackUrl(candidate.key)) {
      const packed = romPackKey(candidate.key)
      if (!seen.has(packed)) {
        seen.add(packed)
        out.push({ ...candidate, key: packed, derivedPacked: true })
      }
    }
  }
  return out
}

/**
 * 播放器里的语言下拉是一次明确选择，不是“站点语言偏好”。
 *
 * 自动选语言时仍保留完整回退链，让只有西语 ROM 的游戏在中文站点也能玩；玩家亲手点了
 * 日本語之后则只允许日语主地址 / 备用地址。否则日语对象恰好 404 时会静默启动英语版，
 * 播放器却提示“已换成日本語版本”—— 对 PSP 这种地区版状态不兼容的平台尤其危险。
 */
export function playbackRomCandidatesForSelection(
  game: Pick<Game, 'platform' | 'rom' | 'roms' | 'romBackups' | 'runtime'>,
  lang: Lang,
  prefer?: RomSlotLang | null,
): RomCandidate[] {
  const candidates = playbackRomCandidates(game, lang, prefer)
  return prefer ? candidates.filter((candidate) => candidate.lang === prefer) : candidates
}

/** 返回语言回退链里的第一个候选；实际播放会继续探测后续候选是否存在。 */
export function effectiveRomKey(game: Game, lang: Lang, prefer?: RomSlotLang | null): string {
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
export function defaultRomKeyForLang(platform: string, slug: string, lang: RomSlotLang, fileName: string): string {
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
/*
  已完成结论和在途请求必须分开存。

  播放器的请求带 AbortSignal：切游戏 / 切语言时必须真取消，不能复用一条无法由当前页面
  控制的共享 Promise；后台批量检查不带 signal，仍可合并同 URL 的并发 HEAD，避免重复打 R2。
  只有 certain=true 才进 probeResults，网络抖动永远不会被钉死在整个 SPA 会话里。
*/
const probeResults = new Map<string, { outcome: ProbeOutcome; expiresAt: number }>()
/**
 * 部分结论只短期有效：主地址这次没问出来、由备用域名探到的结论（无论「存在」还是「没有」）。
 * 主域可能只是一次瞬时超时；把备用域的地址当成主地址的结论记满整个 SPA 会话，
 * 之后每一局都绕开已经恢复的主域。到期后重新问一次主地址。
 */
/** 备用域结论的有效期（毫秒） */
export const ALTERNATE_PROBE_TTL_MS = 5 * 60_000
/** 对象可在同一 key 覆盖；成功探测的 ETag 不能在长驻页面里永久有效。 */
export const ROM_PROBE_SUCCESS_TTL_MS = 5 * 60_000
/** 刚上传或恢复的对象应尽快从旧 404 中恢复出来。 */
export const ROM_PROBE_MISS_TTL_MS = 60_000
/** 单页长时间浏览不同游戏时，探测结论不能随着唯一 ROM 地址无限增长。 */
export const ROM_PROBE_CACHE_MAX_ENTRIES = 512
const probeInflight = new Map<string, Promise<ProbeOutcome>>()
/** 清缓存时让更早启动、但更晚返回的 HEAD 失去写回资格，避免旧 404 覆盖刚上传的新对象。 */
let probeCacheGeneration = 0

/** 写入并维持有界 LRU；淘汰只影响下次 HEAD，不会改变 ROM 选择或下载完整性。 */
function rememberProbeResult(cacheKey: string, outcome: ProbeOutcome, expiresAt: number): void {
  probeResults.delete(cacheKey)
  probeResults.set(cacheKey, { outcome, expiresAt })
  while (probeResults.size > ROM_PROBE_CACHE_MAX_ENTRIES) {
    const oldestKey = probeResults.keys().next().value
    if (oldestKey === undefined) break
    probeResults.delete(oldestKey)
  }
}

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
  reason?: 'http' | 'html' | 'network' | 'timeout' | 'aborted'
  /** reason === 'http' 时服务器给的状态码 */
  status?: number
  /**
   * 外层文件字节数：优先使用 HEAD 的 Content-Length；GET Range 兜底只读取 Content-Range 的总长，
   * 绝不把 206 的 Content-Length（通常只有 1 字节）误当整份文件大小。
   * 这是外层对象大小：`.8bg` / ZIP 压缩参数会改变它，不能拿来判断内层 ROM 的模拟器兼容性。
   * 保留该字段供下载提示、诊断和其它确实需要传输体积的界面使用。
   */
  size?: number
}

/**
 * 这些状态码是服务器给出的**答复**：对象就是不在，再问一百次也一样，可以放心缓存。
 * 反过来 5xx、429 和连不上都属于「没问出结果」，必须留给下一次重新问。
 */
const DEFINITE_MISS_STATUS = new Set([400, 401, 403, 404, 405, 410, 451])

/**
 * 把对象的 ETag 写进播放地址，给浏览器 HTTP 缓存和 IndexedDB 缓存换 key。
 *
 * R2 允许覆盖同一个对象 key；若播放地址永远不变，两个缓存都会继续交出旧 ROM。
 * ETag 随对象内容变化，既不会让没更新的 ROM 重复下载，也不依赖人工清缓存。
 * 外站 ZIP 例外：ETag 写在 fragment，避免改动可能带签名的第三方查询串。
 */
export function versionedRomUrl(url: string, etag: string | null): string {
  // replaceAll 在旧 Safari / 电视 WebView 不存在；正则在这里语义完全相同。
  const version = etag?.replace(/^W\//, '').replace(/"/g, '').trim()
  if (!version) return url
  if (romArchiveRef(url)) {
    // 外站签名 URL 常不容许加查询参数；版本只写在浏览器不会发出的 fragment 里。
    return `${url}${url.endsWith('#') ? '' : '&'}romv=${encodeURIComponent(version)}`
  }
  // fragment 是本站的解包指令；版本号必须插在它前面，才会成为真正的 URL 查询参数。
  const hashAt = url.indexOf('#')
  const address = hashAt < 0 ? url : url.slice(0, hashAt)
  const fragment = hashAt < 0 ? '' : url.slice(hashAt)
  const separator = address.includes('?') ? '&' : '?'
  return `${address}${separator}romv=${encodeURIComponent(version)}${fragment}`
}

/** 探一次。区分「没有」和「没问出来」，后者留给上层重试 */
async function probeOnce(
  url: string,
  timeoutMs: number,
  allowHtml: boolean,
  parentSignal?: AbortSignal,
): Promise<ProbeOutcome> {
  const ctrl = new AbortController()
  let timedOut = false
  const abortFromParent = () => ctrl.abort()
  if (parentSignal?.aborted) ctrl.abort()
  else parentSignal?.addEventListener('abort', abortFromParent, { once: true })
  const timer = window.setTimeout(() => {
    timedOut = true
    ctrl.abort()
  }, timeoutMs)
  try {
    // no-store 很关键：这里正是为了发现「同一个 URL 的对象内容已经换了」，
    // 若 HEAD 自己也吃浏览器缓存，就永远读不到新的 ETag。
    let res: Response
    let usedRangeFallback = false
    const archive = romArchiveRef(url)
    try {
      res = await fetch(url, { method: 'HEAD', cache: 'no-store', signal: ctrl.signal })
      if (archive && [403, 405, 501].includes(res.status)) {
        // 有些文件站只准 GET，HEAD 的 403/405 不等于文件不存在。只取第一字节作探测。
        usedRangeFallback = true
        res = await fetch(archive.sourceUrl, {
          method: 'GET', headers: { Range: 'bytes=0-0' }, cache: 'no-store', signal: ctrl.signal,
        })
        void res.body?.cancel().catch(() => {})
      }
    } catch (error) {
      if (!archive || ctrl.signal.aborted) throw error
      // HEAD 的 CORS 权限也可能单独缺失；GET 能不能读由浏览器的 CORS 判定。
      usedRangeFallback = true
      res = await fetch(archive.sourceUrl, {
        method: 'GET', headers: { Range: 'bytes=0-0' }, cache: 'no-store', signal: ctrl.signal,
      })
      void res.body?.cancel().catch(() => {})
    }
    if (!res.ok) return { url: '', certain: DEFINITE_MISS_STATUS.has(res.status), reason: 'http', status: res.status }
    // 地址配错时请求会落到本站的 SSR 兜底路由上，那边对任何路径都回 200 + HTML。
    // 只看 res.ok 的话会误判成「ROM 存在」，页面显示「即点即玩」，
    // 点下去才在模拟器里报一句莫名其妙的「不是合法的 ROM」。
    const type = res.headers.get('content-type') || ''
    if (!allowHtml && /text\/html|application\/xhtml/i.test(type)) return { url: '', certain: true, reason: 'html' }
    const len = Number(res.headers.get('content-length'))
    let size = Number.isFinite(len) && len > 0 ? len : undefined
    if (usedRangeFallback) {
      if (res.status === 206) {
        // 206 的 Content-Length 只是 Range 片段长度（通常为 1），只有 Content-Range 尾部才是整份 ZIP 大小。
        const total = /^bytes\s+0-\d+\/(\d+)\s*$/i.exec(res.headers.get('content-range') || '')?.[1]
        size = total ? Number(total) : undefined
      } else if (res.status !== 200) {
        size = undefined
      }
      // 200 表示文件站忽略了 Range；此时 Content-Length 描述完整响应，仍可用于大小估算。
    }
    return {
      url: versionedRomUrl(url, res.headers.get('etag')),
      certain: true,
      size: Number.isFinite(size) && (size ?? 0) > 0 ? size : undefined,
    }
  } catch {
    // 超时（abort）、断网、CORS 被拒、被浏览器插件拦掉，全都是「没问出来」。
    // fetch 对这几种一律抛一个不带信息的 TypeError（CORS 的细节只在控制台里，
    // 脚本读不到），所以只能靠 signal 把「超时」这一种单独认出来。
    const reason = timedOut ? 'timeout' : parentSignal?.aborted ? 'aborted' : 'network'
    return { url: '', certain: false, reason }
  } finally {
    window.clearTimeout(timer)
    parentSignal?.removeEventListener('abort', abortFromParent)
  }
}

/** 一条线路这次的答复写进线路记分板：答上来算成功，网络层失败 / 超时 / 5xx 算线路故障 */
function noteProbeRoute(route: string, outcome: ProbeOutcome, signal?: AbortSignal): void {
  if (outcome.url || outcome.reason === 'html' || (outcome.reason === 'http' && outcome.certain)) {
    recordRomRouteSuccess(route)
  } else if (outcome.reason === 'timeout') {
    recordRomRouteFailure(route, 'timeout')
  } else if (outcome.reason === 'network' && !signal?.aborted) {
    recordRomRouteFailure(route, 'network')
  } else if (outcome.reason === 'http' && ((outcome.status ?? 0) >= 500 || outcome.status === 429)) {
    recordRomRouteFailure(route, 'server')
  }
}

/** 第一条线路这么久还没答复，就同时问下一条（毫秒） */
export const ROM_PROBE_HEDGE_MS = 1000

/**
 * 几条线路问同一个对象在不在：按记分板排好的顺序先问第一条，ROM_PROBE_HEDGE_MS 内没答复、
 * 或答复不算数（超时 / 断网 / 5xx），立即追问下一条；谁先答「在」用谁，其余立刻中止。
 *
 * 为什么（2026-11-18《西游释厄传》浏览器实测）：rom.8bitgo.com 的 HEAD 等满 4 秒超时，才轮到
 * download.8bitgo.com，后者 0.17 秒就回了。逐条串行时最坏要 3 × 4 秒；现在约 1 秒 + 最快那条。
 *
 * 结论的分量不对称：
 *   - 调用方给的原地址答「没有」（404 等）就是最终结论，和以前一样；
 *   - 备用线路答「没有」先记着，等其余线路都答完、谁也没答「在」才用它。几条线路读同一个 R2 桶，
 *     本来不该有分歧；但万一某条线路的 Worker 配置落后，一条线路的 404 不能抢在原地址的答复前面定案。
 */
async function hedgedProbe(
  url: string,
  alternates: readonly string[],
  timeoutMs: number,
  allowHtml: boolean,
  signal?: AbortSignal,
): Promise<{ outcome: ProbeOutcome; route: string }> {
  const routes = rankRomRoutes([url, ...alternates])
  if (routes[0] !== url) {
    diagLog('download', 'info', `ROM 存在性检查：${romRouteOrigin(url)} 近期不稳定，先问 ${romRouteOrigin(routes[0])}`)
  }
  return new Promise((resolve) => {
    const controllers: AbortController[] = []
    const results: Array<ProbeOutcome | undefined> = []
    let launched = 0
    let settled = false
    let hedgeTimer = 0
    const finish = (outcome: ProbeOutcome, route: string) => {
      if (settled) return
      settled = true
      window.clearTimeout(hedgeTimer)
      signal?.removeEventListener('abort', onAbort)
      for (const controller of controllers) controller.abort()
      resolve({ outcome, route })
    }
    function onAbort() {
      finish({ url: '', certain: false, reason: 'aborted' }, url)
    }
    const settleIfDone = () => {
      if (settled || launched < routes.length || results.filter(Boolean).length < routes.length) return
      const primaryIndex = routes.indexOf(url)
      const primary = results[primaryIndex]!
      if (primary.certain) return finish(primary, url)
      const certainIndex = results.findIndex((outcome) => outcome?.certain)
      if (certainIndex >= 0) return finish(results[certainIndex]!, routes[certainIndex])
      finish(primary, url)
    }
    const launch = () => {
      if (settled || launched >= routes.length) return
      const index = launched++
      const route = routes[index]
      const controller = new AbortController()
      controllers.push(controller)
      window.clearTimeout(hedgeTimer)
      if (launched < routes.length) hedgeTimer = window.setTimeout(launch, ROM_PROBE_HEDGE_MS)
      void probeOnce(route, timeoutMs, allowHtml, controller.signal).then((outcome) => {
        // 被我们自己中止的输家（别的线路已经答了）不算这条线路的错，也不再参与结论
        if (settled) return
        noteProbeRoute(route, outcome, controller.signal)
        results[index] = outcome
        if (outcome.url) {
          if (route !== url) diagLog('download', 'info', `ROM 存在性检查：${romRouteOrigin(route)} 先答复，改用它`)
          return finish(outcome, route)
        }
        if (outcome.certain && route === url) return finish(outcome, route)
        // 这条答不上来（或备用线路说没有）：不等对冲延时，立即问下一条
        launch()
        settleIfDone()
      })
    }
    if (signal?.aborted) return onAbort()
    signal?.addEventListener('abort', onAbort, { once: true })
    launch()
  })
}

export interface ProbeRomOptions {
  /** 页面离开时终止真实网络请求，而不是只丢弃 setState。 */
  signal?: AbortSignal
  /** 默认保留后台调用的一次快速重试；播放器已有外层退避，必须关掉避免重试套重试。 */
  retry?: boolean
}

/** 可被 AbortSignal 打断的短退避；取消后不能再悄悄发第二个 HEAD。 */
function waitForProbeRetry(signal?: AbortSignal): Promise<boolean> {
  if (signal?.aborted) return Promise.resolve(false)
  return new Promise((resolve) => {
    let settled = false
    const done = (ready: boolean) => {
      if (settled) return
      settled = true
      window.clearTimeout(timer)
      signal?.removeEventListener('abort', abort)
      resolve(ready)
    }
    const abort = () => done(false)
    const timer = window.setTimeout(() => done(true), 300)
    signal?.addEventListener('abort', abort, { once: true })
  })
}

/**
 * HEAD 探测 ROM，并把内容 ETag 带回播放 URL。
 *
 * 默认调用没问出结论时当场重试一次（隔 300ms，躲开瞬时抖动）；播放器必须传
 * `retry:false`，因为 useRomUrl 已有跨轮退避。网络失败不进结论缓存，下次会真的重新发请求。
 */
export function probeRom(
  url: string,
  timeoutMs = 4000,
  allowHtml = false,
  options: ProbeRomOptions = {},
): Promise<ProbeOutcome> {
  // 同一个 URL 作为 ROM 时必须拒绝 HTML，作为 HTML5 入口时又必须接受；缓存键要把两种语义分开。
  const cacheKey = `${allowHtml ? 'html' : 'rom'}:${url}`
  const cached = probeResults.get(cacheKey)
  if (cached) {
    if (Date.now() >= cached.expiresAt) {
      probeResults.delete(cacheKey)
    } else {
      // 热门游戏复访时保留在缓存尾部，优先淘汰长期未访问的旧地址。
      probeResults.delete(cacheKey)
      probeResults.set(cacheKey, cached)
      return Promise.resolve(cached.outcome)
    }
  }
  // 带 signal 的请求归当前页面所有，不能和别的页面共享生命周期；无 signal 的后台检查仍合并在途请求。
  if (!options.signal) {
    const inflight = probeInflight.get(cacheKey)
    if (inflight) return inflight
  }

  const generation = probeCacheGeneration
  const run = async () => {
    /** 结论是不是来自备用域（主地址这一轮没问出来） */
    let viaAlternate = false
    const probeCandidates = async (): Promise<ProbeOutcome> => {
      viaAlternate = false
      const alternates = alternateRomUrls(url)
      if (!alternates.length) {
        const outcome = await probeOnce(url, timeoutMs, allowHtml, options.signal)
        noteProbeRoute(url, outcome, options.signal)
        return outcome
      }
      const { outcome, route } = await hedgedProbe(url, alternates, timeoutMs, allowHtml, options.signal)
      viaAlternate = route !== url
      return outcome
    }
    let outcome = await probeCandidates()
    if (!outcome.certain && outcome.reason !== 'aborted' && options.retry !== false) {
      const ready = await waitForProbeRetry(options.signal)
      if (ready) outcome = await probeCandidates()
    }
    // 上传 / 删除 / 手动重试可能在 HEAD 飞行期间清过缓存；旧请求回来后不能把旧结论塞回去。
    if (outcome.certain && generation === probeCacheGeneration) {
      const ttl = viaAlternate
        ? ALTERNATE_PROBE_TTL_MS
        : outcome.url
          ? ROM_PROBE_SUCCESS_TTL_MS
          : ROM_PROBE_MISS_TTL_MS
      rememberProbeResult(cacheKey, outcome, Date.now() + ttl)
    }
    return outcome
  }
  const promise = run()
  if (!options.signal) {
    probeInflight.set(cacheKey, promise)
    void promise.finally(() => {
      if (probeInflight.get(cacheKey) === promise) probeInflight.delete(cacheKey)
    })
  }
  return promise
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
  probeCacheGeneration += 1
  if (!urls) {
    probeResults.clear()
    probeInflight.clear()
    return
  }
  for (const url of urls) {
    probeResults.delete(`rom:${url}`)
    probeResults.delete(`html:${url}`)
    probeInflight.delete(`rom:${url}`)
    probeInflight.delete(`html:${url}`)
  }
}

/** 后台只关心对象是否存在；播放器才需要上面的版本化 URL。 */
export async function probeUrl(url: string, timeoutMs = 4000): Promise<boolean> {
  return Boolean(await probeRomUrl(url, timeoutMs))
}

export interface RomResolution {
  status: 'idle' | 'checking' | 'found' | 'missing'
  url: string
  /** ROM 字节数（来自探测时的 HEAD Content-Length）；播放器按它分流引擎，没有就是未知 */
  size?: number
  key?: string
  /** 用的是哪个语言槽。通用 rom 和约定 key 探测出来的没有语言，为 undefined */
  lang?: RomSlotLang
  /**
   * missing 的原因是「**没问出来**」（超时 / 断网 / CORS / 5xx），不是服务器说没有。
   *
   * 两者对玩家是完全不同的两件事：真没有就该去挑别的语言或本地文件，
   * 而读不到只是这会儿的事，等一等或者换个网就好了。文案要分开说。
   */
  unreachable?: boolean
  /** 重新探测一遍，并先把这款游戏所有候选地址的缓存结论清掉 */
  retry: () => void
  /**
   * 文件存在但实际下载、解密或启动失败时跳过当前对象，继续探下一个候选。
   * 返回 true 表示已经接管；播放器应等待新的 url，而不是继续显示当前文件的错误。
   */
  failover: (reason?: string, scope?: RomFailoverScope) => boolean
}

/**
 * failover 的失败性质。'network' = 下载器重试和备用线路都用完的网络层失败（断网、连接重置、卡死）：
 * 换别的语言走的是同一条网络，只会把整条语言链逐个白下一遍（AGENTS §2.35），
 * 所以只允许切到**同一语言槽**里还没试过的地址（备用源、派生包 / 原包）。其余按内容错误处理，照旧走整条链。
 */
export type RomFailoverScope = 'content' | 'network'

/**
 * 纯函数：当前 key 失败后下一个该试的 key。network 只在同语言槽里找
 * （通用 rom 的 lang 为 undefined，和它的备用源同样相等）。
 */
export function nextFailoverKey(
  chain: ReadonlyArray<{ key: string; lang?: RomSlotLang }>,
  failed: ReadonlySet<string>,
  current: { key: string; lang?: RomSlotLang },
  scope: RomFailoverScope = 'content',
): string | undefined {
  if (scope === 'network') {
    return chain.find((entry) => entry.lang === current.lang && !failed.has(entry.key))?.key
  }
  return chain.find((entry) => !failed.has(entry.key))?.key
}

/** 启动入口必须跟随实际命中的语言槽；多个槽共用同一 ZIP 时不能靠对象 key 反推语言。 */
export function dosExecutableForRom(
  game: Pick<Game, 'dosExecutable' | 'dosExecutables'>,
  rom: Pick<RomResolution, 'lang'>,
): string | undefined {
  return (rom.lang ? game.dosExecutables?.[rom.lang] : undefined) || game.dosExecutable
}

/** 命令跟随实际命中的语言槽；主备地址切换仍使用同一语言的配置。 */
export function dosStartupCommandsForRom(
  game: Pick<Game, 'dosStartupCommands'>,
  rom: Pick<RomResolution, 'lang'>,
): string | undefined {
  return rom.lang ? game.dosStartupCommands?.[rom.lang] : undefined
}

/**
 * 流式游戏盘必须跟着最终探测成功的 ROM 语言走，而不是跟着界面语言猜。
 * 主地址坏掉并回退到英文 ROM 时，这里也会切到英文盘。只要已经出现任意逐语言配置，
 * 未配置的语言就回退完整包而不是旧全局盘，避免“迁移了一半”时误挂另一语言内容；只有完全没有
 * 逐语言配置的历史数据才继续使用全局盘。
 */
export function dosSockdriveForRom(
  game: Pick<Game, 'dosSockdrive' | 'dosSockdrives'>,
  rom: Pick<RomResolution, 'lang'>,
): string | undefined {
  if (!rom.lang) return game.dosSockdrive
  const languageSockdrive = game.dosSockdrives?.[rom.lang]
  if (languageSockdrive) return languageSockdrive
  if (Object.values(game.dosSockdrives ?? {}).some(Boolean)) return undefined
  return game.dosSockdrive
}

/**
 * 已经绑定静态 Sockdrive 的 Windows / DOS 游戏不需要先证明那份“整包回退”也能访问。
 *
 * 流式模式开局只读 Sockdrive 元数据和实际命中的磁盘块，`jsdos.ts` 会在挂盘前严格校验它；
 * 此时再对 1GB 以上的 `.8bg` 回退包做跨域 HEAD，不但没有运行价值，弱网下还会把开始按钮
 * 锁住四轮超时。这里仍从正常语言候选链选盘，确保繁体 ROM 只会配繁体 Sockdrive；玩家手动
 * 指定了一个尚未迁移的语言时则返回空，继续走整包探测，不能偷偷挂到另一种语言的磁盘。
 */
export function streamedRomCandidateForSelection(
  game: Pick<Game, 'platform' | 'dosBackend' | 'dosSockdrive' | 'dosSockdrives' | 'rom' | 'roms' | 'romBackups'>,
  lang: Lang,
  prefer?: RomSlotLang | null,
): RomCandidate | undefined {
  if (game.platform !== 'dos' || game.dosBackend !== 'dosboxX') return undefined
  return playbackRomCandidatesForSelection(game, lang, prefer)
    .find((candidate) => Boolean(dosSockdriveForRom(game, { lang: candidate.lang })))
}

/** 配置足够时直接给播放器一个会话标识；真实盘仍由 js-dos 启动校验，不在这里乐观判成功。 */
function configuredStreamedRom(
  game: Game | undefined,
  lang: Lang,
  prefer?: RomSlotLang | null,
): Omit<RomResolution, 'retry' | 'failover'> | null {
  if (!game) return null
  const candidate = streamedRomCandidateForSelection(game, lang, prefer)
  if (!candidate) return null
  const sockdrive = dosSockdriveForRom(game, { lang: candidate.lang })
  const url = romUrlForKey(candidate.key)
  // 两个相对 key 都依赖资源根地址；任意一个拼不出 URL 就按原流程给出配置诊断。
  if (!sockdrive || !url || !romUrlForKey(sockdrive)) return null
  return { status: 'found', url, key: candidate.key, lang: candidate.lang }
}

/**
 * 「没问出来」时自动重试的退避节奏（毫秒）。
 *
 * 为什么要自动重试：探测失败最常见的原因是网络抖一下、或者切后台时请求被掐掉，
 * 而这时候界面会一路掉到「游戏没有当前语言版本」—— ROM 明明好好躺在 R2 上。
 * 让玩家自己去点「重新检查」是把我们的问题推给他。
 *
 * 两次、由密到疏；播放器每轮只发一次 HEAD，不再和 probeRom 自己的重试叠成指数等待。
 * 最坏约 14 秒（3 × 4 秒探测 + 2.4 秒退避），期间状态保持 checking，不会先闪错误。
 * 确定性的失败（404）一次都不重试 —— 问一百次也一样。
 */
const AUTO_RETRY_DELAYS = [600, 1800]

/** 一个候选探完之后留下的痕迹，只为诊断 */
interface ProbeTrace {
  key: string
  url: string
  outcome: ProbeOutcome
  lang?: RomSlotLang
  backup?: boolean
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
function reportProbeFailure(
  game: Pick<Game, 'slug' | 'platform'>,
  traces: ProbeTrace[],
  unreachable: boolean,
  networkLocked = false,
) {
  const base = getRomBase()
  const overridden = Boolean(readLocal(ROM_BASE_KEY))
  const lines = traces.map(({ key, url, outcome, lang, backup }) => {
    const why = outcome.reason === 'http' ? `HTTP ${outcome.status}` : (outcome.reason ?? '未知')
    const slot = lang ? `${lang}${backup ? ' 备用' : ' 主地址'}` : '通用地址'
    return `  ${outcome.certain ? '确定没有' : '没问出来'}（${why}，${slot}）  ${key}\n    ${url}`
  })
  console.warn(
    [
      `[8bitgo/rom] ${game.slug}（${game.platform}）所有候选都没探到，界面会显示「${unreachable ? '暂时读取不到 ROM' : '没有当前语言版本'}」。`,
      `根地址：${base || '(空)'}${overridden ? `  ⚠️ 来自 localStorage['${ROM_BASE_KEY}']，不是构建时的 VITE_ROM_BASE_URL` : ''}`,
      traces.length ? '候选：' : '候选：(一个都没有 —— 后台没绑过语言槽，约定文件名也没探到)',
      ...lines,
      ...(networkLocked
        ? ['同语言主地址在真实加载时网络失败，后续几轮仍问不到：按网络 / 线路问题处理，不代表 ROM 缺失。']
        : []),
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
export function useRomUrl(game: Game | undefined, prefer?: RomSlotLang | null): RomResolution {
  const lang = useLang()
  /*
    SSR 阶段不会运行 effect，但只要待会儿会去探（显式绑定 **或**约定 key，见
    romProbeExpected），我们此刻就已经知道「有在线版本，正在准备地址」。
    初始态直接设 checking，避免搜索引擎和首屏用户先看到「选择本地 ROM」，
    水合后又突然变成「开始游戏」这种自相矛盾的文案。
  */
  const [state, setState] = useState<Omit<RomResolution, 'retry' | 'failover'>>(() =>
    configuredStreamedRom(game, lang, prefer) ?? {
      status: romProbeExpected(game, lang, prefer) ? 'checking' : 'idle',
      url: '',
    },
  )
  const [attempt, setAttempt] = useState(0)
  /** 这一轮已经自动重试过几次。换游戏 / 换语言 / 玩家手动重试都要清零 */
  const autoRetries = useRef(0)
  /** HEAD 成功但实际内容坏掉的 key。只在本次游戏/语言选择内跳过；手动重试会清空。 */
  const runtimeFailures = useRef(new Set<string>())
  /** 加速镜像在真实加载里失败过：本次游戏/语言选择内不再测速，直接回主域。 */
  const mirrorFailed = useRef(false)
  /**
   * 网络层失败后的语言锁：failover 只挑了同语言槽的备用源，但真正选中哪个地址是下一轮 HEAD 决定的 ——
   * 备用源若 HEAD 404，按原逻辑会一路走到别的语言组，等于绕过了「网络失败不换语言」（AGENTS §2.35）。
   * 锁住后下一轮只探这个语言组；探不到就停在「暂时读取不到」，联网事件时解锁重来。
   */
  const networkLangLock = useRef<{ lang: RomSlotLang | undefined } | null>(null)
  /** 因网络失败被跳过的 key：网络恢复后要还给候选链，它们不是坏文件。 */
  const networkFailedKeys = useRef(new Set<string>())
  /** 把网络失败跳过的 key 还给候选链：它们不是坏文件，下一轮必须重新问一次。 */
  const releaseNetworkFailedKeys = useCallback(() => {
    for (const key of networkFailedKeys.current) runtimeFailures.current.delete(key)
    networkFailedKeys.current.clear()
  }, [])

  /**
   * 重试。先清掉这款游戏所有候选地址的探测结论 —— 否则「服务器明确说没有」那一类
   * 是会被缓存的（本该如此），可玩家点重试的场景恰恰就是「刚传上去 / 刚改完绑定」，
   * 不清就等于按了个没用的按钮。
   */
  const retry = useCallback(() => {
    if (game) {
      const keys = [...playbackRomCandidatesForSelection(game, lang, prefer).map((c) => c.key), ...conventionalKeys(game)]
      clearRomProbeCache(keys.map((key) => romUrlForKey(key)).filter(Boolean))
    }
    runtimeFailures.current.clear()
    mirrorFailed.current = false
    networkLangLock.current = null
    networkFailedKeys.current.clear()
    autoRetries.current = 0
    setAttempt((n) => n + 1)
  }, [game, lang, prefer])

  const failover = useCallback((reason?: string, scope: RomFailoverScope = 'content'): boolean => {
    if (!game || state.status !== 'found' || !state.key) return false
    /*
      镜像坏了不等于这个 ROM 坏了：同一个对象回主域再来一次，不能把 key 记进失败集，
      否则会跳去备用源 / 别的语言，甚至报「没有这个版本」。
    */
    const mirror = getRomMirrorBase()
    if (mirror && state.url.startsWith(`${mirror}/`) && !mirrorFailed.current) {
      mirrorFailed.current = true
      console.warn(`[8bitgo/rom] ${game.slug} 走加速镜像加载失败，改回主域重试` + (reason ? `：${reason}` : ''))
      autoRetries.current = 0
      setState({ status: 'checking', url: '' })
      setAttempt((n) => n + 1)
      return true
    }
    const bound = playbackRomCandidatesForSelection(game, lang, prefer)
    const chain = bound.length
      ? bound.map((candidate) => ({ key: candidate.key, lang: candidate.lang }))
      : conventionalKeys(game).map((key) => ({ key, lang: undefined }))
    // 约定 key 是按 slug 猜出来的不同文件，不是同一份内容的备用源：网络失败时一个都不换
    if (scope === 'network' && !bound.length) return false
    runtimeFailures.current.add(state.key)
    /*
      自动测速可能先选中排在主地址后面的备用源；它若在真实下载时失败，回退不能只“往后找”，
      否则明明健康的主源永远没有机会。失败集合已经保证每个 key 一轮只试一次，所以从头找安全且不会循环。
      网络层失败只在同语言槽里找（见 RomFailoverScope）。
    */
    const currentLang = bound.find((candidate) => candidate.key === state.key)?.lang ?? state.lang
    const next = nextFailoverKey(chain, runtimeFailures.current, { key: state.key, lang: currentLang }, scope)
    if (!next) return false
    if (scope === 'network') {
      networkFailedKeys.current.add(state.key)
      networkLangLock.current = { lang: currentLang }
    } else {
      // 内容错误允许换别的语言：之前的网络锁不再适用
      networkLangLock.current = null
    }

    // 当前 URL 的 HEAD 结论仍然是“存在”，无需抹掉；失败集才是这轮解析真正要看的信息。
    // 留一行诊断，线上能直接看出是主包坏了后切备用，而不是误以为语言回退选错。
    console.warn(
      `[8bitgo/rom] ${game.slug} 的 ${state.key} 实际加载${scope === 'network' ? '时网络失败' : '失败'}，跳过后尝试 ${next}` +
        (reason ? `：${reason}` : ''),
    )
    autoRetries.current = 0
    setState({ status: 'checking', url: '' })
    setAttempt((n) => n + 1)
    return true
  }, [game, lang, prefer, state.status, state.key, state.lang])

  /*
    换游戏 / 换语言时把自动重试的次数清零。
    必须声明在下面那个主 effect **之前** —— effect 按声明顺序跑，这样切换游戏时先清零
    再开始探测；而只有 attempt 变化（自动重试自己触发的那一次）时这个 effect 不跑，
    计数才累加得下去，不会变成无限重试。
  */
  useEffect(() => {
    runtimeFailures.current.clear()
    mirrorFailed.current = false
    networkLangLock.current = null
    networkFailedKeys.current.clear()
    autoRetries.current = 0
  }, [game, lang, prefer])

  useEffect(() => {
    if (!game) return
    let cancelled = false
    let timer = 0
    if (game.platform === 'html5' && builtinWebGameFor(game.slug)?.externalLaunchUrl) {
      // 外开游戏不经播放器下载或探测入口；点击卡片时直接导航到游戏方顶层页面。
      setState({ status: 'idle', url: '' })
      return
    }
    const streamed = configuredStreamedRom(game, lang, prefer)
    if (streamed) {
      // Sockdrive 自己会在真正开局时校验；不要让完全不会被读取的整包 HEAD 挡住开始按钮。
      setState(streamed)
      return
    }
    // 切游戏或语言时要真正终止旧 HEAD 和测速；只拦 setState 仍会让旧游戏继续占用新游戏的连接。
    const probeController = new AbortController()
    const routeController = new AbortController()
    setState({ status: 'checking', url: '' })

    /*
      所有平台开局前都选一次线路：主域（Cloudflare）还是加速镜像（EdgeOne）。测的是两边都常驻的
      64KB 固定探针，不是 ROM 自己（冷门 ROM 在 EdgeOne 上第一次必然 MISS，会把结论带偏）；
      结论缓存 30 分钟，见 romRoute.ts 的 chooseRomHost。和 HEAD 探测同时开始，HEAD 回来时通常已经有结论。
      两边回源同一个桶、同一个 romv，所以换域不换内容；分片绝不跨域混用，Range 断点续传也只认这一个地址。
      镜像在真实下载中失败时 failover 会把这一局拉回主域（mirrorFailed）。
    */
    /*
      只有候选里真有「主域上、能换到镜像」的地址才测速。明文 ROM 走独立下载域（romUrlForKey），
      romMirrorUrl 对它返回空串；以前照测不误，每款游戏 / 每次重试都白发两次 64KB 探针再扔掉结论。
      测速带 routeController 的 signal：切游戏 / 切语言 / 卸载时真停下，被取消的一轮不写缓存。
    */
    let hostChoice: Promise<RomHost> | null = null
    const startHostChoice = (): Promise<RomHost> | null => {
      if (!hostChoice && !mirrorFailed.current && getRomMirrorBase()) {
        hostChoice = chooseRomHost(getRomBase(), getRomMirrorBase(), {
          prefer: coverCdnHint() === 'cn' ? 'mirror' : 'primary',
          signal: routeController.signal,
        })
      }
      return hostChoice
    }
    if (!mirrorFailed.current && getRomMirrorBase()) {
      const mirrorable = [
        ...playbackRomCandidatesForSelection(game, lang, prefer).map((candidate) => candidate.key),
        ...conventionalKeys(game),
      ].some((key) => Boolean(romMirrorUrl(romUrlForKey(key))))
      // 和 HEAD 探测同时开始，HEAD 回来时通常已经有结论
      if (mirrorable) startHostChoice()
    }
    const preferFasterHost = async (url: string): Promise<string> => {
      if (mirrorFailed.current) return url
      const mirror = romMirrorUrl(url)
      if (!mirror) return url
      const choice = startHostChoice()
      if (!choice) return url
      // 测速只多等一小会儿；没测完就先用默认那边（带缓存的结论下一局直接用）
      const fallback: RomHost = coverCdnHint() === 'cn' ? 'mirror' : 'primary'
      let waitTimer = 0
      const host = await Promise.race([
        choice,
        new Promise<RomHost>((resolve) => { waitTimer = window.setTimeout(() => resolve(fallback), ROM_HOST_WAIT_MS) }),
      ])
      // 测速先回来时等待计时器还挂着；清掉，免得每次开局都留一个空转的定时器
      window.clearTimeout(waitTimer)
      // 记进启动诊断：慢启动时一眼看出 ROM 走的是哪条线路（2026-11-14 大陆《仙剑》报告里看不出）
      diagLog('download', 'info', `ROM 线路：${host === 'mirror' ? '加速镜像' : '主域'} ${new URL(host === 'mirror' ? mirror : url).origin}`)
      return host === 'mirror' ? mirror : url
    }

    ;(async () => {
      const candidates = playbackRomCandidatesForSelection(game, lang, prefer)
      /** 有没有哪个候选是「没问出来」，而不是服务器明确说没有。决定要不要自动重试 */
      let uncertain = false
      /** 每个候选探出来的结果，只在最终放弃时用来打诊断 */
      const traces: ProbeTrace[] = []
      /*
        同一个语言槽的派生 8BG、原包、主源、备用源全部同时发 HEAD，再按原优先级消费结果。
        这样优先级完全不变，但四次跨域往返从“相加”变成“取最慢一次”；选中小 ROM 后会立刻
        abort 仍在等待的备用 HEAD。不同语言仍然一组一组走，避免中文存在时白探七种语言。
      */
      type CandidateProbe = { candidate: RomCandidate; url: string; outcome: ProbeOutcome }
      const groups: RomCandidate[][] = []
      for (const candidate of candidates) {
        const last = groups[groups.length - 1]
        if (!last || last[0]?.lang !== candidate.lang) groups.push([candidate])
        else last.push(candidate)
      }

      const langLock = networkLangLock.current
      explicitGroups:
      for (const group of groups) {
        // 网络失败后的这一轮只探出事的那个语言组（见 networkLangLock）
        if (langLock && group[0]?.lang !== langLock.lang) continue
        const entries = group
          .filter((candidate) => !runtimeFailures.current.has(candidate.key))
          .map((candidate) => ({ candidate, url: romUrlForKey(candidate.key) }))
          .filter((entry) => Boolean(entry.url))
        if (!entries.length) continue

        const pending: Array<Promise<CandidateProbe>> = entries.map(async ({ candidate, url }) => {
          // iframe 导航不受 fetch CORS 限制；外站可以允许嵌入、同时拒绝跨域 HEAD。
          // 仍放在有序 Promise 队列里，避免备用外链越过排在前面的站内主地址。
          const directHtml = game.platform === 'html5' && isHtml5EntryUrl(candidate.key)
          return {
            candidate,
            url,
            outcome: directHtml
              ? { url, certain: true }
              : await probeRom(url, candidate.derivedPacked ? 2500 : 4000, game.platform === 'html5', {
                  signal: probeController.signal,
                  // useRomUrl 自己有退避；这里再重试一次会把 4 秒超时嵌套放大成几十秒。
                  retry: false,
                }),
          }
        })

        for (let index = 0; index < pending.length; index++) {
          const current = await pending[index]
          if (cancelled) return
          const { candidate, url, outcome } = current
          if (outcome.url) {
            let selectedCandidate = candidate
            let selectedOutcome = outcome
            /*
              大文件才为同语言双源额外取样。备用 HEAD 已和主源并发启动，这里不再串行多等一轮；
              测速只选择一个完整来源，后续下载仍绝不混用两个源的分片。
            */
            if (!candidate.backup && candidate.lang && (outcome.size ?? 0) >= ROM_ROUTE_RACE_MIN_BYTES) {
              const backupIndexes = entries
                .map((entry, entryIndex) => ({ ...entry, entryIndex }))
                .filter((entry) => entry.entryIndex > index && entry.candidate.backup)
              for (let backupIndex = 0; backupIndex < backupIndexes.length; backupIndex++) {
                const backup = await pending[backupIndexes[backupIndex].entryIndex]
                if (cancelled) return
                if (backup.outcome.url) {
                  const route = await chooseFasterRomRoute(
                    { url: outcome.url, size: outcome.size },
                    { url: backup.outcome.url, size: backup.outcome.size },
                    { signal: routeController.signal },
                  )
                  if (route === 'backup') {
                    selectedCandidate = backup.candidate
                    selectedOutcome = backup.outcome
                    console.info(
                      `[8bitgo/rom] ${game.slug} 的同语言备用路径测速更快，整份 ROM 改走：${backup.candidate.key}`,
                    )
                  }
                  break
                }
                traces.push({
                  key: backup.candidate.key,
                  url: backup.url,
                  outcome: backup.outcome,
                  lang: backup.candidate.lang,
                  backup: true,
                })
                const nextBackup = backupIndexes[backupIndex + 1]?.candidate
                if (!backup.outcome.certain && !shouldTryRomCandidateAfterUncertain(backup.candidate, nextBackup)) break
              }
            }
            if (selectedCandidate.backup && selectedCandidate === candidate) {
              console.warn(`[8bitgo/rom] ${game.slug} 的 ${candidate.lang ?? '通用'} 主地址不可用，已切换到同语言备用地址：${candidate.key}`)
            }
            probeController.abort()
            const playUrl = await preferFasterHost(selectedOutcome.url)
            if (!cancelled) setState({
              status: 'found',
              url: playUrl,
              key: selectedCandidate.key,
              lang: selectedCandidate.lang,
              size: selectedOutcome.size,
            })
            return
          }
          traces.push({ key: candidate.key, url, outcome, lang: candidate.lang, backup: candidate.backup })
          if (!outcome.certain && !shouldTryRomCandidateAfterUncertain(candidate, entries[index + 1]?.candidate)) {
            // 一组内能换格式 / 换备用源；整组仍问不出来就停止，不能把断网误判成跨语言缺失。
            uncertain = true
            break explicitGroups
          }
        }
      }

      // 只要后台绑定过语言槽或旧版通用 rom，整条绑定链都失效就应明确报缺版本；
      // 不能再猜一个约定文件名，否则会绕过管理员配置，加载到不受控的旧对象。
      if (candidates.length > 0) {
        /*
          语言锁下同语言候选都用完了：主地址是因为一次网络故障被跳过的，没被这一轮重新问过，
          所以整轮只能算「没问出来」—— 即使备用源 HEAD 明确 404，也不能当成「确定没有这个版本」。
          算作 uncertain 才会进自动重试；重试前 finish 会把网络跳过的 key 还回候选链。
        */
        if (!cancelled) finish(uncertain || Boolean(langLock), traces, Boolean(langLock))
        return
      }

      const base = getRomBase()
      const conventional = conventionalKeys(game)
      const hasSelfContainedConvention = conventional.some(selfContainedKey)
      if ((!base && !hasSelfContainedConvention) || !isPlayable(game.platform)) {
        // 这是配置问题（根地址没配、平台不支持），重试一万次也一样，不进重试。
        // 「平台还不支持」是正常状态（未上线的平台），不值得报；根地址空着是真的配错了。
        if (!base && isPlayable(game.platform) && game.platform !== 'html5') {
          console.warn(
            `[8bitgo/rom] 没有配置 ROM 根地址（VITE_ROM_BASE_URL 或 localStorage['${ROM_BASE_KEY}']），` +
              `${game.slug} 这类没绑过语言槽的游戏只能靠约定文件名探测，现在一个都探不了。`,
          )
        }
        if (!cancelled) setState({ status: 'missing', url: '' })
        return
      }

      // 内置 / 外链 HTML5 入口直接交给 iframe；HEAD 的 CORS 规则和“能否嵌入”不是一回事。
      const directConventionalHtml = conventional.find((key) => game.platform === 'html5' && isHtml5EntryUrl(key))
      if (directConventionalHtml) {
        const url = romUrlForKey(directConventionalHtml, base)
        probeController.abort()
        if (!cancelled) setState({ status: 'found', url, key: directConventionalHtml })
        return
      }

      /*
        没绑定记录的老游戏可能有十几个约定后缀。每批并发三个并按原顺序选第一个存在的，
        把 N 次 RTT 压到 ceil(N/3) 次；遇到主机级故障则在本批结束后停止，不继续轰完整张表。
      */
      const availableConventional = conventional.filter((key) => !runtimeFailures.current.has(key))
      for (let offset = 0; offset < availableConventional.length; offset += 3) {
        const batch = availableConventional.slice(offset, offset + 3)
        const results = await Promise.all(batch.map(async (key) => {
          const url = romUrlForKey(key, base)
          return {
            key,
            url,
            outcome: await probeRom(url, key.endsWith('.8bg') ? 2500 : 4000, game.platform === 'html5', {
              signal: probeController.signal,
              retry: false,
            }),
          }
        }))
        if (cancelled) return
        const found = results.find((result) => Boolean(result.outcome.url))
        if (found) {
          probeController.abort()
          const playUrl = await preferFasterHost(found.outcome.url)
          if (!cancelled) setState({ status: 'found', url: playUrl, key: found.key, size: found.outcome.size })
          return
        }
        for (const result of results) traces.push({ key: result.key, url: result.url, outcome: result.outcome })
        if (results.some((result) => !result.outcome.certain)) {
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
    function finish(uncertain: boolean, traces: ProbeTrace[], networkOnly = false) {
      if (uncertain && autoRetries.current < AUTO_RETRY_DELAYS.length) {
        const wait = AUTO_RETRY_DELAYS[autoRetries.current]
        autoRetries.current += 1
        /*
          因网络失败被跳过的 key 在每一轮自动重试前还给候选链（语言锁保留，仍不跨语言）。
          以前只在 window 'online' 事件里归还，可一次网络抖动 / CDN 5xx / 下载失速根本不会触发 online，
          主地址就永远不再被问，备用源一 404 便停在「暂时读取不到」。
        */
        releaseNetworkFailedKeys()
        timer = window.setTimeout(() => setAttempt((n) => n + 1), wait)
        return
      }
      // 只在真正放弃的那一下报一次；重试途中不吵。语言锁下的放弃一律按「没问出来」报，不报确定缺失。
      if (game) reportProbeFailure(game, traces, uncertain || networkOnly, networkOnly)
      setState({ status: 'missing', url: '', unreachable: uncertain || networkOnly })
    }

    return () => {
      cancelled = true
      probeController.abort()
      routeController.abort()
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
      // 网络回来了：因断网跳过的地址不是坏文件，还给候选链，语言锁也一并解开
      releaseNetworkFailedKeys()
      networkLangLock.current = null
      setAttempt((n) => n + 1)
    }
    window.addEventListener('online', again)
    return () => window.removeEventListener('online', again)
  }, [state.status, state.unreachable, releaseNetworkFailedKeys])

  return { ...state, retry, failover }
}

/* ---------------- Worker 管理接口（后台用） ---------------- */

export interface RomObject {
  key: string
  size: number
  uploaded?: string
  /** Worker 同时列 ROMS / COVERS 时用于区分同名旧对象；老 Worker 没有这一项也能兼容。 */
  bucket?: 'ROMS' | 'COVERS' | string
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

export async function pingRomApi(api = getRomApi(), signal?: AbortSignal): Promise<{ isWorker: boolean; writable: boolean; sockdriveSourceCopy: boolean }> {
  const res = await fetch(`${api}/ping`, { cache: 'no-store', signal })
  if (!res.ok) return { isWorker: false, writable: false, sockdriveSourceCopy: false }
  const data = (await res.json().catch(() => null)) as { service?: string; writable?: boolean; features?: { sockdriveSourceCopy?: boolean } } | null
  return {
    isWorker: data?.service === '8bitgo-roms',
    writable: Boolean(data?.writable),
    sockdriveSourceCopy: data?.features?.sockdriveSourceCopy === true,
  }
}

export async function listRomObjects(prefix = getRomPrefix(), signal?: AbortSignal): Promise<RomObject[]> {
  const api = getRomApi()
  if (!api) throw new Error('尚未配置 Worker 地址')
  const out: RomObject[] = []
  const seen = new Set<string>()
  let cursor = ''
  for (let i = 0; i < 50; i++) {
    const url = new URL(`${api}/list`)
    if (prefix) url.searchParams.set('prefix', prefix.endsWith('/') ? prefix : `${prefix}/`)
    if (cursor) url.searchParams.set('cursor', cursor)
    const res = await fetch(url.toString(), { headers: authHeaders(), signal })
    if (!res.ok) throw explainRomStatus(res.status, '列表')
    const data = (await res.json()) as { objects?: RomObject[]; cursor?: string; truncated?: boolean }
    out.push(...(data.objects ?? []))
    if (!data.truncated) break
    if (!data.cursor) throw new Error('R2 列表缺少下一页位置，当前结果不完整；请刷新后重试')
    if (seen.has(data.cursor)) throw new Error('R2 列表分页位置重复，当前结果不完整；请刷新后重试')
    // 到达页面护栏时必须明确报错；静默返回前 5 万个会让后面的文件在后台“消失”。
    if (i === 49) throw new Error('这个前缀下文件过多，列表无法完整显示；请在「ROM 存储」按平台缩小目录前缀后重试')
    seen.add(data.cursor)
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
 * 管理页有口令时走受保护的 /list；没有口令才退回公开 HEAD。探测有 12 秒上限，
 * 避免上传前的只读检查卡住整个流程；普通重复上传把失败当未知继续，转换覆盖等强校验入口可自行失败关闭。
 */
export async function headRom(key: string): Promise<RomHead> {
  const api = getRomApi()
  const clean = key.replace(/^\/+/, '')
  if (!api || !clean) return { exists: false }
  const request = createRequestTimeout(12_000)

  /*
   * 后台已经有 ADMIN_TOKEN 时用 /list 做“静默 HEAD”。直接 fetch(HEAD /对象) 在首次上传时
   * 必然得到 404；业务上这是正常的“不存在”，但 Chromium 仍会把每一次 404 打成红色
   * `Failed to load resource`，管理员会误以为上传失败。/list 对空结果返回 200，既没有假错误，
   * 又能区分 ROMS 与 COVERS：封面曾从 ROMS 迁到独立桶，同名旧副本不能冒充真正的覆盖目标。
   *
   * 没有 token 时保留公开 HEAD，供只读配置页或旧部署使用；上传本身反正也需要 token。
   */
  try {
    if (getRomToken()) {
      const url = new URL(`${api}/list`)
      url.searchParams.set('prefix', clean)
      const res = await fetch(url.toString(), { headers: authHeaders(), cache: 'no-store', signal: request.signal })
      if (!res.ok) throw explainRomStatus(res.status, '对象检测')
      const data = (await res.json().catch(() => null)) as { objects?: RomObject[] } | null
      const exact = (data?.objects ?? []).filter((object) => object.key === clean)
      const preferredBucket = clean.startsWith('covers/') ? 'COVERS' : 'ROMS'
      const object = exact.find((candidate) => candidate.bucket === preferredBucket) ?? exact[0]
      return object ? { exists: true, size: object.size } : { exists: false }
    }

    const res = await fetch(`${api}/${encodeKey(clean)}`, { method: 'HEAD', headers: authHeaders(), cache: 'no-store', signal: request.signal })
    if (!res.ok) return { exists: false }
    const len = Number(res.headers.get('content-length'))
    return {
      exists: true,
      size: Number.isFinite(len) && len >= 0 ? len : undefined,
      etag: res.headers.get('etag') ?? undefined,
    }
  } finally {
    request.dispose()
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
/** 小文件单发 PUT 也要有停滞上限；否则静默断线会让管理员永远等在上传中。 */
const SINGLE_PUT_STALL_MS = 45_000

export interface UploadStage {
  /** 分片总数 */
  parts: number
  /** 已经传完的片数 */
  done: number
  /** 这次是接着上次传的，恢复了几片；0 表示从头传 */
  resumed: number
  /** 首片真实测速后当前允许同时上传的分片数。 */
  concurrency?: number
  /** 首个真实分片测得的上行 Mbps；不额外发送测速文件。 */
  measuredMbps?: number
  /** 已测分片平均估算的 Worker/R2 额外等待；只用于区分上行与存储等待。 */
  serverWaitMs?: number
  /** 参与 Worker/R2 平均等待估算的成功分片数。 */
  serverWaitSamples?: number
  /** 上传请求结束后，本地摘要仍未完成而阻塞下一片派发的平均时间（毫秒）。 */
  hashWaitMs?: number
  /** 参与本地摘要等待估算的成功分片数。 */
  hashWaitSamples?: number
  /** 恢复前逐片核验已上传内容时的进度；避免大文件校验期间界面看起来卡住。 */
  checkingParts?: number
  checkingTotal?: number
}

/** 上传进度回调。第二个参数只有分片上传才有，单发 PUT 时是 undefined */
export type UploadProgress = (pct: number, stage?: UploadStage) => void

export interface UploadResult {
  key: string
  url: string
  size: number
  /** Worker 返回的强 ETag；Sockdrive 桶内复制用它锁定刚上传的这一版 ROM。 */
  etag?: string
  /** 新 Worker 在同一个 R2 提交请求里已发布对应清单。 */
  integrityPublished?: boolean
}

const integrityWorkerCapabilities = new Map<string, { expiresAt: number; atomicUpload: boolean }>()
const INTEGRITY_PROBE_TTL_MS = 5 * 60_000

async function requireIntegrityWorker(api: string, parentSignal?: AbortSignal): Promise<boolean> {
  const base = api.replace(/\/+$/, '')
  const cached = integrityWorkerCapabilities.get(base)
  if (cached && cached.expiresAt > Date.now()) return cached.atomicUpload
  if (cached) integrityWorkerCapabilities.delete(base)
  let features: { integrityManifest?: unknown; integrityAtomicUpload?: unknown } | null = null
  try {
    features = await withRequestTimeout(10_000, parentSignal, async (signal) => {
      const response = await fetch(`${base}/ping`, { cache: 'no-store', signal })
      if (!response.ok) return null
      const status = await response.json().catch(() => null) as { features?: { integrityManifest?: unknown; integrityAtomicUpload?: unknown } } | null
      return status?.features ?? null
    })
  } catch {
    if (parentSignal?.aborted) throw uploadAbortError()
  }
  if (features?.integrityManifest !== true) throw new Error('ROM / BIOS 完整性校验服务尚未部署或暂不可用；请先更新 ROM Worker，再开始上传。文件尚未上传。')
  const atomicUpload = features.integrityAtomicUpload === true
  integrityWorkerCapabilities.set(base, { expiresAt: Date.now() + INTEGRITY_PROBE_TTL_MS, atomicUpload })
  while (integrityWorkerCapabilities.size > 16) {
    const oldest = integrityWorkerCapabilities.keys().next().value
    if (oldest === undefined) break
    integrityWorkerCapabilities.delete(oldest)
  }
  return atomicUpload
}

function encodeIntegrityManifestHeader(manifest: unknown): string {
  const bytes = new TextEncoder().encode(JSON.stringify(manifest))
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
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
    // 8BG 自己带版本、编解码器和原始文件名，不能伪装成 zip；明确类型也方便 CDN 排查。
    '8bg': 'application/x-8bitgo-rom',
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
export async function uploadRom(
  file: Blob,
  key: string,
  onProgress?: UploadProgress,
  activityOptions?: UploadActivityOptions,
  signal?: AbortSignal,
): Promise<UploadResult> {
  const cleanKey = key.replace(/^\/+/, '')

  return trackUploadActivity(`R2 上传：${cleanKey.split('/').pop() || cleanKey}`, async () => {
    if (signal?.aborted) throw uploadAbortError()
    const api = getRomApi()
    if (!api) throw new Error('尚未配置 Worker 地址，无法上传')
    if (!getRomToken()) throw new Error('请先在「ROM 存储」页填写 Worker 口令（ADMIN_TOKEN）')
    const needsIntegrity = isIntegrityKey(cleanKey)
    let atomicIntegrityUpload = false
    if (needsIntegrity) {
      atomicIntegrityUpload = await requireIntegrityWorker(api, signal)
      if (!globalThis.crypto?.subtle) throw new Error('当前浏览器不能生成 ROM / BIOS 的 SHA-256 清单，请改用 HTTPS 下的现代浏览器')
    }

    // ROM / BIOS 在后台上传时生成受 ETag 绑定的分块摘要；和网络上传并行计算，
    // 不把几 GB 光盘一次性读进内存，也不把哈希时间叠加到上传完成之后。
    const integrityTask = needsIntegrity ? createRomIntegrityManifest(file, cleanKey, signal) : null
    integrityTask?.catch(() => {})
    const uploadProgress: UploadProgress | undefined = integrityTask && onProgress
      ? (percent, detail) => onProgress(Math.min(99, percent), detail)
      : onProgress
    const awaitIntegrity = async () => {
      if (!integrityTask) return null
      try { return await integrityTask }
      catch (error) {
        if (signal?.aborted) throw uploadAbortError()
        throw error
      }
    }
    const finishIntegrity = async (result: UploadResult): Promise<UploadResult> => {
      if (!integrityTask) return result
      if (!result.etag) throw new Error(`ROM / BIOS 已上传，但 Worker 未返回对象 ETag，无法安全绑定 SHA-256 清单（${cleanKey}）`)
      if (result.integrityPublished) {
        onProgress?.(100)
        return result
      }
      const manifest = await awaitIntegrity()
      const endpoint = new URL(`${api.replace(/\/+$/, '')}/integrity`)
      endpoint.searchParams.set('key', cleanKey)
      try {
        await withRequestTimeout(45_000, undefined, async (requestSignal) => {
          const response = await fetch(endpoint, {
            method: 'POST',
            headers: { ...authHeaders(), 'Content-Type': 'application/json' },
            body: JSON.stringify({ key: cleanKey, etag: result.etag, size: result.size, manifest }),
            signal: requestSignal,
          })
          const confirmation = await response.json().catch(() => null) as { ok?: boolean; key?: string; etag?: string; size?: number; error?: string } | null
          if (!response.ok || confirmation?.ok !== true || confirmation.key !== cleanKey ||
              confirmation.etag !== result.etag || confirmation.size !== result.size) {
            throw new Error(`HTTP ${response.status}${confirmation?.error ? `：${confirmation.error}` : ''}`)
          }
        })
      } catch (error) {
        throw new Error(`ROM / BIOS 已上传，但 SHA-256 清单未能绑定到对象版本（${error instanceof Error ? error.message : String(error)}）。请重试上传或在 ROM 存储核查。`)
      }
      onProgress?.(100)
      return result
    }

    if (file.size > MULTIPART_THRESHOLD) {
      // 动态 import：分片那套只有后台用得上，静态引会被打进播放器的首屏包里
      const mp = await import('./romMultipart')
      try {
        const result = await mp.uploadRomMultipart(file, cleanKey, uploadProgress, signal,
          integrityTask ?? undefined, atomicIntegrityUpload)
        clearRomProbeCache()
        return await finishIntegrity(result)
      } catch (err) {
        if (signal?.aborted) throw uploadAbortError()
        // Worker 还没部署分片接口（忘了 wrangler deploy）时退回单发 PUT。
        // 大文件照样会失败，但小一点的文件不该因为后端没更新就整个传不了。
        if (!(err instanceof mp.MultipartUnsupportedError)) throw err
        console.warn('[rom] Worker 没有分片接口，退回单发 PUT；大文件请部署 worker/ 的新版本')
      }
    }

    // 单发 PUT 无法暂停在 R2 提交之前；先完成摘要，避免摘要失败时留下必校验却无清单的对象。
    const manifest = integrityTask ? await awaitIntegrity() : null
    const result = await singlePut(file, cleanKey, api, uploadProgress, signal,
      atomicIntegrityUpload ? manifest ?? undefined : undefined)
    return await finishIntegrity(result)
  }, activityOptions)
}

/**
 * 在 R2 桶内把已发布的 ZIP 复制到私有 Sockdrive staging；浏览器无需第二次上传大文件。
 * ETag 防止并发管理员改写同一 ROM key 时，把另一版文件误拿去制盘。
 */
export async function copyRomToSockdriveStaging(
  sourceKey: string,
  stagingKey: string,
  sourceSize: number,
  sourceEtag: string,
): Promise<{ key: string; size: number; etag: string }> {
  const api = getRomApi()
  if (!api) throw new Error('尚未配置 Worker 地址，无法准备 Sockdrive 源文件')
  if (!getRomToken()) throw new Error('请先在「ROM 存储」页填写 Worker 口令（ADMIN_TOKEN）')
  if (!sourceKey.startsWith('roms/') || !/\.zip$/i.test(sourceKey)) throw new Error('Sockdrive 源文件必须是已上传的公开 ROM ZIP')
  if (!/^sockdrive-staging\/[a-f0-9-]{16,}\.zip$/i.test(stagingKey)) throw new Error('Sockdrive staging key 无效')
  if (!Number.isSafeInteger(sourceSize) || sourceSize < 32 * 1024 || !/^"[^"\r\n]{1,250}"$/.test(sourceEtag)) {
    throw new Error('无法确认已上传 ROM ZIP 的大小与版本')
  }
  const url = `${api}/${encodeKey(stagingKey)}`
  const body = JSON.stringify({ sourceKey, sourceSize, sourceEtag })
  let lastError: unknown
  for (let attempt = 0; attempt < 3; attempt++) {
    let response: Response
    try {
      response = await fetch(url, {
        method: 'POST',
        headers: { ...authHeaders(), 'Content-Type': 'application/json' },
        body,
      })
    } catch (error) {
      lastError = error
      if (attempt === 2) break
      await new Promise((resolve) => window.setTimeout(resolve, 500 * 2 ** attempt))
      continue
    }
    const data = await response.json().catch(() => null) as {
      ok?: boolean; key?: string; size?: number; etag?: string; error?: string
    } | null
    if (response.status >= 500 && attempt < 2) {
      lastError = new Error(data?.error || `准备 Sockdrive 源文件失败：HTTP ${response.status}`)
      await new Promise((resolve) => window.setTimeout(resolve, 500 * 2 ** attempt))
      continue
    }
    if (!response.ok) throw new Error(data?.error || explainRomStatus(response.status, '准备 Sockdrive 源文件').message)
    if (data?.ok !== true || data.key !== stagingKey || data.size !== sourceSize || !data.etag) {
      lastError = new Error('Worker 未确认 Sockdrive 源文件完整复制；请在「ROM 存储」核查后重试')
      if (attempt < 2) {
        await new Promise((resolve) => window.setTimeout(resolve, 500 * 2 ** attempt))
        continue
      }
      break
    }
    return { key: stagingKey, size: data.size, etag: data.etag }
  }
  throw lastError instanceof Error ? lastError : new Error('准备 Sockdrive 源文件失败')
}

/** 一次 PUT 传完。只适合小文件，大文件见 uploadRom 里的分片分支 */
function uploadAbortError(): Error {
  const error = new Error('上传已取消')
  error.name = 'AbortError'
  return error
}

function singlePut(
  file: Blob,
  cleanKey: string,
  api: string,
  onProgress?: UploadProgress,
  signal?: AbortSignal,
  integrityManifest?: unknown,
): Promise<UploadResult> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(uploadAbortError())
      return
    }
    const xhr = new XMLHttpRequest()
    xhr.open('PUT', `${api}/${encodeKey(cleanKey)}`)
    xhr.setRequestHeader('Authorization', `Bearer ${getRomToken()}`)
    xhr.setRequestHeader('Content-Type', file.type || guessUploadType(cleanKey))
    if (isIntegrityKey(cleanKey)) xhr.setRequestHeader('X-8BG-Integrity-Required', 'sha256-v1')
    if (integrityManifest) xhr.setRequestHeader('X-8BG-Integrity-Manifest', encodeIntegrityManifestHeader(integrityManifest))
    let lastProgressAt = Date.now()
    let lastLoaded = 0
    let stalled = false
    let settled = false
    const watchdog = window.setInterval(() => {
      if (settled || Date.now() - lastProgressAt < SINGLE_PUT_STALL_MS) return
      stalled = true
      xhr.abort()
      fail(new Error('上传停滞：45 秒没有收到上传进度或服务器确认，请重试'))
    }, 5_000)
    const finish = () => {
      if (settled) return false
      settled = true
      window.clearInterval(watchdog)
      signal?.removeEventListener('abort', abortFromSignal)
      return true
    }
    const fail = (error: Error) => {
      if (finish()) reject(error)
    }
    xhr.upload.onprogress = (e) => {
      if (settled) return
      if (e.loaded > lastLoaded) {
        lastLoaded = e.loaded
        lastProgressAt = Date.now()
      }
      // 100% 代表 Worker 已校验对象；请求体发完但还没收到确认时停在 99%。
      if (e.lengthComputable && e.total > 0 && onProgress) onProgress(Math.min(99, Math.round((e.loaded / e.total) * 100)))
    }
    xhr.upload.onload = () => { lastProgressAt = Date.now() }
    xhr.onerror = () =>
      fail(signal?.aborted ? uploadAbortError() :
        new Error(
          // 「检查地址与 CORS」这句话曾经把人带到完全错误的方向上：文件超过平台上限时
          // 边缘直接 reset 连接，表现和 Worker 不通一模一样。大文件优先提这个可能。
          file.size > 90 * 1024 * 1024
            ? '上传中断：文件接近或超过 Cloudflare 单请求 100MB 上限。请部署 worker/ 的新版本以启用分片上传'
            : '网络错误：无法连接 Worker（检查地址与 CORS）',
        ))
    xhr.onabort = () => fail(signal?.aborted
      ? uploadAbortError()
      : new Error(stalled ? '上传停滞：45 秒没有收到上传进度或服务器确认，请重试' : '上传连接已中断'))
    xhr.onload = () => {
      if (signal?.aborted) {
        fail(uploadAbortError())
        return
      }
      if (xhr.status >= 200 && xhr.status < 300) {
        let data: { ok?: boolean; key?: string; size?: number; etag?: string; integrityPublished?: boolean } | null = null
        try { data = JSON.parse(xhr.responseText) } catch { /* Worker 地址填错时可能回 HTML。 */ }
        // 仅凭 200 就把 key 写进游戏库会让播放器拿到 HTML 或不完整的对象。
        if (data?.ok !== true || data.key !== cleanKey || data.size !== file.size) {
          fail(new Error(`上传响应不完整或对象大小不符；请到「ROM 存储」核查 ${cleanKey}`))
          return
        }
        if (!finish()) return
        clearRomProbeCache()
        // ROM / BIOS 的 100% 由 uploadRom 在摘要清单绑定完成后发送。
        if (!isIntegrityKey(cleanKey)) onProgress?.(100)
        resolve({ key: cleanKey, url: romUrlForKey(cleanKey), size: data.size, etag: data.etag || undefined,
          integrityPublished: data.integrityPublished === true })
      } else {
        fail(explainRomStatus(xhr.status, '上传'))
      }
    }
    try {
      signal?.addEventListener('abort', abortFromSignal, { once: true })
      xhr.send(file)
    } catch (error) {
      fail(error instanceof Error ? error : new Error('无法开始上传'))
    }
    function abortFromSignal() {
      xhr.abort()
    }
  })
}

export async function deleteRom(key: string): Promise<void> {
  const api = getRomApi()
  const res = await fetch(`${api}/${encodeKey(key)}`, { method: 'DELETE', headers: authHeaders() })
  if (!res.ok) throw explainRomStatus(res.status, '删除')
  clearRomProbeCache()
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
  // 8BG 是外层容器，真正的 ROM 扩展名仍在它前面（例如 contra.nes.8bg）。先剥容器，
  // 再走原来的扩展名规则，否则后台“自动匹配”会把 slug 猜成 contra.nes。
  const noExt = name
    .replace(/\.8bg$/i, '')
    .replace(/\.(zip|7z|nes|unf|fds|sfc|smc|fig|gba|gbc|gb|z64|n64|v64|md|gen|bin|smd|nds|srl|ws|wsc|cue|iso|img|pbp|chd|exe|com|swf|jar)$/i, '')
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
