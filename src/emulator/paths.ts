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
import { NETPLAY_URL } from '@/services/netplay'

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

/** Ruffle（Flash）资源路径。由 scripts/copy-ruffle.mjs 复制到 public/ruffle/ */
export const RUFFLE_PATH: string = asDir(import.meta.env.VITE_RUFFLE_PATH, '/ruffle/')

/** FreeJ2ME 资源路径。**没配置就是空** —— 空 = 该引擎 available() 为 false，解析阶段直接跳过 */
export const J2ME_PATH: string = asDir(import.meta.env.VITE_J2ME_PATH)

/** webretro 资源路径。同上，没配置就当它不存在 */
export const WEBRETRO_PATH: string = asDir(import.meta.env.VITE_WEBRETRO_PATH)

/**
 * Play!（PS2）的自托管目录，里面要有 `Play.js` 和 `Play.wasm`。
 *
 * ⚠️ 和 EmulatorJS / Ruffle 不一样，**上游没有发布任何预编译产物**，也没有 CDN 和 npm 包
 * —— 只能自己用 emscripten 从 jpd002/Play- 构建（见 adapters/play.ts 的部署说明）。
 * 所以这里没有默认值：没配 VITE_PLAY_PATH 时 playMeta.available() 为 false，
 * PS2 平台整个不可玩，而不是让玩家点进去看一个 404。
 */
export const PLAY_PATH: string = asDir(import.meta.env.VITE_PLAY_PATH)

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
 * 上面列了九个平台，这里却只放开 NDS —— 不是漏了，是刻意的：
 * **联机（netplay）是 EmulatorJS 独有的**（房主浏览器跑游戏、画面经 WebRTC 推给访客）。
 * webretro 没有这套东西。把 NES / SNES / GBA 这些平台改判给 webretro，
 * 等于悄无声息地把它们的联机功能关掉。
 *
 * 想再放开某个平台，先确认该平台的联机不重要，再把 id 加进这个集合。
 */
const WEBRETRO_ENABLED = new Set<PlatformId>(['nds'])

export const webretroCoreFor = (platform: PlatformId): string | undefined =>
  WEBRETRO_ENABLED.has(platform) ? WEBRETRO_PLATFORM_CORES[platform] : undefined

/** 核心名 → 展示名，跟 webretro 的 coreNames 保持一致 */
export const WEBRETRO_CORE_LABELS: Record<string, string> = {
  melonds: 'melonDS',
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
