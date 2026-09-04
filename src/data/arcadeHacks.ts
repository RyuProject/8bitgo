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

   ── 那两块中文字库到底是什么（2026-09-04 逐字节逆向，已实测确认）──────────

   各 512KB，但数据只在 `0x010000..0x019BFF`（0x9C00 = 39936 字节），其余全零。

     tk2_gfx5cn.rom   每个 16-bit 字都是 (S,S) —— 字节成对重复
     tk2_gfx6cn.rom   每个字是 (S,T) —— 偶字节和 gfx5 完全相同，奇字节是另一条流

   去掉冗余只有**两条位平面流** S、T，各 19968 字节。位级统计：`S=0 且 T=1`
   出现 0 次（T 的零集严格包含 S 的零集），于是只有三态 —— 这正好对上
   CpsLoadTiles 的前两条清单项（都写 Tile+0 的左 8 列，nShift 分别是 0 和 2），
   得到 plane0=plane1=plane2=S、plane3=T，像素值 `7S + 8T`：

     S=1 T=1 → 色号 15（CPS1 的透明色，背景）
     S=1 T=0 → 色号 7 （描边）
     S=0 T=0 → 色号 0 （字身）

   几何：每字节 = 8 个横向像素（CpsLoadOne 每 2 字节出一行 8 像素），8 字节 =
   一个 8x8 图块，图块按 **16 块宽（128px）的贴图表**排列共 156 行，一个汉字
   = 2x2 图块，合计 **624 个简体汉字**（第一个是「的」）。
   字 c 的四个单元下标：`u = 32*(c/8) + 2*(c%8)`，四象限 = `u, u+1, u+16, u+17`。

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

   所以那两块「新增」ROM 其实是 **tk2_gfx1.rom（清单第 0 条，左半边 plane 0/1）和
   tk2_gfx3.rom（第 1 条，左半边 plane 2/3）的窗口补丁片**，整块装载时数据自然
   落到 0x040000。HBMAME 那句 “The load procedure for the chinese language is
   unknown” 底下用 ROM_CONTINUE / ROM_IGNORE，就是为了**只把这个窗口盖上去**。

   ── 为什么必须离线合并，不能直接把中文 ROM 列进 dat ────────────────────────

   两个原因，各自都是致命的：
   1. `CpsLoadOne` 写入用 `*((UINT32 *)pt) |= Pix`，是 **OR 不是覆盖**。原图形在
      那个窗口里不是零，OR 上去只会得到两张图叠在一起。
   2. 中文 ROM 窗口之外全是零。真拿它当第 0 条清单项，第一组图形其余部分的
      plane 0/1 左半边会被整片抹平 —— 画面直接废。
   包里又没有第二份原始 gfx1 可用，所以只能在递给核心之前把窗口合并好，
   合成两块新 ROM（下面 WOFCN_DERIVE），dat 里引用合成产物。
   **玩家上传的原始包一个字节都不用改。**

   ── 代价 ────────────────────────────────────────────────────────────────
   单元 0x1000..0x19BF 那段原图形的**左半边**被换成了字库（右半边还是
   tk2_gfx2 / tk2_gfx4 的原内容）。真机上这个 Hack 就是这么干的，属于改版包
   自带的取舍，不是我们引入的。 */

/** 中文字库在两块补丁片里的字节窗口 —— 也就是要盖到原图形 ROM 上的那一段 */
const WOFCN_FONT_WINDOW = { start: 0x010000, end: 0x019c00 } as const

const WOFCN_DERIVE: ArcadeHackDerive = {
  inputs: ['tk2_gfx1.rom', 'tk2_gfx3.rom', 'tk2_gfx5cn.rom', 'tk2_gfx6cn.rom'],
  run(inputs) {
    const { start, end } = WOFCN_FONT_WINDOW
    // (原图形, 中文补丁片, 合成后的名字) —— 顺序对应清单第 0、1 条
    const pairs: [string, string, string][] = [
      ['tk2_gfx1.rom', 'tk2_gfx5cn.rom', 'tk2_gfx1cn.rom'],
      ['tk2_gfx3.rom', 'tk2_gfx6cn.rom', 'tk2_gfx3cn.rom'],
    ]
    return pairs.map(([baseName, patchName, outName]) => {
      const base = inputs[baseName]
      const patch = inputs[patchName]
      if (!base || !patch) throw new Error(`wofcn: 合成字库缺少 ${!base ? baseName : patchName}`)
      if (base.length < end || patch.length < end) throw new Error(`wofcn: ${baseName} / ${patchName} 长度不足`)
      const out = new Uint8Array(base) // 复制一份，别改调用方的 buffer
      out.set(patch.subarray(start, end), start)
      return { name: outName, data: out }
    })
  },
}

const WOFCN_ROMDATA = `// Tenchi wo Kurau II (Edition Chinese) —— HBMAME 的 tk2h5，基础驱动是日版 wofj
// tk2_gfx1cn.rom / tk2_gfx3cn.rom 是**合成产物**：原 tk2_gfx1 / tk2_gfx3 的
// 0x010000..0x019BFF 换成 tk2_gfx5cn / tk2_gfx6cn 的同一段（中文字库）。
// 见 arcadeHacks.ts 里的推导 —— 字库要落在 scroll1 图块号 0x1000（CpsGfx+0x040000），
// 而 TK263B 的 mapper 只有两个 bank，0x400000 以上取不到，所以没有第三组图形。
// 顺序有意义：程序 → 图形（8 条）→ Z80 → QSound → PLD，中间不能插别的类型。
// FullName 必须加引号：romdata.cpp 用 strqtoken 按空格、制表、换行、逗号、%:|{} 切词。

ZipName    wofcn
DrvName    wofj
FullName   "Tenchi wo Kurau II (Edition Chinese)"

tk2j23ccn.bin        0x080000   0xe1dd01d8   BRF_ESS BRF_PRG CPS1_68K_PROGRAM_NO_BYTESWAP
tk2j22c.bin          0x080000   0xb74b09ac   BRF_ESS BRF_PRG CPS1_68K_PROGRAM_NO_BYTESWAP

// 第 0 条 = 左半边 plane 0/1，第 1 条 = 左半边 plane 2/3 —— 中文字库只占这两条
tk2_gfx1cn.rom       0x080000   0x6842b51b   BRF_GRA CPS1_TILES
tk2_gfx3cn.rom       0x080000   0x338eb7c9   BRF_GRA CPS1_TILES
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
