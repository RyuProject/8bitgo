/**
 * 已知街机改版包的指纹表。
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
}

/**
 * 吞食天地II 赤壁之战 中文版。
 *
 * 基础是**日版 wofj**（不是世界版 wof，也不是 CPS Changer 版 wofch）：包里的图形是
 * 日版那一组（e4a44d53 / 58066ba8 / d706568e / d4a19a02），第二颗程序 ROM 也是日版的
 * b74b09ac。换掉的只有第一颗程序 ROM，另外**新增**两块带中文字库的图形 ROM。
 * 在 HBMAME 里这个 set 叫 tk2h5 “Tenchi wo Kurau II (Edition Chinese)”。
 *
 * ⚠️ 那两块中文图形不是替换、是新增 —— 它们各自 512KB 但 92% 是零，数据只落在
 * 0x010000..0x019BFF。FBNeo 对这种情况有专门的位置：类型标成 CPS1_EXTRA_TILES_400000
 * 的 ROM 会被装进 CpsGfx + 0x400000（见 FBNeo d_cps1.cpp 的 “Extra Tile Roms” 一段）。
 * 这段逻辑是**按 ROM 表驱动**的，不是写死在某个驱动里，所以 RomData 换掉整张表之后
 * 一样走得通，不需要自定义驱动。
 *
 * 那一段一次吃 4 个 ROM（源码里 `i += 4`），而中文包只有 2 块，所以清单里补两块全零的
 * 512KB 占位 —— 载入前那段内存本来就会被 memset 清零，补零不会画出任何东西。
 */
const WOFCN_ROMDATA = `// Tenchi wo Kurau II (Edition Chinese) —— HBMAME 的 tk2h5
// 基础驱动是日版 wofj；两块中文字库走 CPS1_EXTRA_TILES_400000 装到 CpsGfx+0x400000

ZipName    wofcn
DrvName    wofj
FullName   Tenchi wo Kurau II (Edition Chinese)

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

buf1                 0x000117   0xeb122de7   BRF_OPT
ioa1                 0x000117   0x59c7ee3b   BRF_OPT
prg2                 0x000117   0x4386879a   BRF_OPT
rom1                 0x000117   0x41dc73b9   BRF_OPT
tk263b.1a            0x000117   0xc4b0349b   BRF_OPT
iob1.12d             0x000117   0x3abc0700   BRF_OPT
bprg1.11d            0x000117   0x31793da7   BRF_OPT
ioc1.ic1             0x000117   0x0d182081   BRF_OPT

tk2_gfx5cn.rom       0x080000   0xec6e8689   BRF_GRA CPS1_EXTRA_TILES_400000
tk2_gfx6cn.rom       0x080000   0x722787df   BRF_GRA CPS1_EXTRA_TILES_400000
tk2_blank1.rom       0x080000   0x0a4f37b9   BRF_GRA CPS1_EXTRA_TILES_400000
tk2_blank2.rom       0x080000   0x0a4f37b9   BRF_GRA CPS1_EXTRA_TILES_400000
`

export const ARCADE_HACKS: ArcadeHack[] = [
  {
    zipName: 'wofcn',
    driver: 'wofj',
    platform: 'arcade',
    title: '吞食天地II 赤壁之战（中文版）',
    note: 'HBMAME: tk2h5 — Tenchi wo Kurau II (Edition Chinese)',
    // 换掉的程序 ROM + 两块新增的中文字库，三个一起出现才算它
    fingerprint: [0xe1dd01d8, 0xec6e8689, 0x722787df],
    romData: WOFCN_ROMDATA,
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
