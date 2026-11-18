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
 * 有些改版包光靠一份 dat 救不回来，还得**先合成几块新 ROM**。
 * 见下面 wofcn 的注释：它那两块中文字库是「只盖住原图形 ROM 一个窗口」的补丁片，
 * 而 FBNeo 的 CpsLoadOne 是 `|=` 而不是覆盖，包里也没有第二份原图形可用 ——
 * 只能在把包递给核心之前，离线把窗口合并好。
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

   基础是**日版 wofj**（不是世界版 wof，也不是 CPS Changer 版 wofch）：包里的图形是
   日版那一组，第二颗程序 ROM 也是日版的 b74b09ac。换掉的只有第一颗程序 ROM
   （tk2j23c → tk2j23ccn，差异 6619 字节 / 22 段，全是脚本和文本渲染），
   另外**新增**两块带中文字库的图形 ROM。

   ── 两块中文字库如何接入四个图形通道 ────────────────────────────────────

   HBMAME 的 tk2h5 定义把 gfx5 的后两段分别续载到 64-bit 图形区偏移
   `0x400000`、`0x400002`，gfx6 的两段续载到 `0x400004`、`0x400006`。
   后面有两条注释掉的 ROM_COPY，说明这块 4 通道数据原本打算复制到游戏字库区。
   FBNeo 的 CPS1_TILES 每四条清单项组成一组，顺序对应 gfx1、gfx3、gfx2、gfx4；
   因此不能把两颗芯片各自当成一条完整位平面，也不能只替换前两个通道。

   运行时按 HBMAME 的续载顺序还原这四条通道，并将每条写入对应 ROM 的字库窗口：

     gfx1 ← gfx5[0x10000..0x17fff]
     gfx3 ← gfx5[0x18000..0x1ffff]
     gfx2 ← gfx6[0x10000..0x17fff]
     gfx4 ← gfx6[0x18000..0x1ffff]

   每条通道覆盖目标 ROM 的 `0x010000..0x017fff`，这是 scroll1 图块号 `0x1000`
   起始位置在原始图形 ROM 中对应的窗口。其余原图形字节保留。

   ── 装到哪：0x040000，不是 0x400000 ──────────────────────────────────────

   曾经把它们当**第三组 CPS1_TILES** 接在 8 块日版图形后面（落到 CpsGfx+0x400000）。
   那是错的，而且错得很隐蔽 —— 内存是够了，但**那段图形永远不会被取用**：
   `cps_config.cpp` 里 `mapper_TK263B` 的 `GfxBankSizes = {0x8000, 0x8000, 0, 0}`，
   范围表只有 `Code 0x00000..0x07fff → bank 0`、`0x08000..0x0ffff → bank 1` 两行，
   **没有 bank 2**；而 `GfxRomBankMapper()` 一行都不命中就返回 -1，
   `Cps1Scr1Draw` / `Cps1Scr3Draw` / `Cps1ObjDraw` 全都是 `if (t == -1) continue;`。
   也就是说这块 B 板可寻址的图形硬顶在 0x400000 字节。截图里那些灰白碎块根本不是
   中文字库，是图块号被折回 bank 0/1 之后取到的日版原有图形。

   真正的地址从**程序补丁**里挖出来了：脚本按小端 16-bit 存图块号，日版是
   `0xd1xx..0xd4xx`（正好等于日版 scroll1 字库所在的单元 0x0d166..0x0d4ed），
   中文版换成了 `0x10xx..0x18xx`。取 base = **0x1000** 解开场旁白，出来的是
   「距今〔…〕年前，刘邦建立汉朝。」「汉朝分裂，天下」「刘备复兴了汉王朝。」—— 对上了。

     scroll1 图块号 0x1000 → CpsGfx 偏移 0x1000 << 6 = 0x040000
     第一组图形基址是 0，CpsLoadOne 每 2 ROM 字节推进 8 字节
     → ROM 文件偏移 = 0x040000 / 4 = 0x010000   ← 正好是中文数据所在的位置

   所以那两块「新增」ROM 是四条图形通道的补丁来源。ROM_CONTINUE 将每颗芯片的
   数据拆成两段送到不同通道；只把整段数据覆盖进 gfx1 / gfx3 会使通道错位。
   HBMAME 还把同一份字库分别复制到开场文字窗口 `0x040000` 和人物介绍窗口
   `0x380000`。只合成第一组图形 ROM 会漏掉第二处；人物文字仍会读到原日文图块，
   屏幕上就会出现灰色碎块。两处都按 CPS1 四通道顺序单独合成，且只对 wofcn ROM 生效。

   ── 为什么必须离线合并，不能直接把中文 ROM 列进 dat ────────────────────────

   两个原因，各自都是致命的：
   1. `CpsLoadOne` 写入用 `*((UINT32 *)pt) |= Pix`，是 **OR 不是覆盖**。原图形在
      那个窗口里不是零，直接把中文补丁片当 ROM 会叠出错误图形。
   2. 中文 ROM 窗口之外全是零。真拿它当完整图形 ROM，会把对应通道其余图形清空。
   所以递给核心之前要把四条通道分别合并回各自原图形 ROM，dat 再按 FBNeo 的顺序引用。
   **玩家上传的原始包一个字节都不用改。**

   ── 代价 ────────────────────────────────────────────────────────────────
   单元 0x1000..0x17FF 的原图形窗口被字库覆盖，这是改版 ROM 自带的映射。 */

/** 字库覆盖到两组 CPS1 图形 ROM 中的窗口；偏移由 HBMAME 的 ROM_COPY 地址换算。 */
const WOFCN_FONT_WINDOWS = [
  { name: 'intro', start: 0x010000 }, // 0x040000 / 每个 ROM 字节展开为 4 字节
  { name: 'actor', start: 0x060000 }, // (0x380000 - 第二组基址 0x200000) / 4
] as const
const WOFCN_FONT_WINDOW_SIZE = 0x008000

const WOFCN_DERIVE: ArcadeHackDerive = {
  inputs: [
    'tk2_gfx1.rom', 'tk2_gfx3.rom', 'tk2_gfx2.rom', 'tk2_gfx4.rom',
    'tk205.bin', 'tk206.bin', 'tk207.bin', 'tk208.bin',
    'tk2_gfx5cn.rom', 'tk2_gfx6cn.rom',
  ],
  // 文件名刻意带位置和 lane，避免旧版只修开场的四个预处理成员被误认成完整产物。
  outputs: [
    'tk2h5_intro_lane0.rom', 'tk2h5_intro_lane2.rom', 'tk2h5_intro_lane4.rom', 'tk2h5_intro_lane6.rom',
    'tk2h5_actor_lane0.rom', 'tk2h5_actor_lane2.rom', 'tk2h5_actor_lane4.rom', 'tk2h5_actor_lane6.rom',
  ],
  run(inputs) {
    // 顺序严格对应 CPS1 的 lane 0/2/4/6 和 FBNeo 每四项一组的 ROM 清单。
    const lanes: [string, string, number, 'intro' | 'actor', string][] = [
      ['tk2_gfx1.rom', 'tk2_gfx5cn.rom', 0x10000, 'intro', 'tk2h5_intro_lane0.rom'],
      ['tk2_gfx3.rom', 'tk2_gfx5cn.rom', 0x18000, 'intro', 'tk2h5_intro_lane2.rom'],
      ['tk2_gfx2.rom', 'tk2_gfx6cn.rom', 0x10000, 'intro', 'tk2h5_intro_lane4.rom'],
      ['tk2_gfx4.rom', 'tk2_gfx6cn.rom', 0x18000, 'intro', 'tk2h5_intro_lane6.rom'],
      ['tk205.bin', 'tk2_gfx5cn.rom', 0x10000, 'actor', 'tk2h5_actor_lane0.rom'],
      ['tk206.bin', 'tk2_gfx5cn.rom', 0x18000, 'actor', 'tk2h5_actor_lane2.rom'],
      ['tk207.bin', 'tk2_gfx6cn.rom', 0x10000, 'actor', 'tk2h5_actor_lane4.rom'],
      ['tk208.bin', 'tk2_gfx6cn.rom', 0x18000, 'actor', 'tk2h5_actor_lane6.rom'],
    ]
    return lanes.map(([baseName, patchName, sourceStart, windowName, outName]) => {
      const base = inputs[baseName]
      const patch = inputs[patchName]
      if (!base || !patch) throw new Error(`wofcn: 合成字库缺少 ${!base ? baseName : patchName}`)
      const window = WOFCN_FONT_WINDOWS.find((candidate) => candidate.name === windowName)
      if (
        !window ||
        base.length < window.start + WOFCN_FONT_WINDOW_SIZE ||
        patch.length < sourceStart + WOFCN_FONT_WINDOW_SIZE
      ) {
        throw new Error(`wofcn: ${baseName} / ${patchName} 长度不足`)
      }
      const out = new Uint8Array(base) // 复制一份，别改调用方的 buffer
      out.set(patch.subarray(sourceStart, sourceStart + WOFCN_FONT_WINDOW_SIZE), window.start)
      return { name: outName, data: out }
    })
  },
}

const WOFCN_ROMDATA = `// Tenchi wo Kurau II (Edition Chinese) —— HBMAME 的 tk2h5，基础驱动是日版 wofj
// 八个合成 ROM 分别把同一字库写入开场窗口和人物介绍窗口，按 HBMAME ROM_COPY 地址对齐。
// 每一组按 lane 0/2/4/6 排列；FBNeo 每四条 CPS1_TILES 清单项组成一组，顺序不能交换。
// 顺序有意义：程序 → 图形（8 条）→ Z80 → QSound → PLD，中间不能插别的类型。
// FullName 必须加引号：romdata.cpp 用 strqtoken 按空格、制表、换行、逗号、%:|{} 切词。

ZipName    wofcn
DrvName    wofj
FullName   "Tenchi wo Kurau II (Edition Chinese)"

tk2j23ccn.bin        0x080000   0xe1dd01d8   BRF_ESS BRF_PRG CPS1_68K_PROGRAM_NO_BYTESWAP
tk2j22c.bin          0x080000   0xb74b09ac   BRF_ESS BRF_PRG CPS1_68K_PROGRAM_NO_BYTESWAP

// 顺序要和 HBMAME 四条 64-bit lane 一致，不能将 gfx5/gfx6 当成两条连续 plane
tk2h5_intro_lane0.rom 0x080000   0x6421077b   BRF_GRA CPS1_TILES
tk2h5_intro_lane2.rom 0x080000   0x2239f6eb   BRF_GRA CPS1_TILES
tk2h5_intro_lane4.rom 0x080000   0xe54a0562   BRF_GRA CPS1_TILES
tk2h5_intro_lane6.rom 0x080000   0x9315de77   BRF_GRA CPS1_TILES
tk2h5_actor_lane0.rom 0x080000   0x4a96ae89   BRF_GRA CPS1_TILES
tk2h5_actor_lane2.rom 0x080000   0x58c8412b   BRF_GRA CPS1_TILES
tk2h5_actor_lane4.rom 0x080000   0x91993928   BRF_GRA CPS1_TILES
tk2h5_actor_lane6.rom 0x080000   0x11111d7c   BRF_GRA CPS1_TILES

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
