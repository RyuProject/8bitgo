/**
 * 开放平台 · 平台目录（只读参考）。
 *
 * 给**第三方客户端**（尤其是要自己起本地模拟器的 Linux / 嵌入式客户端）用的：
 * 它拿到一个游戏的 `platform` 字段后，需要知道「这平台该用哪个模拟器跑、
 * ROM 是什么扩展名、能不能真的在本地跑」—— 否则只能把 16 个平台的映射硬编码进固件，
 * 站上加一个新平台，所有旧客户端就认不出来。
 *
 * ⚠️ **这份是后端镜像**。前端那一份在 `src/data/platforms.ts`（站点运行时用的，
 * 带 color / icon / description 等 UI 字段）。两处的 `id` / `core` / `romExtensions`
 * 必须对得上 —— 改了核心或扩展名，这里要同步。之所以不放进 `shared/` 让两边 import 同一份，
 * 是因为服务端是 Node ESM、前端是 TS bundle，跨构建共享一份带类型的目录收益抵不过复杂度；
 * 而这份只服务于开放 API 这一个契约，单独维护反而边界清楚。
 *
 * `native` 字段是给本地客户端的核心建议：
 *   runnable  —— 这个平台的 ROM 能不能被一台本地机器上的模拟器直接跑。
 *                false 的有两类：html5（根本不是 ROM，是网页）、ps2（只有云端串流，本地无模拟器）。
 *   emulator  —— runnable 时，推荐的 Linux 原生模拟器（给的是项目名，客户端自己选发行版包）。
 *   note      —— 特别坑：比如 dos 的 jsdos 包是 Web 专用格式，本地 DOSBox 要先解包整理目录。
 */
import { isPlatformEnabledId } from '../../../shared/site-taxonomy.js'

/**
 * 递归冻结。
 *
 * ⚠️ `Object.freeze([...])` **只冻最外层那个数组** —— 里面每个平台对象、
 * 它的 `native` 和 `romExtensions` 数组仍然是可写的。而这张表是模块级单例，
 * 每个请求 `res.json({ items: OPEN_PLATFORMS })` 发的都是同一份对象：
 * 将来任何一处 `items.forEach(p => p.native.note = ...)` 会把它改坏，
 * 而且是**进程范围、永久性**的 —— 之后所有客户端拿到的都是被改过的表，
 * 重启才恢复。冻上之后那种写入在严格模式（ESM 默认）下直接抛错，当场发现。
 */
function deepFreeze(v) {
  if (v && typeof v === 'object' && !Object.isFrozen(v)) {
    Object.freeze(v)
    for (const k of Object.keys(v)) deepFreeze(v[k])
  }
  return v
}

/** 一个平台对外暴露的字段形状 */
const PLATFORM_ROWS = deepFreeze([
  {
    id: 'psx',
    name: 'PlayStation 1',
    nameZh: '索尼 PlayStation',
    manufacturer: 'Sony',
    year: 1994,
    runtime: 'emulatorjs',
    core: 'psx',
    romExtensions: ['.bin', '.cue', '.iso', '.img', '.pbp', '.chd', '.zip'],
    native: { runnable: true, emulator: 'DuckStation / PCSX-ReARMed (RetroArch)', note: '' },
  },
  {
    id: 'ps2',
    name: 'PlayStation 2',
    nameZh: '索尼 PlayStation 2',
    manufacturer: 'Sony',
    year: 2000,
    runtime: 'play',
    core: null,
    romExtensions: ['.iso', '.chd', '.cso', '.zso', '.isz', '.bin', '.elf'],
    native: {
      runnable: false,
      emulator: '',
      /*
        ⚠️ 这句话改过两次，别改回去。

        原来写的是「只有云端串流，本地没有能跑的 PS2 模拟器」—— 两处都是错的：
          · 站上跑 PS2 的是**浏览器里的 Play!**（实验性，见 adapters/play.ts），
            不是云端串流。串流是那份文件里提到的「真要兼容性只有这一条路」，
            是没做的方案，不是现状。
          · PCSX2 在 Linux 上非常成熟。说「本地没有能跑的」会让客户端把
            PS2 游戏整个藏起来，而用户其实跑得动。

        真正的理由是**盘太大**：PS2 是 DVD，一张 1~4.7GB，站上根本不整份下载
        （Play! 走 HTTP Range 只读游戏真正读到的扇区，见 remoteDisc.ts）。
        所以 /v1/games/:slug/rom 这条路对 PS2 不成立 —— 不是「跑不了」，是「拿不到」。
      */
      note: '站上的 PS2 是 DVD 镜像（1~4.7GB），只按扇区串读、不提供整份下载，所以拿不到可直接使用的 ROM。本地有 PCSX2，但盘要你自己准备',
    },
  },
  {
    id: 'flash',
    name: 'Flash / 网页游戏',
    nameZh: 'Flash 网页游戏',
    manufacturer: 'Web',
    year: 2000,
    runtime: 'ruffle',
    core: null,
    romExtensions: ['.swf'],
    native: { runnable: true, emulator: 'Ruffle（有 Linux 原生构建）', note: 'Flash 游戏，需用 Ruffle 运行 .swf' },
  },
  {
    id: 'html5',
    name: 'HTML5 / WebAssembly',
    nameZh: 'HTML5 网页游戏',
    manufacturer: 'Web',
    year: 2014,
    runtime: 'html5',
    core: null,
    romExtensions: ['.html', '.htm'],
    native: { runnable: false, emulator: '', note: '网页游戏，不是一个可下载的 ROM 文件' },
  },
  {
    id: 'arcade',
    name: 'Arcade 街机',
    nameZh: '街机',
    manufacturer: 'SNK / Capcom / Namco',
    year: 1978,
    runtime: 'emulatorjs',
    core: 'arcade',
    romExtensions: ['.zip'],
    native: {
      runnable: true,
      emulator: 'FBNeo（RetroArch fbneo 核心 / 独立版）',
      note: 'ROM 是完整 romset 压缩包，文件名即驱动名（如 kof97.zip），不要改名',
    },
  },
  {
    id: 'n64',
    name: 'Nintendo 64',
    nameZh: '任天堂 64',
    manufacturer: 'Nintendo',
    year: 1996,
    runtime: 'emulatorjs',
    core: 'n64',
    romExtensions: ['.z64', '.n64', '.v64', '.zip'],
    native: { runnable: true, emulator: 'Mupen64Plus / RetroArch', note: '' },
  },
  {
    id: 'nes',
    name: 'Famicom / NES',
    nameZh: '红白机',
    manufacturer: 'Nintendo',
    year: 1983,
    runtime: 'emulatorjs',
    core: 'nes',
    romExtensions: ['.nes', '.unf', '.fds', '.zip'],
    native: { runnable: true, emulator: 'Nestopia / FCEUX / Mednafen', note: '' },
  },
  {
    id: 'snes',
    name: 'Super Famicom / SNES',
    nameZh: '超级任天堂',
    manufacturer: 'Nintendo',
    year: 1990,
    runtime: 'emulatorjs',
    core: 'snes',
    romExtensions: ['.sfc', '.smc', '.fig', '.zip'],
    native: { runnable: true, emulator: 'Snes9x / bsnes', note: '' },
  },
  {
    id: 'nds',
    name: 'Nintendo DS',
    nameZh: '任天堂 DS',
    manufacturer: 'Nintendo',
    year: 2004,
    runtime: 'emulatorjs',
    core: 'nds',
    romExtensions: ['.nds', '.srl', '.zip'],
    native: { runnable: true, emulator: 'melonDS / DeSmuME', note: '' },
  },
  {
    id: 'gba',
    name: 'Game Boy Advance',
    nameZh: 'GBA',
    manufacturer: 'Nintendo',
    year: 2001,
    runtime: 'emulatorjs',
    core: 'gba',
    romExtensions: ['.gba', '.zip'],
    native: { runnable: true, emulator: 'mGBA', note: '' },
  },
  {
    id: 'gb',
    name: 'Game Boy',
    nameZh: 'Game Boy',
    manufacturer: 'Nintendo',
    year: 1989,
    runtime: 'emulatorjs',
    core: 'gb',
    romExtensions: ['.gb', '.zip'],
    native: { runnable: true, emulator: 'SameBoy / mGBA', note: '' },
  },
  {
    id: 'gbc',
    name: 'Game Boy Color',
    nameZh: 'Game Boy Color',
    manufacturer: 'Nintendo',
    year: 1998,
    runtime: 'emulatorjs',
    core: 'gb',
    romExtensions: ['.gbc', '.zip'],
    native: { runnable: true, emulator: 'SameBoy / mGBA', note: '按卡带 CGB 标志判断按哪种机器跑' },
  },
  {
    id: 'segaMD',
    name: 'Sega Genesis / Mega Drive',
    nameZh: '世嘉 MD',
    manufacturer: 'Sega',
    year: 1988,
    runtime: 'emulatorjs',
    core: 'segaMD',
    romExtensions: ['.md', '.gen', '.bin', '.smd', '.zip'],
    native: { runnable: true, emulator: 'Genesis Plus GX (RetroArch) / BlastEm', note: '' },
  },
  {
    id: 'dos',
    name: 'MS-DOS',
    nameZh: 'DOS 电脑游戏',
    manufacturer: 'PC',
    year: 1981,
    runtime: 'jsdos',
    core: 'dos',
    romExtensions: ['.zip', '.exe', '.com', '.jsdos'],
    native: {
      runnable: true,
      emulator: 'DOSBox',
      note: 'jsdos 包是 Web 专用格式，本地 DOSBox 需先解包并整理成裸目录结构才能跑',
    },
  },
  {
    id: 'ws',
    name: 'WonderSwan / Color',
    nameZh: '神奇天鹅',
    manufacturer: 'Bandai',
    year: 1999,
    runtime: 'emulatorjs',
    core: 'ws',
    romExtensions: ['.ws', '.wsc', '.zip'],
    native: { runnable: true, emulator: 'Mednafen (wswan)', note: '' },
  },
  {
    id: 'java',
    name: 'Java (J2ME)',
    nameZh: 'Java 手机游戏',
    manufacturer: 'Mobile',
    year: 2001,
    runtime: 'j2me',
    core: null,
    romExtensions: ['.jar'],
    native: { runnable: true, emulator: 'FreeJ2ME', note: 'Java 手机游戏，需 JRE + FreeJ2ME' },
  },
])

/**
 * 对外的平台目录。每一行在 PLATFORM_ROWS 的基础上补一个 `enabled`。
 *
 * ## 为什么必须有 enabled
 *
 * 站上并不是 16 个平台都开着 —— 白名单在 `shared/site-taxonomy.js` 的
 * `ENABLED_PLATFORM_IDS` 里，不在名单上的平台**前台一律 404**
 * （GameDetailPage 那句 `!isPlatformEnabled(...) → NotFoundPage`，SSR 跟着回 404）。
 * 写这份镜像时名单上少了 n64 / snes / segaMD / ws 四个。
 *
 * 不带这个字段的话，第三方客户端会照着目录给用户列出这四个平台，
 * 而 `/v1/games?platform=n64` 查出来是空的 —— 用户看到一个永远没有内容的分类，
 * 却不知道为什么。而这个名单**是会变的**（NDS 就是 2026-09-08 才补进去的，
 * 在那之前每一款 NDS 游戏的详情页都 404 了好几周），
 * 所以不能在文档里写死「有哪 12 个」，只能每次从名单现算。
 *
 * ⚠️ 判断走 `isPlatformEnabledId` 而不是直接对数组 includes ——
 * 那个名单为空数组时表示「不限制，全部开放」，直接 includes 会反过来变成「全部禁用」。
 */
export const OPEN_PLATFORMS = deepFreeze(
  PLATFORM_ROWS.map((p) => ({ ...p, enabled: isPlatformEnabledId(p.id) })),
)
