/**
 * 极简 zip 解包：从一个 zip 里取出一个文件的完整内容。
 *
 * 为什么要自己写：站点允许上传 .zip 格式的 ROM，EmulatorJS 内部会自己解压，
 * 但 jsnes 这类轻量引擎只认裸 ROM —— 拿到 zip 就抛「Not a valid NES ROM」。
 * emulator/detect.ts 里那套只解**开头几 KB**用来认文件头，这里要的是完整内容。
 *
 * 解压用浏览器自带的 DecompressionStream('deflate-raw')，不引入任何依赖。
 * 只支持 stored(0) 与 deflate(8) —— 这两种覆盖了实际能见到的所有 ROM 压缩包
 *（zip 的默认就是 deflate；bzip2/lzma/zstd 那几种压缩方式极其罕见，遇到就如实报错）。
 */

export interface ZipFileEntry {
  name: string
  /** 压缩方式：0 = 未压缩，8 = deflate */
  method: number
  compressedSize: number
  uncompressedSize: number
  /**
   * 成员内容的 CRC-32（无符号）。
   *
   * 白捡的：zip 的中央目录里本来就存着每个成员的 CRC，**不用解压就能读到**，
   * 27MB 的街机包也是一瞬间的事。街机 ROM 识别（lib/arcadeRomset.ts）整个
   * 就架在这个字段上 —— 拿它去比 FBNeo 的驱动表，是哪个 romset 一目了然。
   */
  crc32: number
  /** 本地文件头在整个 zip 里的偏移 */
  offset: number
}

/**
 * 解 zip 里的文件名。
 *
 * zip 只有一个「这条目的名字是 UTF-8」的标志位（通用标志第 11 位）。没打这个标志的包
 * 用的是**本地代码页**：Windows 简体中文下打的包就是 GBK。一律按 UTF-8 解，
 * 中文名会变成一串乱码 —— 而这些名字最后要当对象 key 用，还要和 SWF 里
 * loadMovie('sound/1.swf') 的相对路径对上，错一个字节就 404。
 *
 * 纯 ASCII 的名字两种编码完全一致，直接走 UTF-8；有高位字节又没打 UTF-8 标志的
 * 才试 GBK（fatal 模式，解不动就说明本来就是 UTF-8，退回去）。
 */
export function decodeZipName(bytes: Uint8Array, utf8Flag: boolean): string {
  if (utf8Flag || bytes.every((c) => c < 0x80)) return new TextDecoder().decode(bytes)
  try {
    return new TextDecoder('gbk', { fatal: true }).decode(bytes)
  } catch {
    return new TextDecoder().decode(bytes)
  }
}

/** 前两个字节是不是 zip 的魔数 PK */
export function isZip(buf: ArrayBuffer | Uint8Array): boolean {
  const b = buf instanceof Uint8Array ? buf : new Uint8Array(buf)
  return b.length > 4 && b[0] === 0x50 && b[1] === 0x4b && (b[2] === 0x03 || b[2] === 0x05 || b[2] === 0x07)
}

/** 读中央目录，列出压缩包里的文件（不含目录项） */
export function listZipEntries(buf: ArrayBuffer): ZipFileEntry[] {
  const b = new Uint8Array(buf)
  const dv = new DataView(buf)

  // 从尾部往前找「中央目录结束记录」(EOCD)，注释最长 65535 字节
  let eocd = -1
  const from = Math.max(0, b.length - 22 - 65535)
  for (let i = b.length - 22; i >= from; i--) {
    if (dv.getUint32(i, true) === 0x06054b50) {
      eocd = i
      break
    }
  }
  if (eocd < 0) return []

  const count = dv.getUint16(eocd + 10, true)
  let p = dv.getUint32(eocd + 16, true) // 中央目录起始偏移
  const entries: ZipFileEntry[] = []

  for (let i = 0; i < count && p + 46 <= b.length; i++) {
    if (dv.getUint32(p, true) !== 0x02014b50) break
    const flags = dv.getUint16(p + 8, true)
    const method = dv.getUint16(p + 10, true)
    const crc32 = dv.getUint32(p + 16, true)
    const compressedSize = dv.getUint32(p + 20, true)
    const uncompressedSize = dv.getUint32(p + 24, true)
    const nameLen = dv.getUint16(p + 28, true)
    const extraLen = dv.getUint16(p + 30, true)
    const commentLen = dv.getUint16(p + 32, true)
    const offset = dv.getUint32(p + 42, true)
    // 反斜杠是某些 Windows 打包器的产物，统一成正斜杠，免得当成文件名的一部分
    const name = decodeZipName(b.subarray(p + 46, p + 46 + nameLen), Boolean(flags & 0x800)).replace(/\\/g, '/')
    // 目录项以 / 结尾；macOS 打包时塞的 __MACOSX/ 和 ._ 开头的资源叉一律跳过
    if (!name.endsWith('/') && !name.startsWith('__MACOSX/') && !name.split('/').pop()?.startsWith('._')) {
      entries.push({ name, method, compressedSize, uncompressedSize, crc32, offset })
    }
    p += 46 + nameLen + extraLen + commentLen
  }
  return entries
}

/** 解出某一项的完整内容 */
export async function extractZipEntry(buf: ArrayBuffer, entry: ZipFileEntry): Promise<Uint8Array> {
  const b = new Uint8Array(buf)
  const dv = new DataView(buf)

  // 本地文件头里的 nameLen / extraLen 可能和中央目录不一致，必须重新读
  if (entry.offset + 30 > b.length || dv.getUint32(entry.offset, true) !== 0x04034b50) {
    throw new Error('zip: 本地文件头损坏')
  }
  const dataStart = entry.offset + 30 + dv.getUint16(entry.offset + 26, true) + dv.getUint16(entry.offset + 28, true)
  const end = entry.compressedSize ? dataStart + entry.compressedSize : b.length
  const raw = b.subarray(dataStart, Math.min(end, b.length))

  if (entry.method === 0) return raw
  if (entry.method !== 8) throw new Error(`zip: 不支持的压缩方式 ${entry.method}`)
  if (typeof DecompressionStream === 'undefined') throw new Error('zip: 浏览器不支持 DecompressionStream')

  const stream = new Blob([raw as BlobPart]).stream().pipeThrough(new DecompressionStream('deflate-raw'))
  return new Uint8Array(await new Response(stream).arrayBuffer())
}

/**
 * 从 zip 里挑出最像 ROM 的那一项并解开。
 *
 * @param prefer 优先的扩展名（不带点，小写），按顺序匹配；都没命中就取最大的那个文件
 *               —— ROM 包里常常还塞着 readme.txt 之类的小文件。
 */
export async function extractRomFromZip(buf: ArrayBuffer, prefer: string[]): Promise<{ name: string; data: Uint8Array }> {
  const entries = listZipEntries(buf)
  if (!entries.length) throw new Error('zip: 压缩包是空的或已损坏')

  const extOf = (n: string) => (n.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1] ?? '')
  let pick: ZipFileEntry | undefined
  for (const ext of prefer) {
    pick = entries.find((e) => extOf(e.name) === ext)
    if (pick) break
  }
  if (!pick) pick = entries.reduce((a, b2) => (b2.uncompressedSize > a.uncompressedSize ? b2 : a))

  return { name: pick.name, data: await extractZipEntry(buf, pick) }
}
