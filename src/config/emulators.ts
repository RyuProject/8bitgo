/**
 * 「哪种格式用哪个引擎」的配置表 —— 想换引擎改这里就够了。
 *
 * 解析顺序（见 src/emulator/registry.ts）：
 *   1. 扩展名在下面的覆盖表里 → 直接用指定引擎
 *   2. 否则在「支持该扩展名」的引擎里挑 priority 最高的
 *   3. 再否则退回平台自己配置的引擎（src/data/platforms.ts 的 runtime 字段）
 *
 * 覆盖表只在该引擎 available() 为真时生效，否则自动往下走，不会把页面卡死。
 */
import type { RuntimeId } from '@/emulator/types'

export const EXT_RUNTIME_OVERRIDES: Record<string, RuntimeId> = {
  // NES 交给轻量的 jsnes（纯 JS，启动快、包小）
  // 想换回 EmulatorJS 的 RetroArch 核心（更精准、支持金手指与更多 mapper），把这行删掉即可
  nes: 'jsnes',

  // Flash
  swf: 'ruffle',

  // 现代网页游戏直接加载自己的 HTML 入口；复杂游戏通常是部署好的完整站点，而非单文件。
  html: 'html5',
  htm: 'html5',

  // Java 手机游戏：需要自托管 J2ME 运行时，没配置时会自动跳过
  jar: 'j2me',
  jad: 'j2me',

  /*
    NDS：webretro 那一路的 melonDS。

    ⚠️ 这里原来写的是「比 EmulatorJS 用的 desmume 分支稳」—— **事实错了**：
    EmulatorJS 的 nds 默认核心一直就是 melonDS（它的核心表是
    `nds:["melonds","desmume","desmume2015"]`，第一个是默认，`cores/` 里也确实有
    melonds-*.data）。两条路跑的是同一个核心，webretro 并没有「更稳」这个优势。

    留着这两行的真实理由只剩一个：webretro 是 RetroArch 的完整移植，
    以后如果要用 EmulatorJS 没有的核心（比如 melonDS-DS），入口在那边。
    需要自托管（npm run webretro + VITE_WEBRETRO_PATH），没部署时 available() 为 false，
    这张表自动跳过、NDS 回落 EmulatorJS —— 现在线上走的就是回落这一路。
  */
  nds: 'webretro',
  srl: 'webretro',

  // DOS：js-dos（DOSBox 浏览器移植）比 EmulatorJS 的 dosbox_pure 核心启动快、兼容性好。
  // .zip / .exe / .com 没写在这里 —— 那几个扩展名别的平台也在用，
  // 靠 jsdos 的 supports(dos) + priority 去争，不能一刀切。
  jsdos: 'jsdos',
}

/**
 * 后台「模拟器核心」下拉里可选的核心（按平台）。
 *
 * 只影响 EmulatorJS 这一路（EJS_core），别的引擎不吃这个值。
 * 留空 = 用 src/data/platforms.ts 里该平台的默认核心。
 *
 * 街机是唯一真正需要逐款调的：「街机」在我们这儿是一个平台，
 * 在现实里却是好几套完全不同的硬件 ——
 *   - 拳皇、合金弹头、侍魂  → Neo Geo，fbneo
 *   - 街霸 2、恐龙快打      → CPS1/CPS2，fbalpha2012_cps1 / cps2
 *   - 更老或更杂的板子      → mame2003_plus 兼容面最广，但也最慢
 * 换核心往往比换 ROM 有用：每个核心认的 romset 版本不一样，
 * 报「缺文件」时先换核心试试。
 *
 * PS1 是第二个需要逐款调的：两个核心的取舍方向完全相反，没有哪个「更好」——
 *   - pcsx_rearmed（EmulatorJS 的 psx 默认）：为手机而生，快、省内存，
 *     但 GTE 精度和一些特效是近似的，个别游戏会花屏或几何抖动。
 *   - mednafen_psx_hw（Beetle PSX HW）：准得多，还能拉内部分辨率把 3D 画面变清楚，
 *     代价是 CPU 和内存都明显更吃 —— 中低端手机上会掉帧。
 * 所以默认留 pcsx_rearmed（保证能跑起来），个别有画面问题、或者想要高清的游戏
 * 再单独换成 mednafen_psx_hw。
 *
 * NDS 是第三个：melonDS 准确度和兼容性都明显好过 desmume 那一支，所以它是默认；
 * 但它在网页上有一处硬短板 —— **一个降档手段都没有**（2026-09-07 把
 * public/emulatorjs/cores/melonds-wasm.data 解包读过核心选项表，一共 14 项：
 * 没有 frameskip、没有内部分辨率、没有 JIT、没有线程渲染器。JIT 在 wasm 里
 * 架构上就不可能；线程渲染器只在 `-thread` 变体里有，那个要 SharedArrayBuffer）。
 * desmume 那一支恰好有 `desmume_frameskip`（0–9）和 `desmume_internal_resolution`。
 * 所以这两个的定位是**按游戏兜底**：哪款 melonDS 跑不对或跑不动，单独给它换 ——
 * **不是全站提速**，全站换过去是拿准确度换帧率，得不偿失。
 */
export const CORE_OPTIONS: Record<string, Array<{ id: string; label: string }>> = {
  arcade: [
    { id: 'fbneo', label: 'FBNeo（默认，Neo Geo / 拳皇首选）' },
    { id: 'fbalpha2012_cps1', label: 'FB Alpha CPS1（街霸 2 这类）' },
    { id: 'fbalpha2012_cps2', label: 'FB Alpha CPS2' },
    { id: 'mame2003_plus', label: 'MAME 2003-Plus（兼容面最广，较慢）' },
    { id: 'mame2003', label: 'MAME 2003' },
  ],
  psx: [
    { id: 'psx', label: 'PCSX-ReARMed（默认，快、省内存，手机首选）' },
    { id: 'mednafen_psx_hw', label: 'Beetle PSX HW（更准、可高清，吃性能）' },
  ],
  nds: [
    { id: 'nds', label: 'melonDS（默认，最准，但没有降档手段）' },
    { id: 'desmume', label: 'DeSmuME（有帧跳 / 可调内部分辨率，跑不动时换它）' },
    { id: 'desmume2015', label: 'DeSmuME 2015（更老更轻，弱机兜底）' },
  ],
}

/** 某平台可选的核心列表；没配置的平台返回空数组（后台就不显示这一栏） */
export function coreOptionsFor(platform: string): Array<{ id: string; label: string }> {
  return CORE_OPTIONS[platform] ?? []
}
