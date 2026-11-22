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
 * 有些改版包新增的 ROM 是分散的图形补丁片（wofcn 的中文字库就是，推导见
 * data/arcadeHacks.ts）。这里按核心的 ROM 行格式把它们合成独立 bank，避免
 * 覆盖原版图形；识别到带 derive 的条目时，把产物追加进递给引擎的包，dat 引用它们。
 * **玩家上传的原始文件始终不动**（File 不可变，这里产出的是新 File）。
 */
import { appendZipEntries, extractZipEntry, type ZipFileEntry } from '@/lib/unzip'
import { prepareArcadeArchive } from '@/lib/arcadeArchive'
import { matchArcadeHack, type ArcadeHack, type ArcadeHackDerive } from '@/data/arcadeHacks'

export interface ArcadeHackMatch {
  hack: ArcadeHack | null
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
 * 带 `derive` 的改版包：把合成产物追加进包，返回新的字节；不需要合成返回 null。
 *
 * **本地包和入库的包两条路都必须走这里。** 以前只有本地那条接了 —— 入库这条只套了
 * RomData、改了包名，**没跑合成**，而 dat 里引用的偏偏就是合成产物（wofcn 的两块中文
 * 字库片），于是核心按 dat 去找合成图形 ROM，包里根本没有，
 * 必然两条 missing。管理员那边界面还绿字写着「✓ 识别为已知改版包」。
 *
 * ⚠️ **合成失败要抛，不能静默放行。** 放行的结果是 100% 起不来，而报错文案会指向
 * 完全无关的方向；抛出来至少能说清「这个包缺合成需要的成员」。
 */
export async function deriveArcadeHackBytes(
  buf: ArrayBuffer,
  entries: readonly ZipFileEntry[],
  hack: ArcadeHack,
): Promise<Uint8Array | null> {
  if (!hack.derive) return null
  // 已经烘好的包（scripts/prep-arcade-hack.mjs 离线合成过）就别再追加一遍
  const already = new Set(entries.map((e) => e.name.split('/').pop()))
  const outputs = hack.derive.outputs
  if (outputs.length > 0 && outputs.every((n) => already.has(n))) return null
  const derived = await runDerive(buf, entries, hack.derive)
  return appendZipEntries(buf, derived)
}

/**
 * 校验本地街机包并识别已知改版。普通根目录 ZIP 只读目录元数据；嵌套成员会安全拍平。
 * 无效 ZIP / 不安全路径 / 必需合成成员缺失必须抛给播放器，不能静默把坏包交给核心。
 */
export async function matchLocalArcadeHack(file: File): Promise<ArcadeHackMatch | null> {
  if (!/\.zip$/i.test(file.name)) return null
  // 本地文件也要和远端共用路径安全校验及目录拍平；平目录包只读 ZIP 元数据，避免复制整份大 ROM。
  const prepared = await prepareArcadeArchive(file)
  const hack = matchArcadeHack(prepared.entries.map((entry) => entry.crc32))
  const normalized = prepared.flattenedCount
    ? new File([prepared.blob], file.name, { type: file.type })
    : file
  if (!hack) return prepared.flattenedCount ? { hack: null, file: normalized } : null

  const wanted = `${hack.zipName}.zip`
  if (!hack.derive) {
    // File 包 File 只建 Blob 视图，不像 ArrayBuffer 路径那样先复制一整份进 JS 堆。
    const renamed = normalized.name === wanted ? normalized : new File([normalized], wanted, { type: file.type })
    return { hack, file: renamed }
  }

  const buf = await prepared.blob.arrayBuffer()
  const merged = await deriveArcadeHackBytes(buf, prepared.entries, hack)
  return { hack, file: new File([(merged ?? buf) as BlobPart], wanted, { type: file.type }) }
}
