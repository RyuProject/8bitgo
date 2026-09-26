/**
 * 运行时的**轻量**部分：资源路径、平台↔核心的小对照表、几个纯判断函数。
 *
 * 为什么单独一个文件 —— 这是分包的关键。
 *
 * 这些东西以前散在各个适配器里，然后由 `index.ts` 转导出给页面用
 * （`import { p2pPlayable } from '@/emulator'`）。后果是：**只想要一个常量，
 * 整套模拟器就跟着进了主包**。房间列表页只用 `p2pPlayable` / `cloudPlayable` 两个
 * 布尔判断，却因此下载了 EmulatorJS、js-dos、Ruffle、J2ME、webretro、云联机、
 * 看直播七个适配器的全部实现 —— 看博客、逛首页的人同样中招。
 *
 * 现在这里只放「不需要跑起来就能回答的问题」：路径配了没有、这个平台有没有核心。
 * 真正的实现（mount）留在 adapters/ 里，由 runtimes.ts 静态引入，
 * 而 runtimes.ts 只被 EmulatorPlayer 引用 —— 后者是懒加载的。
 *
 * ⚠️ 往这里加东西前先问一句：它会不会把某个适配器拖进来？会的话就不该放这儿。
 */
import type { PlatformId } from '@/types'
import { platformMap } from '@/data/platforms'
import { NETPLAY_URL } from '@/services/roomFlags'

/** 末尾补上斜杠；空值原样返回（空 = 没配置 = 该引擎不可用） */
const asDir = (raw: string | undefined, fallback = ''): string => {
  const p = raw || fallback
  if (!p) return ''
  return p.endsWith('/') ? p : `${p}/`
}

/**
 * EmulatorJS 资源根路径。**默认是自托管的 /emulatorjs/，不是 CDN。**
 *
 * 默认值必须写死在代码里：曾经默认值是 CDN、真实路径靠 `.env.local` 顶上去，
 * 而 `.env.local` 被 .gitignore 的 `*.local` 挡住 —— 构建机上根本没有这个文件，
 * 于是线上悄悄退回不含 netplay 的 4.2.3，本地怎么试都是好的。
 */
export const EJS_PATH: string = asDir(import.meta.env.VITE_EJS_PATH, '/emulatorjs/')

/**
 * EmulatorJS 的文件名没有内容哈希，而 CDN 会缓存一个月。每次改自托管引擎或 loader
 * 都要加一代，让浏览器和边缘不再把旧 JS 与新核心拼在一起。
 */
export const EJS_RUNTIME_GENERATION = '20260923-melondsds-core-errors'
export const ejsRuntimeAsset = (name: string): string =>
  `${EJS_PATH}${name}?v=${encodeURIComponent(EJS_RUNTIME_GENERATION)}`

/**
 * Ruffle 的版本既进入 URL，也由构建检查和 npm 包互相校验。
 * wasm / glue 文件名不是稳定的内容哈希；把版本放进目录后，旧 CDN 缓存不会和新版混用。
 */
export const RUFFLE_VERSION = '0.6.0'
export const RUFFLE_PATH: string = asDir(
  import.meta.env.VITE_RUFFLE_PATH,
  `/ruffle/v${RUFFLE_VERSION}/`,
)

/**
 * js-dos 的 JS、DOSBox 和 DOSBox-X wasm 必须来自同一批产物。
 *
 * 这些文件以前全放在固定的 `/jsdos/`：升级 npm 包或本地补丁后，Cloudflare 与浏览器
 * 最多一小时仍可能各自命中旧文件，最坏会拼成「新 js-dos.js + 旧 wasm」，玩家只看到黑屏。
 * 版本进入 URL 后，旧缓存不会再参与新会话；构建检查还会把上游版本和 npm 包逐字核对。
 *
 * 本站会对 js-dos.js 打补丁，而这些文件是一年 immutable：只要补丁会改变产物，
 * JSDOS_ASSET_VERSION 就必须换代。否则代码已部署，玩家却会继续命中上一份 CDN 缓存。
 */
export const JSDOS_VERSION = '8.4.1'
export const JSDOS_ASSET_VERSION = '8.4.1-8bitgo.3'
export const JSDOS_PATH: string = asDir(
  import.meta.env.VITE_JSDOS_PATH,
  `/jsdos/v${JSDOS_ASSET_VERSION}/`,
)

/* ---------------- EmulatorJS：平台别名 → 实际核心文件 ---------------- */

/**
 * EmulatorJS 的 `EJS_core` 接受平台别名，但磁盘上的文件使用真实核心名。
 * 例如 `gb` 会由引擎解析成 `gambatte`；预热发生在 loader.js 之前，不能直接请求
 * `gb-wasm.data`，否则每次悬停都会制造一条 404。构建测试会把这张表逐项与自托管引擎核对。
 */
const EJS_DEFAULT_CORE_BY_ALIAS: Readonly<Record<string, string>> = Object.freeze({
  arcade: 'fbneo',
  gb: 'gambatte',
  gba: 'mgba',
  n64: 'mupen64plus_next',
  // 引擎内建别名仍把 nds 指到停更的 melonds；站点在这一层硬切到自构建新核心。
  nds: 'melondsds',
  melonds: 'melondsds',
  nes: 'fceumm',
  psx: 'pcsx_rearmed',
  segaMD: 'genesis_plus_gx',
  snes: 'snes9x',
  ws: 'mednafen_wswan',
})

/** 仅转换站点会用到的平台别名；后台直接选择的具体核心名原样返回。 */
export function emulatorJsCoreFileFor(core: string): string {
  return EJS_DEFAULT_CORE_BY_ALIAS[core] ?? core
}

/**
 * 游戏表里可能还留着历史值 `nds` / `melonds`。没人使用 NDS 存档迁移，所以本次不做
 * 双核心兼容期，开局时直接把这两个旧值归一到新核心；DeSmuME 等显式选择不受影响。
 */
export function emulatorJsCoreForGame(platform: PlatformId, requested?: string | null): string | undefined {
  const core = requested || platformMap[platform]?.core
  if (platform === 'nds' && (core === 'nds' || core === 'melonds')) return 'melondsds'
  return core ?? undefined
}

/** FreeJ2ME 资源路径。**没配置就是空** —— 空 = 该引擎 available() 为 false，解析阶段直接跳过 */
export const J2ME_PATH: string = asDir(import.meta.env.VITE_J2ME_PATH)

/** webretro 资源路径。同上，没配置就当它不存在 */
export const WEBRETRO_PATH: string = asDir(import.meta.env.VITE_WEBRETRO_PATH)

/**
 * Play!（PS2）的自托管目录，里面要有 `Play.js` 和 `Play.wasm`。
 *
 * 运行时从 Play! 官方 Web 部署获取后连同校验信息提交在 public/play/，生产构建用
 * scripts/check-play.mjs 防止只部署 JS 或只部署 wasm。这里仍不设默认值：构建期开关
 * 缺失时应让 PS2 明确显示未部署，而不是让玩家点进去才遇到 404。
 */
export const PLAY_PATH: string = asDir(import.meta.env.VITE_PLAY_PATH)

/**
 * PPSSPP 浏览器核心必须使用本站打过 Range 补丁的构建，不能退回上游网页壳：
 * 上游只会把整份 ISO 挂进 WORKERFS，大游戏会在启动前完整下载并复制进内存。
 * 不设默认值是刻意的——二进制没部署时让平台明确显示不可运行，绝不在线上白屏。
 */
export const PPSSPP_VERSION = '0dbfaca'
export const PPSSPP_PATH: string = asDir(import.meta.env.VITE_PPSSPP_PATH)
/**
 * Cloudflare 对这组静态文件的缓存键会忽略查询串，所以 PPSSPP 不能靠 `?r=` 换代。
 * 桥、Wasm 或 data 任一项变化都发布到新的实体目录，保证边缘不会拼出两代运行时。
 */
export const PPSSPP_RUNTIME_GENERATION = 'v4'
export const PPSSPP_RUNTIME_PATH: string = PPSSPP_PATH
  ? asDir(`${PPSSPP_PATH}${PPSSPP_RUNTIME_GENERATION}`)
  : ''

/**
 * wasm-dolphin 随仓库发布在版本目录里。目录名就是接入时锁定的上游提交短 SHA：
 * 运行时文件互相用相对路径 import，升级时必须整目录换代，不能让边缘缓存拼出新旧混合物。
 */
export const DOLPHIN_VERSION = '7e38409'
export const DOLPHIN_PATH: string = asDir(import.meta.env.VITE_DOLPHIN_PATH, `/dolphin/v${DOLPHIN_VERSION}/`)

/** 云联机服务器地址。空 = 云联机整块功能隐藏 */
export const CLOUDGAME_URL: string = (import.meta.env.VITE_CLOUDGAME_URL || '').replace(/\/+$/, '')
export const CLOUDGAME_ZONE: string = import.meta.env.VITE_CLOUDGAME_ZONE || ''

/* ---------------- webretro：平台 → 核心 ---------------- */

const WEBRETRO_PLATFORM_CORES: Partial<Record<PlatformId, string>> = {
  nds: 'melonds',
  n64: 'mupen64plus_next',
  psx: 'mednafen_psx_hw',
  nes: 'nestopia',
  snes: 'snes9x',
  gba: 'mgba',
  gb: 'mgba',
  segaMD: 'genesis_plus_gx',
  ws: 'mednafen_wswan',
}

/**
 * 实际交给 webretro 跑的平台。
 *
 * 上面保留了可用核心映射，但当前集合是空的。NDS 硬切 melonDS DS 之前曾在这里放开，
 * 现在不再参与自动选路。其余平台也不能随手放开：
 * **联机（netplay）是 EmulatorJS 独有的**（房主浏览器跑游戏、画面经 WebRTC 推给访客）。
 * webretro 没有这套东西。把 NES / SNES / GBA 这些平台改判给 webretro，
 * 等于悄无声息地把它们的联机功能关掉。
 *
 * 想放开某个平台，先确认该平台的联机不重要，再把 id 加进这个集合。
 */
// NDS 已硬切到 EmulatorJS 的 melonDS DS；保留适配器代码，但不再让它参与自动选路。
const WEBRETRO_ENABLED = new Set<PlatformId>()

export const webretroCoreFor = (platform: PlatformId): string | undefined =>
  WEBRETRO_ENABLED.has(platform) ? WEBRETRO_PLATFORM_CORES[platform] : undefined

/** 核心名 → 展示名，跟 webretro 的 coreNames 保持一致 */
export const WEBRETRO_CORE_LABELS: Record<string, string> = {
  melonds: 'melonDS',
  melondsds: 'melonDS DS',
  mupen64plus_next: 'Mupen64Plus-Next',
  mednafen_psx_hw: 'Beetle PSX HW',
  nestopia: 'Nestopia UE',
  snes9x: 'Snes9x',
  mgba: 'mGBA',
  genesis_plus_gx: 'Genesis Plus GX',
  mednafen_wswan: 'Beetle WonderSwan',
}

/* ---------------- 云联机：平台 → 核心 ---------------- */

export const CLOUD_PLATFORM_CORES: Partial<Record<PlatformId, string>> = {
  nes: 'nestopia',
  snes: 'snes9x',
  gba: 'mgba',
  gb: 'mgba',
  n64: 'mupen64plus_next',
  psx: 'pcsx_rearmed',
  arcade: 'fbneo',
  dos: 'dosbox_pure',
  segaMD: 'genesis_plus_gx',
}

/* ---------------- 光盘平台 ---------------- */

/**
 * 「ROM」其实是一整张盘的平台。
 *
 * 和卡带机的区别不是类型学上的，是**数量级**上的：卡带机 ROM 是几 KB 到几十 MB，
 * 一张 PS1 盘压成 .chd 也有几百 MB，PS2 的 DVD 是几 GB。差三个数量级之后，
 * 「先整个下下来再交给引擎」这件事从无所谓变成了会把手机标签页搞崩，
 * 所以这些平台走单独的一条加载路径（见 adapters/emulatorjs.ts 的 prepareRemoteDiscRom）。
 *
 * ⚠️ 加平台之前先想清楚：进了这个集合，ROM 就不再由引擎自己流式下载，
 * 而是先落成一个 Blob。收益是能缓存、能提前知道体积；代价是引擎失去了边下边解压的机会。
 * 只有几百 MB 以上的平台才值得这么换。
 */
export const DISC_PLATFORMS = new Set<PlatformId>(['psx', 'ps2'])

export const isDiscPlatform = (platform: string): boolean => DISC_PLATFORMS.has(platform as PlatformId)

/**
 * 「ROM 由我们自己下，不交给引擎的 XHR」的平台。
 *
 * 光盘平台全在里面（上面那段说明就是为它们写的），另外多一个 **NDS** ——
 * 它是唯一一个「卡带机」却值得这么做的平台，理由是数量级：GBA 的卡最大 32MB，
 * 而 NDS 的卡到 512MB，常见的大作（宝可梦黑白、雷顿教授）就是 128～256MB。
 * 那段「几十 MB 无所谓」的判断对 GBA 成立，对 NDS 不成立。
 *
 * 交给引擎自己下的三笔代价，在 NDS 上都是真金白银：
 *   1. **下完就扔** —— romCache 覆盖不到引擎内部的 XHR（见 romCache.ts），
 *      第二次进同一款游戏还要再下 128MB。romCache.ts 的文件头点名说要解决
 *      「PSX / NDS 每次进游戏都重下几百 MB」，但这条路一直没接上 NDS。
 *   2. **断了不能续** —— 引擎是一条 XHR 到底，128MB 下到 90% 掉线就从头再来；
 *      我们自己那条是 8MB 一片、每片三次重试，完整片还会暂存在独立 IndexedDB，
 *      刷新页面后按 romv 内容版本只补缺片（见 loadProgress / downloadResume）。
 *   3. **开局前不知道要下多少** —— 接管之后 Content-Length 第一帧就有，
 *      播放器那行「本局需下载 XXX」才出得来。
 *
 * ⚠️ 那段说明里写的代价（「引擎失去了边下边解压的机会」）对这里几乎不成立：
 * EmulatorJS 自己也是**整份下完**再写进虚拟文件系统的，压缩包同样是下完才解。
 * 真实差别只在峰值内存，而我们走的是 Blob（大 Blob 浏览器会落盘），
 * 比它那一整块 ArrayBuffer 还省。
 *
 * ⚠️ 再加平台之前先问一句：这个平台的 ROM 上限是不是真的到了几百 MB。
 * 红白机 / GBA 这些几 MB 的进来只有坏处 —— 多一次 Blob 拷贝，缓存收益微乎其微。
 */
export const SELF_DOWNLOAD_PLATFORMS = new Set<PlatformId>([...DISC_PLATFORMS, 'nds'])

export const isSelfDownloadPlatform = (platform: string): boolean =>
  SELF_DOWNLOAD_PLATFORMS.has(platform as PlatformId)

/* ---------------- 页面用的几个判断 ---------------- */

/**
 * EmulatorJS 覆盖面最广：把所有配了 core 的平台的扩展名收进来。
 * 放在这里而不是适配器里，是因为「这个格式该不该给 EmulatorJS」属于解析阶段的问题，
 * 解析阶段不需要引擎本体。
 */
export const EJS_EXTS: string[] = [
  ...new Set(
    Object.values(platformMap)
      .filter((p) => p.core)
      .flatMap((p) => p.romExtensions ?? []),
  ),
].map((e) => e.replace(/^\./, '').toLowerCase())

/** 该平台能否 P2P 联机：需要 EmulatorJS 能跑（即配了 core）且信令已配置 */
export function p2pPlayable(platform: string): boolean {
  return Boolean(NETPLAY_URL) && Boolean(platformMap[platform as keyof typeof platformMap]?.core)
}

/** 该平台能否云联机：服务器地址配了、且平台有对应核心 */
export function cloudPlayable(platform: PlatformId): boolean {
  return Boolean(CLOUDGAME_URL) && Boolean(CLOUD_PLATFORM_CORES[platform])
}
