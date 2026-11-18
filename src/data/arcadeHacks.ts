/**
 * 已知街机改版包的指纹表 + 已验证的加载方案。
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
 * 有些改版包光靠一份 dat 救不回来，还得**先合成几块新 ROM**。
 * 只有加载布局经过真实游戏画面验证后，才应该在这里声明合成方案。
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
  /** 配置是游戏级字段还是只属于命中的 ROM；多语言游戏的专用包必须选 rom。 */
  romDataScope?: 'game' | 'rom'
  /** 需要先合成新 ROM 的话放这里。romData 里引用的合成产物必须由它产出 */
  derive?: ArcadeHackDerive
}

/* ══════════════════════════════════════════════════════════════════════════
   吞食天地II 赤壁之战中文版（HBMAME: tk2h5）
   ══════════════════════════════════════════════════════════════════════════

   HBMAME 将 tk2h5 挂在世界版 `wof` 父驱动下，并在源码里标注了两块字库 ROM 的 ROM_COPY
   目标：CPS1 图形区 0x040000（开场）和 0x380000（人物介绍）。FBNeo 的 CPS1_TILES
   不是 MAME 的交错图形区，所以运行时先按 ROMX_LOAD 的 64-bit lane 顺序重建这两段，
   再拆回 FBNeo 的四路图形 ROM。只有准确命中程序和两颗字库的 CRC 才会合成；WOF 其它语言
   继续用各自原始图形 ROM，不会继承这份汉化覆盖。

   HBMAME 给该改版保留 MACHINE_IMPERFECT_GRAPHICS 标记；这条支持路径复现其注释中的
   ROM_COPY，不会改动原始上传包，也不宣称补齐 HBMAME 尚未确认的硬件细节。
*/

const WOFCN_INPUTS = [
  'tk2_gfx1.rom', 'tk2_gfx3.rom', 'tk2_gfx2.rom', 'tk2_gfx4.rom',
  'tk205.bin', 'tk206.bin', 'tk207.bin', 'tk208.bin',
  'tk2_gfx5cn.rom', 'tk2_gfx6cn.rom',
] as const

const WOFCN_OUTPUTS = [
  'wofcn_intro_gfx1.rom', 'wofcn_intro_gfx3.rom', 'wofcn_intro_gfx2.rom', 'wofcn_intro_gfx4.rom',
  'wofcn_actor_gfx1.rom', 'wofcn_actor_gfx2.rom', 'wofcn_actor_gfx3.rom', 'wofcn_actor_gfx4.rom',
] as const

/** 将 HBMAME 的两颗 CPS1 字库芯片还原为 ROM_COPY 写入的四路 FBNeo 图形数据。 */
function deriveWofcnGraphics(inputs: Record<string, Uint8Array>) {
  const files = WOFCN_INPUTS.map((name) => {
    const data = inputs[name]
    if (!data || data.length !== 0x80000) {
      throw new Error(`wofcn 字库转换需要完整的 ${name}（512 KiB）`)
    }
    return data
  })
  const font5 = files[8]
  const font6 = files[9]
  const fontWindow = new Uint8Array(0x20000)

  // ROM_CONTINUE 会将每颗芯片的两段 0x8000 字节分别放到 64-bit 总线的相邻 word lane。
  for (let group = 0; group < 0x4000; group++) {
    const dst = group * 8
    const src = group * 2
    fontWindow.set(font5.subarray(0x10000 + src, 0x10002 + src), dst)
    fontWindow.set(font5.subarray(0x18000 + src, 0x18002 + src), dst + 2)
    fontWindow.set(font6.subarray(0x10000 + src, 0x10002 + src), dst + 4)
    fontWindow.set(font6.subarray(0x18000 + src, 0x18002 + src), dst + 6)
  }

  const plans = [
    { source: 0, output: WOFCN_OUTPUTS[0], offset: 0x10000, lane: 0 },
    { source: 1, output: WOFCN_OUTPUTS[1], offset: 0x10000, lane: 1 },
    { source: 2, output: WOFCN_OUTPUTS[2], offset: 0x10000, lane: 2 },
    { source: 3, output: WOFCN_OUTPUTS[3], offset: 0x10000, lane: 3 },
    { source: 4, output: WOFCN_OUTPUTS[4], offset: 0x60000, lane: 0 },
    { source: 5, output: WOFCN_OUTPUTS[5], offset: 0x60000, lane: 1 },
    { source: 6, output: WOFCN_OUTPUTS[6], offset: 0x60000, lane: 2 },
    { source: 7, output: WOFCN_OUTPUTS[7], offset: 0x60000, lane: 3 },
  ]

  return plans.map(({ source, output, offset, lane }) => {
    const data = new Uint8Array(files[source])
    for (let group = 0; group < 0x4000; group++) {
      const src = group * 8 + lane * 2
      data.set(fontWindow.subarray(src, src + 2), offset + group * 2)
    }
    return { name: output, data }
  })
}

const WOFCN_ROM_DATA = `ZipName wofcn
DrvName wof
FullName "Tenchi wo Kurau II (Edition Chinese)"

tk2j23ccn.bin 0x080000 0xe1dd01d8 BRF_ESS BRF_PRG CPS1_68K_PROGRAM_NO_BYTESWAP
tk2j22c.bin 0x080000 0xb74b09ac BRF_ESS BRF_PRG CPS1_68K_PROGRAM_NO_BYTESWAP

wofcn_intro_gfx1.rom 0x080000 0x6421077b BRF_GRA CPS1_TILES
wofcn_intro_gfx3.rom 0x080000 0x2239f6eb BRF_GRA CPS1_TILES
wofcn_intro_gfx2.rom 0x080000 0xe54a0562 BRF_GRA CPS1_TILES
wofcn_intro_gfx4.rom 0x080000 0x9315de77 BRF_GRA CPS1_TILES
wofcn_actor_gfx1.rom 0x080000 0x4a96ae89 BRF_GRA CPS1_TILES
wofcn_actor_gfx2.rom 0x080000 0x58c8412b BRF_GRA CPS1_TILES
wofcn_actor_gfx3.rom 0x080000 0x91993928 BRF_GRA CPS1_TILES
wofcn_actor_gfx4.rom 0x080000 0x11111d7c BRF_GRA CPS1_TILES

tk2_qa.rom 0x020000 0xc9183a0d BRF_PRG CPS1_Z80_PROGRAM

tk2_q1.rom 0x080000 0x611268cf BRF_SND CPS1_QSOUND_SAMPLES
tk2_q2.rom 0x080000 0x20f55ca9 BRF_SND CPS1_QSOUND_SAMPLES
tk2_q3.rom 0x080000 0xbfcf6f52 BRF_SND CPS1_QSOUND_SAMPLES
tk2_q4.rom 0x080000 0x36642e88 BRF_SND CPS1_QSOUND_SAMPLES

buf1 0x000117 0xeb122de7 BRF_OPT
ioa1 0x000117 0x59c7ee3b BRF_OPT
prg2 0x000117 0x4386879a BRF_OPT
rom1 0x000117 0x41dc73b9 BRF_OPT
tk263b.1a 0x000117 0xc4b0349b BRF_OPT
iob1.12d 0x000117 0x3abc0700 BRF_OPT
bprg1.11d 0x000117 0x31793da7 BRF_OPT
ioc1.ic1 0x000117 0x0d182081 BRF_OPT`

export const ARCADE_HACKS: ArcadeHack[] = [
  {
    zipName: 'wofcn',
    driver: 'wof',
    platform: 'arcade',
    title: '吞食天地II 赤壁之战（中文版）',
    note: 'HBMAME tk2h5；按程序与两颗字库 ROM 指纹合成 CPS1 字形，仅作用于 wofcn.zip',
    // 保留 ROM 专属标记，以便忽略可能遗留在游戏级字段中的旧版错误 RomData。
    romDataScope: 'rom',
    // 换掉的程序 ROM + 两块新增中文字库，三个一起出现才算它。
    fingerprint: [0xe1dd01d8, 0xec6e8689, 0x722787df],
    romData: WOFCN_ROM_DATA,
    derive: {
      inputs: [...WOFCN_INPUTS],
      outputs: [...WOFCN_OUTPUTS],
      run: deriveWofcnGraphics,
    },
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

/** 按 ZIP 短名找到 ROM 专属改版；有加载方案时可选核心，也用于隔离历史专属配置。 */
export function romScopedHackForName(zipName: string | undefined): ArcadeHack | null {
  if (!zipName?.trim()) return null
  const normalized = zipName.trim().replace(/\.zip$/i, '').toLowerCase()
  return ARCADE_HACKS.find((hack) => hack.romDataScope === 'rom' && hack.zipName.toLowerCase() === normalized) ?? null
}
