/**
 * 九个运行时的**元数据**：id、展示名、能跑哪些格式、优先级、可用性判断。
 *
 * 为什么单独一个文件 —— 见 paths.ts 的开头。一句话：
 * 「该用哪个引擎」这个问题不需要把引擎本身下载下来才能回答。
 *
 * `resolveRuntime` / `isPlayable` / `runtimesFor` 全都只用得上这里的东西，
 * 而它们被详情页、游戏库、房间列表、后台表单调用 —— 这些地方以前统统被迫
 * 拖进了整套模拟器实现。现在它们只依赖这个文件。
 *
 * ⚠️ **元数据只有这一份，实现只有 adapters/ 那一份，两边不会漂移** ——
 * 适配器不再各自维护一个带元数据的 Runtime 对象，它们只导出 mount。
 *
 * ⚠️ `description` 必须是 getter：站点语言是运行时可切换的，写成普通字段
 * 就会把首次求值时的那门语言固化下来，切语言之后说明文字不跟着变。
 */
import type { PlatformId } from '@/types'
import { platformMap } from '@/data/platforms'
import { platformLabel } from '@/services/i18nData'
import { getT } from '@/services/i18n'
import { liveEnabled } from '@/services/live'
import type { Runtime } from './types'
import {
  CLOUDGAME_URL,
  CLOUD_PLATFORM_CORES,
  EJS_EXTS,
  J2ME_PATH,
  PLAY_PATH,
  WEBRETRO_CORE_LABELS,
  WEBRETRO_PATH,
  webretroCoreFor,
} from './paths'

export const emulatorJsMeta: Runtime = {
  id: 'emulatorjs',
  name: 'EmulatorJS',
  get description() {
    return getT().runtime.ejsDesc
  },
  extensions: EJS_EXTS,
  // 通用兜底引擎，优先级最低：有更专精的引擎（如 .nes 的 jsnes）时让给它
  priority: 5,
  available: () => true,
  supports: (platform) => Boolean(platformMap[platform]?.core),
  /**
   * 详情页「运行时」那一格的后半截。
   *
   * 这里**不能**直接把 platformMap[platform].core 摆出去 —— 那是 EmulatorJS 内部的
   * 核心键（'arcade' / 'segaMD' / 'ws' 这种），既不是引擎名，也永远是英文小写，
   * 在中文/日文站上就是一行看不懂的字母（用户报的就是「EmulatorJS · arcade」）。
   * 改成按站点语言取平台名，用的是 t.platforms 里已有的那份。
   */
  engineLabel: (platform) =>
    platformMap[platform]?.core ? platformLabel(getT(), platform, platformMap[platform]?.name ?? platform) : '—',
}

export const ruffleMeta: Runtime = {
  id: 'ruffle',
  name: 'Ruffle',
  get description() {
    return getT().runtime.ruffleDesc
  },
  extensions: ['swf'],
  priority: 20,
  available: () => true,
  supports: (platform) => platform === 'flash',
  engineLabel: () => 'swf',
}

export const html5Meta: Runtime = {
  id: 'html5',
  name: 'HTML5 / WebAssembly',
  description: '直接运行已部署的 HTML5 或 WebAssembly 网页游戏',
  extensions: ['html', 'htm'],
  priority: 100,
  available: () => true,
  supports: (platform) => platform === 'html5',
  engineLabel: () => 'HTML5 / WASM',
}

export const jsnesMeta: Runtime = {
  id: 'jsnes',
  name: 'jsnes',
  get description() {
    return getT().runtime.jsnesDesc
  },
  extensions: ['nes'],
  // 比 EmulatorJS 高：命中 .nes 时优先用它
  priority: 20,
  available: () => true,
  supports: (platform) => platform === 'nes',
  engineLabel: () => 'jsnes',
}

export const j2meMeta: Runtime = {
  id: 'j2me',
  name: 'FreeJ2ME',
  get description() {
    return getT().runtime.j2meDesc
  },
  extensions: ['jar', 'jad'],
  priority: 10,
  // 没装 / 没配置就当作不存在，解析阶段直接跳过
  available: () => Boolean(J2ME_PATH),
  supports: (platform) => platform === 'java',
  engineLabel: () => 'FreeJ2ME',
}

export const jsdosMeta: Runtime = {
  id: 'jsdos',
  name: 'js-dos',
  get description() {
    return getT().runtime.jsdosDesc
  },
  extensions: ['jsdos', 'zip', 'exe', 'com'],
  // 高于 EmulatorJS：DOS 这类文件优先交给它
  priority: 25,
  available: () => true,
  supports: (platform) => platform === 'dos',
  engineLabel: () => 'DOSBox',
}

export const webretroMeta: Runtime = {
  id: 'webretro',
  name: 'webretro',
  get description() {
    return getT().runtime.webretroDesc
  },
  // .srl 是 NDS ROM 的另一种后缀（webretro 的 fileExts 里就这么写的）
  extensions: ['nds', 'srl', 'zip'],
  // 必须高于 EmulatorJS 的 5，才能在 NDS 上顶掉它；
  // 低于 jsdos(25) / ruffle(20) / jsnes(20)，不去碰它们的地盘（supports 也拦着）
  priority: 15,
  // 没装 / 没配置就当作不存在，NDS 会自动退回 EmulatorJS
  available: () => Boolean(WEBRETRO_PATH),
  supports: (platform) => Boolean(webretroCoreFor(platform)),
  engineLabel: (platform) => {
    const core = webretroCoreFor(platform)
    return core ? (WEBRETRO_CORE_LABELS[core] ?? core) : '—'
  },
}

export const playMeta: Runtime = {
  id: 'play',
  name: 'Play!',
  get description() {
    return getT().runtime.playDesc
  },
  // PS2 的容器格式。.bin 也在里面，但 supports 只放 ps2，抢不到别人的地盘
  extensions: ['iso', 'chd', 'cso', 'zso', 'isz', 'bin', 'elf'],
  // 高于 EmulatorJS 的 5 没意义 —— supports 只认 ps2，而 ps2 平台 EmulatorJS 根本不支持。
  // 给 15 只是和 webretro 对齐，表示「专精引擎优先于通用兜底」
  priority: 15,
  /**
   * 没自建就当不存在。
   *
   * ⚠️ 这一条不能放宽：上游没有任何预编译产物或 CDN，没配 VITE_PLAY_PATH 时
   * Play.js 一定 404。available() 返回 false 之后 PS2 平台整个是「不可玩」状态，
   * 玩家看到的是明确的提示，而不是点进去卡在加载界面。
   */
  available: () => Boolean(PLAY_PATH),
  supports: (platform) => platform === 'ps2',
  engineLabel: () => 'Play!',
}

export const cloudGameMeta: Runtime = {
  id: 'cloudgame',
  name: 'Cloud',
  get description() {
    return getT().runtime.cloudDesc
  },
  // 不参与「按扩展名选引擎」：联机是用户显式选择的模式，不是文件格式决定的
  extensions: [],
  priority: 0,
  available: () => Boolean(CLOUDGAME_URL),
  supports: (platform) => Boolean(CLOUD_PLATFORM_CORES[platform]),
  engineLabel: (platform) => CLOUD_PLATFORM_CORES[platform] ?? '—',
}

export const liveViewMeta: Runtime = {
  id: 'liveview',
  name: 'Live',
  get description() {
    return getT().runtime.liveDesc
  },
  // 不参与「按扩展名选引擎」：看直播是用户点进来的，不是文件格式决定的
  extensions: [],
  priority: 0,
  available: () => liveEnabled(),
  supports: () => true,
  engineLabel: () => 'WebRTC',
}

/** 全部运行时的元数据。registry.ts 的解析全基于它 */
export const runtimeMetas: Record<Runtime['id'], Runtime> = {
  emulatorjs: emulatorJsMeta,
  ruffle: ruffleMeta,
  html5: html5Meta,
  jsnes: jsnesMeta,
  j2me: j2meMeta,
  jsdos: jsdosMeta,
  webretro: webretroMeta,
  play: playMeta,
  cloudgame: cloudGameMeta,
  liveview: liveViewMeta,
}

/** 让 PlatformId 参与类型检查（supports 的签名用得上） */
export type { PlatformId }
