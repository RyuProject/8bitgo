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

   HBMAME 将 tk2h5 挂在世界版 `wof` 父驱动下。此包替换了程序 ROM，并新增两块中文字库 ROM。
   HBMAME 源码仍将中文字库加载过程标为未知，源码中的 ROM_COPY 也处于注释状态。

   我在 FBNeo / EmulatorJS 中实测过多种拼接和位序转换：虽然能启动，但中文区域仍乱码，
   且会破坏开场图形。因此当前只记录确定的包指纹和父驱动，不自动注入未经验证的 RomData
   或图形补丁。等找到正确映射并验证游戏内文字与背景都正常后，再增加加载方案。
*/

export const ARCADE_HACKS: ArcadeHack[] = [
  {
    zipName: 'wofcn',
    driver: 'wof',
    platform: 'arcade',
    title: '吞食天地II 赤壁之战（中文版）',
    note: 'HBMAME tk2h5；中文字库加载映射尚未验证，暂不自动套用图形补丁',
    // 保留 ROM 专属标记，以便忽略可能遗留在游戏级字段中的旧版错误 RomData。
    romDataScope: 'rom',
    // 换掉的程序 ROM + 两块新增中文字库，三个一起出现才算它。
    fingerprint: [0xe1dd01d8, 0xec6e8689, 0x722787df],
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
