import { arcadeArchiveUnsafePathProblem } from './namcoSystem11'
import { identifyNamcoMameSet } from './namcoMameSets'
import { assertValidZipBlob, type ZipFileEntry } from './unzip'
import { rewriteZipEntries, type ZipRewriteItem } from './zipRewrite'

export interface FlattenArcadeZipResult {
  blob: Blob
  /** 实际从子目录移到 ZIP 根目录的文件数；为 0 时返回原始 Blob。 */
  flattenedCount: number
}

/**
 * 街机 ROM 必须在 ZIP 根目录。只重写 ZIP 头和文件名，压缩数据直接引用原 Blob 的切片，
 * 避免先解压再压缩造成大内存峰值和额外 CPU；有重名时拒绝自动处理，防止覆盖 ROM。
 */
export async function flattenArcadeZipBlob(blob: Blob, knownEntries?: readonly ZipFileEntry[]): Promise<FlattenArcadeZipResult> {
  /*
   * 上传器在拍平前还要用同一份中央目录做 romset 识别。普通包本来就没有子目录，
   * 如果这里再读一次尾部和每个本地头，会把“选文件后立刻开始上传”的等待翻倍。
   * 调用方传入的条目仍必须来自 assertValidZipBlob；这个默认分支留给独立调用，
   * 不能因为优化而把 ZIP 完整性检查变成可选。
   */
  const entries = knownEntries ?? await assertValidZipBlob(blob, '街机 ROM')
  const unsafe = arcadeArchiveUnsafePathProblem(entries)
  if (unsafe) throw new Error(unsafe)

  /*
   * 已核实的 Namco System 11/12 包（如 Tekken）把父集放在根目录、克隆集放在子目录。
   * MAME 会按 tekken.zip 只读取父集成员；重写整个 ZIP 虽然不改 ROM 字节，却会改变
   * 原始归档结构，而且容易把克隆 ROM 一并摊进目标 set。命中完整 CRC 指纹时保留原 Blob，
   * 后续识别会把游戏名纠正为 tekken.zip；其它包仍走常规拍平/重名保护。
   */
  if (identifyNamcoMameSet(entries)) return { blob, flattenedCount: 0 }

  const nestedCount = entries.reduce((count, entry) => count + Number(entry.name.includes('/')), 0)
  if (!nestedCount) return { blob, flattenedCount: 0 }

  const names = new Set<string>()
  const items: ZipRewriteItem[] = []
  for (const entry of entries) {
    const baseName = entry.name.split('/').pop() ?? ''
    // DOS/街机虚拟文件系统不接受路径字符；非 ASCII 仍以 UTF-8 保存。
    // eslint-disable-next-line no-control-regex -- ZIP 文件名中的控制字节不能进入模拟器虚拟文件系统。
    if (!baseName || baseName === '.' || baseName === '..' || /[\\/:\u0000-\u001f]/.test(baseName)) {
      throw new Error(`无法安全拍平 ZIP 成员“${entry.name}”；请先手动整理压缩包。`)
    }
    const foldedName = baseName.toLocaleLowerCase('en-US')
    if (names.has(foldedName)) {
      throw new Error(`自动拍平会让多个 ROM 重名：${baseName}。为避免覆盖文件，已取消上传；请保留正确的一份并重新打包。`)
    }
    names.add(foldedName)
    items.push({ entry, name: baseName })
  }

  return { blob: await rewriteZipEntries(blob, items, '拍平'), flattenedCount: nestedCount }
}
