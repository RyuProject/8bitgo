import { flattenArcadeZipBlob } from './flattenArcadeZip'
import { assertValidZipBlob, type ZipFileEntry } from './unzip'

/**
 * 街机核心只在 ZIP 根目录按成员名找 ROM；套一层文件夹的成员等同于缺失。
 * 上传前拦住，比传完、打包完、部署后才从 MAME 的 NOT FOUND 日志里反推问题便宜得多。
 */
export function arcadeArchiveLayoutProblem(entries: readonly { name: string }[]): string | null {
  const nested = entries.filter((entry) => entry.name.includes('/'))
  if (!nested.length) return null
  const sample = nested.slice(0, 3).map((entry) => entry.name).join('、')
  return (
    `ZIP 里有 ${nested.length} 个文件套在子目录中（例如 ${sample}）。` +
    'FBNeo / MAME 只读取 ZIP 根目录的 ROM 成员；请先拍平目录再上传，否则核心会报缺文件。'
  )
}

/**
 * 本地文件、旧远端对象和后台新上传共用同一套安全归档处理。
 * 后台新对象通常已拍平，但运行时仍要处理本地 ZIP 与历史对象；否则同一份 ROM
 * 会因为入口不同而出现“网页上传可玩、本地拖入缺文件”的隐性差异。
 */
export async function prepareArcadeArchive(
  blob: Blob,
  knownEntries?: readonly ZipFileEntry[],
): Promise<{ blob: Blob; entries: ZipFileEntry[]; flattenedCount: number }> {
  const entries = knownEntries?.length ? [...knownEntries] : await assertValidZipBlob(blob, '街机 ROM')
  const flattened = await flattenArcadeZipBlob(blob, entries)
  if (!flattened.flattenedCount) return { blob, entries, flattenedCount: 0 }

  // 拍平器重写了 ZIP 头偏移；后续识别与合成必须使用新中央目录，不能沿用旧 offset。
  const normalizedEntries = await assertValidZipBlob(flattened.blob, '拍平后的街机 ROM')
  return { blob: flattened.blob, entries: normalizedEntries, flattenedCount: flattened.flattenedCount }
}
