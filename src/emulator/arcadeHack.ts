/**
 * 玩家上传的街机改版包：认出它，并在有已验证加载方案时按要求准备文件。
 *
 * ── 为什么这一步必须有 ───────────────────────────────────────
 * FBNeo 靠**压缩包名**认游戏，改版包（汉化版、修改版）不在它的驱动表里，
 * 叫什么名字都是「Romset is unknown」。唯一的出路是 RomData：一份 .dat 写明
 * ZipName / DrvName / 完整 ROM 清单，核心据此把某个现有驱动寄生成这个包名。
 *
 * 入库的游戏可以由管理员在后台贴一份 dat（Game.arcadeRomData）。而「玩本地 ROM」
 * 这一路上没有任何地方能带 dat —— 所以在这之前，**任何非标准街机包在本地页上
 * 都必然失败**，和包对不对毫无关系。这个模块补的就是这个缺口：拿包里的 CRC 比一遍
 * 指纹表（data/arcadeHacks.ts），有加载方案时才自动配好 dat 和包名；只有识别指纹但没有
 * 方案的包会明确报出，不伪装成可运行游戏。
 *
 * ── 为什么要改文件名 ─────────────────────────────────────────
 * dat 里的 ZipName 和实际的包名必须一致：核心会 BurnDrvSetZipName(ZipName)，
 * 然后去找**那个名字**的包。而 emulatorjs 适配器把本地 File 的 name 直接当包名
 * 递给引擎（见 adapters/emulatorjs.ts 的 engineGameName）。玩家手里的文件
 * 十有八九叫「吞食天地2中文版.zip」，不改名就一定对不上。
 * File 是不可变的，所以这里重新包一个同内容、换名字的 File 出去。
 *
 * ── 为什么还要往包里塞合成 ROM ───────────────────────────────
 * 有些改版包的 RomData 会引用由多个原始成员合成的产物。识别到带 derive 的条目时，
 * 先在这里生成并追加产物，再把包交给引擎。
 * **玩家上传的原始文件始终不动**（File 不可变，这里产出的是新 File）。
 */
import { appendZipEntries, extractZipEntry, type ZipFileEntry } from '@/lib/unzip'
import { prepareArcadeArchive } from '@/lib/arcadeArchive'
import { matchArcadeHack, type ArcadeHack, type ArcadeHackDerive } from '@/data/arcadeHacks'

export interface ArcadeHackMatch {
  /** 普通 ZIP 只需拍平时为空；已识别改版包时含其专属加载方案（可能尚未验证可运行）。 */
  hack: ArcadeHack | null
  /** 必要时已安全拍平、改好 romset 名、补上合成 ROM 的文件，直接递给播放器 */
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
 * RomData、改了包名，**没跑合成**，而 dat 里引用的偏偏就是合成产物，于是核心按 dat 找合成 ROM，包里根本没有这些文件，
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
 * 检查并准备本地街机 ZIP。有效 ZIP 的目录层会安全拍平；不安全路径、重名覆盖和坏包
 * 抛给界面明确说明，不能静默当作普通包交给核心后再变成难懂的 missing files。
 * 不是已知改版且无需拍平的普通 ZIP 仍返回 null，保持原来的零拷贝快速路径。
 */
export async function matchLocalArcadeHack(file: File): Promise<ArcadeHackMatch | null> {
  if (!/\.zip$/i.test(file.name)) return null
  // 普通包只读 ZIP 元数据；只有需要现场合成的少数改版才申请整份连续内存。
  const prepared = await prepareArcadeArchive(file)
  const hack = matchArcadeHack(prepared.entries.map((e) => e.crc32))
  let output: Blob = prepared.blob

  if (hack?.derive) {
    const buf = await prepared.blob.arrayBuffer()
    const merged = await deriveArcadeHackBytes(buf, prepared.entries, hack)
    if (merged) output = new Blob([merged as BlobPart], { type: file.type || 'application/zip' })
  }

  const wanted = hack ? `${hack.zipName}.zip` : file.name
  const changed = prepared.flattenedCount > 0 || output !== file || wanted !== file.name
  if (!hack && !changed) return null

  // File 包 File 只建 Blob 视图，不会为普通包额外复制整份 ROM 到 JS 堆。
  const result = changed ? new File([output], wanted, { type: file.type || 'application/zip' }) : file
  return { hack, file: result }
}
