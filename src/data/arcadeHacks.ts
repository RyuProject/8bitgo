/**
 * 已知街机改版包的指纹表 + 让它真的能跑起来的加载方案。
 *
 * ── 为什么需要它 ─────────────────────────────────────────────
 * lib/arcadeRomset.ts 那套是「拿包里的 CRC 去比 FBNeo 的驱动表，谁被解释得最多算谁」。
 * 对原版包很准，对**改版包**必然给错答案：汉化版换掉两三个 ROM，剩下的几十个还和
 * 各个克隆集共用，于是它会挑一个碰巧多命中几个的克隆集报出来（实测吞食天地II 的中文版
 * 被判成「最接近 wofch 19/29」），而那个方向从一开始就是错的 —— 顺着它去补包，
 * 补出来的是一个「把中文 Hack 往 CPS Changer 版硬凑」的四不像。
 *
 * 改版包的身份不在「像谁」，而在**它换掉的那几个 ROM 是什么**。那几个 CRC 是唯一的，
 * 一撞就确定。所以这里存的是指纹（改版包独有的 CRC）而不是完整清单。
 *
 * ── 为什么写死在仓库里 ───────────────────────────────────────
 * 现在条目还是个位数，跟着代码走最省事 —— 一次 code review 就能看清加了什么。
 * 等条目多到需要非开发者维护再搬进数据库。
 */
import type { PlatformId } from '@/types'

/**
 * 有些改版包光靠一份 dat 救不回来，还得先从原包里生成核心能加载的图形 ROM。
 * wofcn 把两颗字库 ROM 按 FBNeo 的 CPS1 解码顺序拆成四路，只交给 wofcn 专用核心。
 */
export interface ArcadeHackDerive {
  /** 合成需要哪几个成员的**解压后**内容。只解这几个，别为了它把 20 多 MB 全解开 */
  inputs: string[]
  /**
   * `run()` 会产出哪几个成员的名字。
   *
   * 存在的理由只有一个：**判断这个包是不是已经烘好了**。`scripts/prep-arcade-hack.mjs`
   * 会离线把合成产物写进包里，而运行时这条路也会合成 —— 两边都做过就会往 zip 里
   * 追加同名成员。不预先知道名字就只能先跑一遍 run()（几十 MB 的复制）才能发现白跑了。
   * ⚠️ 必须和 `run()` 实际返回的名字、以及 romData 里引用的名字三者一致。
   */
  outputs: string[]
  /** 产出要追加进包里的新成员。名字要和 romData 里写的一致 */
  run(inputs: Record<string, Uint8Array>): { name: string; data: Uint8Array }[]
}

export interface ArcadeHack {
  /**
   * 压缩包必须叫这个名字（不含 .zip）。
   *
   * ⚠️ 不只是显示用：FBNeo 靠包名认游戏，RomData 里的 ZipName 也必须和它一致，
   * 所以识别到之后要把文件按这个名字递给引擎（见 emulator/arcadeHack.ts 的 renameForEngine）。
   */
  zipName: string
  /** 借哪个 FBNeo 驱动跑。RomData 的 DrvName 就是它 */
  driver: string
  platform: PlatformId
  /** 给人看的名字 */
  title: string
  /** 出处 / 在别的模拟器里叫什么，方便以后回溯 */
  note?: string
  /**
   * 指纹：这个改版包**独有**的 CRC-32。全部出现才算命中。
   *
   * 只放改版包换掉 / 新增的那几个，不要把共用 ROM 也塞进来 ——
   * 共用 ROM 在几十个克隆集里都有，放进来只会让指纹失去区分度。
   */
  fingerprint: number[]
  /**
   * 现成的 FBNeo RomData（.dat）。识别到就直接用，不用人再去生成一份。
   * 留空表示「认得出但还没有可用的加载方案」—— 界面上要如实说，别假装能跑。
   */
  romData?: string
  /** RomData 是游戏级字段还是只属于命中的 ROM；多语言游戏的专用包必须选 rom。 */
  romDataScope?: 'game' | 'rom'
  /** 需要先合成新 ROM 的话放这里。romData 里引用的合成产物必须由它产出 */
  derive?: ArcadeHackDerive
}

/* ══════════════════════════════════════════════════════════════════════════
   吞食天地II 赤壁之战 中文版（HBMAME: tk2h5）
   ══════════════════════════════════════════════════════════════════════════

   基础是日版 wofj。程序与八块基础图形 ROM 都沿用日版，另增加两块中文字库 ROM。
   HBMAME 对这两块 ROM 的实际加载方式标记为未知，源码只留下 ROM_COPY 目标 0x040000 与 0x380000。
   HBMAME 留下的 ROM_COPY 目标是图形偏移 0x040000 与 0x380000，但直接覆盖 FBNeo 已解码图形会损坏共用场景图块。
   网页核心把四路字库解码到 0x400000 的独立图形区，再仅将 wofcn 对白框中的 E000-EFFF 字码导向该区。

   HBMAME 的 tk2h5 ROM_LOAD64_WORD / ROM_CONTINUE 把 gfx5 的 0x10000、0x18000 两段放在图形通道 0、2，
   gfx6 的对应两段放在通道 4、6。FBNeo 的 CpsLoadTiles 前两项组成 tile 左半、后两项组成右半，
   所以交给 loader 的顺序必须是 gfx5 0x10000、gfx5 0x18000、gfx6 0x10000、gfx6 0x18000。
   按来源偏移交错 gfx5 / gfx6 会把左右半片和像素位平面混在一起，人物对白就会显示成碎块。
   投币开始后的人物对白是最终验收依据；字库图集或开场字幕不能代替实机画面。
   字库通道顺序按 CPS1 loader 的左半 / 右半解码次序组合；不能用来源 ROM 的交错次序代替。
   方案仍须以投币开始后的实际对白画面验收，不能只凭图集、标题或 HUD 断言正确。
   不能把短字库通道标成普通 CPS1_TILES：FBNeo 会把小于 0x80000 的普通图块 ROM 按八条
   通道一组读取，导致越界读到后面的 Z80 / QSound ROM。

   HBMAME 将整体中文加载过程标记为未知，因此必须经投币、开始后的真实对白画面验证，
   不能仅凭注释或字库图集宣称正确。

   这份方案必须通过投币、开始、人物对话的实际画面核对；不能只凭 RomData 或标题画面验收。 */

const WOFCN_FONT_LANE_SIZE = 0x008000

const WOFCN_DERIVE: ArcadeHackDerive = {
  inputs: ['tk2_gfx5cn.rom', 'tk2_gfx6cn.rom'],
// v5 依照 HBMAME 的通道地址和 FBNeo 的左右半片顺序排列；换名可使旧浏览器不复用 v4 合成 ROM。
  outputs: [
    'tk2h5_cjk_fbneo_v5_lane0.rom', 'tk2h5_cjk_fbneo_v5_lane1.rom',
    'tk2h5_cjk_fbneo_v5_lane2.rom', 'tk2h5_cjk_fbneo_v5_lane3.rom',
  ],
  run(inputs) {
    const lanes: [string, number, string][] = [
      ['tk2_gfx5cn.rom', 0x10000, 'tk2h5_cjk_fbneo_v5_lane0.rom'],
      ['tk2_gfx5cn.rom', 0x18000, 'tk2h5_cjk_fbneo_v5_lane1.rom'],
      ['tk2_gfx6cn.rom', 0x10000, 'tk2h5_cjk_fbneo_v5_lane2.rom'],
      ['tk2_gfx6cn.rom', 0x18000, 'tk2h5_cjk_fbneo_v5_lane3.rom'],
    ]
    return lanes.map(([sourceName, sourceStart, name]) => {
      const source = inputs[sourceName]
      if (!source) throw new Error(`wofcn: 合成字库缺少 ${sourceName}`)
      if (source.length < sourceStart + WOFCN_FONT_LANE_SIZE) {
        throw new Error(`wofcn: ${sourceName} 长度不足`)
      }
      return { name, data: new Uint8Array(source.subarray(sourceStart, sourceStart + WOFCN_FONT_LANE_SIZE)) }
    })
  },
}

const WOFCN_ROMDATA = `// Tenchi wo Kurau II (Edition Chinese) —— HBMAME tk2h5，基础驱动为日版 wofj
// 前八块图形 ROM 按基础驱动加载；四路字库按 HBMAME 的图形地址与 FBNeo 左右半片顺序排列。
// 专用核心把人物对白框内的 E000-EFFF 字码映射到独立扩展字库，不覆盖普通场景图形。
// ROM 顺序有意义：程序 → 普通图形（8 条）→ Z80 → QSound → 扩展图形（4 条）→ PLD。
// FBNeo 的 CPS1_EXTRA_TILES_400000 loader 从 QSound 之后开始逐四条读取。
// FullName 必须加引号：romdata.cpp 用 strqtoken 按空格、制表、换行、逗号、%:|{} 切词。

ZipName    wofcn
DrvName    wofj
FullName   "Tenchi wo Kurau II (Edition Chinese)"

tk2j23ccn.bin        0x080000   0xe1dd01d8   BRF_ESS BRF_PRG CPS1_68K_PROGRAM_NO_BYTESWAP
tk2j22c.bin          0x080000   0xb74b09ac   BRF_ESS BRF_PRG CPS1_68K_PROGRAM_NO_BYTESWAP

tk2_gfx1.rom         0x080000   0x0d9cb9bf   BRF_GRA CPS1_TILES
tk2_gfx3.rom         0x080000   0x45227027   BRF_GRA CPS1_TILES
tk2_gfx2.rom         0x080000   0xc5ca2460   BRF_GRA CPS1_TILES
tk2_gfx4.rom         0x080000   0xe349551c   BRF_GRA CPS1_TILES
tk205.bin            0x080000   0xe4a44d53   BRF_GRA CPS1_TILES
tk206.bin            0x080000   0x58066ba8   BRF_GRA CPS1_TILES
tk207.bin            0x080000   0xd706568e   BRF_GRA CPS1_TILES
tk208.bin            0x080000   0xd4a19a02   BRF_GRA CPS1_TILES

tk2_qa.rom           0x020000   0xc9183a0d   BRF_PRG CPS1_Z80_PROGRAM

tk2_q1.rom           0x080000   0x611268cf   BRF_SND CPS1_QSOUND_SAMPLES
tk2_q2.rom           0x080000   0x20f55ca9   BRF_SND CPS1_QSOUND_SAMPLES
tk2_q3.rom           0x080000   0xbfcf6f52   BRF_SND CPS1_QSOUND_SAMPLES
tk2_q4.rom           0x080000   0x36642e88   BRF_SND CPS1_QSOUND_SAMPLES

tk2h5_cjk_fbneo_v5_lane0.rom  0x008000   0x38d273a2   BRF_GRA CPS1_EXTRA_TILES_400000
tk2h5_cjk_fbneo_v5_lane1.rom  0x008000   0xedb8cfbb   BRF_GRA CPS1_EXTRA_TILES_400000
tk2h5_cjk_fbneo_v5_lane2.rom  0x008000   0x9c2ada91   BRF_GRA CPS1_EXTRA_TILES_400000
tk2h5_cjk_fbneo_v5_lane3.rom  0x008000   0x2a48eb5a   BRF_GRA CPS1_EXTRA_TILES_400000

buf1                 0x000117   0xeb122de7   BRF_OPT
ioa1                 0x000117   0x59c7ee3b   BRF_OPT
prg2                 0x000117   0x4386879a   BRF_OPT
rom1                 0x000117   0x41dc73b9   BRF_OPT
tk263b.1a            0x000117   0xc4b0349b   BRF_OPT
iob1.12d             0x000117   0x3abc0700   BRF_OPT
bprg1.11d             0x000117   0x31793da7   BRF_OPT
ioc1.ic1             0x000117   0x0d182081   BRF_OPT
`

export const ARCADE_HACKS: ArcadeHack[] = [
  {
    zipName: 'wofcn',
    driver: 'wofj',
    platform: 'arcade',
    title: '吞食天地II 赤壁之战（中文版）',
    note: 'HBMAME: tk2h5 — Tenchi wo Kurau II (Edition Chinese)',
    // 这是单独一份汉化 ROM。数据库 arcade_romdata 是游戏级共享，不能写进去污染其他语言槽。
    romDataScope: 'rom',
    // 换掉的程序 ROM + 两块新增的中文字库，三个一起出现才算它
    fingerprint: [0xe1dd01d8, 0xec6e8689, 0x722787df],
    romData: WOFCN_ROMDATA,
    derive: WOFCN_DERIVE,
  },
]

/**
 * 拿包里的 CRC 认一个已知改版包。
 * 指纹必须**全部**出现 —— 少一个就不是它，宁可交回给覆盖率那套去猜。
 */
export function matchArcadeHack(crcs: Iterable<number>): ArcadeHack | null {
  const have = new Set<number>()
  for (const c of crcs) have.add(c >>> 0)
  for (const hack of ARCADE_HACKS) {
    if (hack.fingerprint.every((c) => have.has(c >>> 0))) return hack
  }
  return null
}

/** 找出只属于特定 ROM 的 RomData，防止它被游戏级字段带到其它语言版本。 */
export function romScopedHackForData(romData: string | undefined): ArcadeHack | null {
  if (!romData?.trim()) return null
  const zipName = /^\s*ZipName\s+(\S+)/im.exec(romData)?.[1]?.toLowerCase()
  if (!zipName) return null
  return romScopedHackForName(zipName)
}

/** 按已规范化的 ZIP 短名找到 ROM 专属改版；用于开局前只对当前语言槽选择兼容核心。 */
export function romScopedHackForName(zipName: string | undefined): ArcadeHack | null {
  if (!zipName?.trim()) return null
  const normalized = zipName.trim().replace(/\.zip$/i, '').toLowerCase()
  return ARCADE_HACKS.find((hack) => hack.romDataScope === 'rom' && hack.zipName.toLowerCase() === normalized) ?? null
}
