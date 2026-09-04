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
 *
 * ── 为什么还要往包里塞合成 ROM ───────────────────────────────
 * 有些改版包新增的 ROM 不是「一整块图形」，而是「只盖住原图形一个窗口的补丁片」
 * （wofcn 的两块中文字库就是，推导见 data/arcadeHacks.ts）。而 FBNeo 的
 * CpsLoadOne 写入用 `|=`，是 OR 不是覆盖，补丁片窗口外又全是零 —— 直接列进 dat
 * 会同时踩两个坑。所以识别到带 derive 的条目时，先在这里把窗口合并好，
 * 把合成产物追加进递给引擎的包，dat 里引用合成产物。
 * **玩家上传的原始文件始终不动**（File 不可变，这里产出的是新 File）。
 */
import { isZip, listZipEntries, extractZipEntry, appendZipEntries, type ZipFileEntry } from '@/lib/unzip'
import { matchArcadeHack, type ArcadeHack, type ArcadeHackDerive } from '@/data/arcadeHacks'

export interface ArcadeHackMatch {
  hack: ArcadeHack
  /** 按 hack.zipName 改好名、必要时已补上合成 ROM 的文件，直接递给播放器 */
  file: File
}

/** 按 derive.inputs 解出需要的成员，跑一遍合成 */
async function runDerive(
  buf: ArrayBuffer,
  entries: readonly ZipFileEntry[],
  derive: ArcadeHackDerive,
): Promise<{ name: string; data: Uint8Array }[]> {
  const inputs: Record<string, Uint8Array> = {}
  for (const name of derive.inputs) {
    // 包里可能有目录前缀（有人打包时多套了一层文件夹），按 basename 兜一次
    const entry =
      entries.find((e) => e.name === name) ?? entries.find((e) => e.name.split('/').pop() === name)
    if (!entry) throw new Error(`合成需要的 ${name} 不在包里`)
    inputs[name] = await extractZipEntry(buf, entry)
  }
  return derive.run(inputs)
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
    const entries = listZipEntries(buf)
    const hack = matchArcadeHack(entries.map((e) => e.crc32))
    if (!hack) return null

    const wanted = `${hack.zipName}.zip`
    if (!hack.derive) {
      // 名字已经对了就别白复制一份几 MB 的 File
      const renamed = file.name === wanted ? file : new File([buf], wanted, { type: file.type })
      return { hack, file: renamed }
    }

    const derived = await runDerive(buf, entries, hack.derive)
    const merged = appendZipEntries(buf, derived)
    return { hack, file: new File([merged as BlobPart], wanted, { type: file.type }) }
  } catch (err) {
    console.warn('[arcade] 改版包识别失败，按原文件走：', err)
    return null
  }
}
