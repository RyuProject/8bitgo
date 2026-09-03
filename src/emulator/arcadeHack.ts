/**
 * 玩家上传的街机改版包：认出它，并把它变成核心真的能跑的样子。
 *
 * ── 为什么这一步必须有 ───────────────────────────────────────
 * FBNeo 靠**压缩包名**认游戏，改版包（汉化版、修改版）不在它的驱动表里，
 * 叫什么名字都是「Romset is unknown」。唯一的出路是 RomData：一份 .dat 写明
 * ZipName / DrvName / 完整 ROM 清单，核心据此把某个现有驱动寄生成这个包名。
 *
 * 入库的游戏可以由管理员在后台贴一份 dat（Game.arcadeRomData）。而「玩本地 ROM」
 * 这一路上没有任何地方能带 dat —— 所以在这之前，**任何非标准街机包在本地页上
 * 都必然失败**，和包对不对毫无关系。这个模块补的就是这个缺口：拿包里的 CRC 比一遍
 * 指纹表（data/arcadeHacks.ts），认出来就自动配好 dat 和包名。
 *
 * ── 为什么要改文件名 ─────────────────────────────────────────
 * dat 里的 ZipName 和实际的包名必须一致：核心会 BurnDrvSetZipName(ZipName)，
 * 然后去找**那个名字**的包。而 emulatorjs 适配器把本地 File 的 name 直接当包名
 * 递给引擎（见 adapters/emulatorjs.ts 的 engineGameName）。玩家手里的文件
 * 十有八九叫「吞食天地2中文版.zip」，不改名就一定对不上。
 * File 是不可变的，所以这里重新包一个同内容、换名字的 File 出去。
 */
import { isZip, listZipEntries } from '@/lib/unzip'
import { matchArcadeHack, type ArcadeHack } from '@/data/arcadeHacks'

export interface ArcadeHackMatch {
  hack: ArcadeHack
  /** 按 hack.zipName 改好名的同内容文件，直接递给播放器 */
  file: File
}

/**
 * 认一个本地街机包。不是 zip、认不出、或者读取失败都返回 null ——
 * 这一步是锦上添花，不能把「拖个文件进来就能玩」搞挂。
 */
export async function matchLocalArcadeHack(file: File): Promise<ArcadeHackMatch | null> {
  if (!/\.zip$/i.test(file.name)) return null
  try {
    const buf = await file.arrayBuffer()
    if (!isZip(buf)) return null
    const hack = matchArcadeHack(listZipEntries(buf).map((e) => e.crc32))
    if (!hack) return null
    const wanted = `${hack.zipName}.zip`
    // 名字已经对了就别白复制一份几 MB 的 File
    const renamed = file.name === wanted ? file : new File([buf], wanted, { type: file.type })
    return { hack, file: renamed }
  } catch (err) {
    console.warn('[arcade] 改版包识别失败，按原文件走：', err)
    return null
  }
}
