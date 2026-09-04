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
 * ── 那两块中文字库装到哪 ─────────────────────────────────────
 * 它们不是替换、是新增：各 512KB，92% 是零，数据只落在 0x010000..0x019BFF。
 *
 * ⚠️ **不能用 CPS1_EXTRA_TILES_400000**（一开始就是这么写的，是错的）。对着 FBNeo
 * 源码（d_cps1.cpp 的 “Extra Tile Roms” 一段、cps.cpp 的 CpsInit / CpsLoadTiles）
 * 核过之后，这条路对 wofj 走不通，三个理由，一个比一个致命：
 *
 * 1. 那个循环的下标是**按位置算的**：i 从 (68K + tiles + z80 + qsound) 条起，
 *    只扫 nCpsExtraTilesRomNum 条。把两行放在清单末尾（PLD 之后），循环根本扫不到 ——
 *    一个字节都不会装，而且静默无效，没有任何报错。
 * 2. CpsLoadTiles(CpsGfx + 0x400000, i) 固定读 i..i+3 四条，中文包只有两块，
 *    紧跟其后的两条会被当图形数据 OR 进去。
 * 3. 最要命的一条：CpsGfx 是一整块连续内存，CpsRom = CpsGfx + nCpsGfxLen
 *    （cps.cpp CpsInit），而 nCpsGfxLen **只统计 CPS1_TILES**，不含 extra。
 *    wofj 的图形正好 8×0x80000 = 0x400000 —— 也就是说 CpsGfx + 0x400000 就是
 *    68K 程序的起点。那段代码第一句 memset(CpsGfx + 0x400000, 0, nCpsExtraGfxLen)
 *    会把刚装好的程序 / Z80 / QSound 全部清零，游戏连开机都做不到。
 *    FBNeo 里用这个类型的四个 set 全是 sf2 的盗版板，图形有 0x600000，
 *    0x400000 那一段还在图形区**里面** —— 这个前提对 wofj 不成立。
 *
 * ✅ 改成**把图形组接长**。RomData 换掉的是整份清单，所以「有几块图形」由清单说了算：
 *    在 8 块日版图形后面再接一组 4 条（下标 10~13），nCpsGfxLen 就变成 0x600000，
 *    第三组正好装到 CpsGfx + 0x400000 —— 和 extra 那条路想去的位置分毫不差，
 *    但这回内存是算过的（0x400000 + 0x200000 == nCpsGfxLen，一字节不越界），
 *    并且 nCpsGfxMask 跟着变宽到 0x7FFFFF，程序才寻址得到 0x400000 以上的图块。
 *
 * ⚠️ 图形行必须**紧跟程序行**，中间不能插别的类型：装载循环的下标同样是按位置算的
 *    （i 从 68K 条数起，扫 nCpsTilesRomNum 条）。PLD 那些 BRF_OPT 行不参与这套算术，
 *    放最后即可。
 *
 * ── 还没定下来的（等实测）───────────────────────────────────
 * 一组 4 条里，前两条填 16x16 图块的**左**半边（Tile，plane 0-1 / 2-3），
 * 后两条填右半边（Tile+4）。中文包只有两块，所以第 3、4 条这里**重复写了同两个文件**，
 * 让左右半边一样。这纯粹是猜 —— HBMAME 的 tk2h5 自己都在源码里注明
 * “The load procedure for the chinese language is unknown”。
 * 如果 FBNeo 的 zip 装载不允许同一个成员被两条清单项各用一次（有的实现会把用过的
 * 成员标掉），后两条只是装载失败、不写入 —— 退化成「只填左半边」，一样起得来。
 * 实测要是字形花 / 错位，下一个候选是把第 3、4 条换成两条 0x80000 的占位行
 * （`BRF_OPT BRF_NODUMP CPS1_TILES`，文件名随便写，包里没有 → 不装也不拦启动），
 * 只填左半边再看。**玩家上传的原始包始终不用动。**
 */
const WOFCN_ROMDATA = `// Tenchi wo Kurau II (Edition Chinese) —— HBMAME 的 tk2h5
// 基础驱动是日版 wofj。两块中文字库不走 CPS1_EXTRA_TILES_400000（对 wofj 会清掉程序区，
// 见上面注释），而是当第三组 CPS1_TILES 接在 8 块日版图形后面，落到 CpsGfx+0x400000。
// 顺序有意义：程序 → 图形（12 条）→ Z80 → QSound → PLD，中间不能插别的类型。
// FullName 必须加引号：romdata.cpp 用 strqtoken 按空格、制表、换行、逗号、%:|{} 切词，不加引号只会取到第一个词。

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

// 第三组：装到 CpsGfx + 0x400000。左半边 = 前两条，右半边 = 后两条（重复同两块，待实测）
tk2_gfx5cn.rom       0x080000   0xec6e8689   BRF_GRA CPS1_TILES
tk2_gfx6cn.rom       0x080000   0x722787df   BRF_GRA CPS1_TILES
tk2_gfx5cn.rom       0x080000   0xec6e8689   BRF_GRA CPS1_TILES
tk2_gfx6cn.rom       0x080000   0x722787df   BRF_GRA CPS1_TILES

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
