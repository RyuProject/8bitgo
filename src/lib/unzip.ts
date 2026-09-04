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

interface ZipDirectory {
  entries: ZipFileEntry[]
  /** 包含目录项；空 ZIP 与损坏 ZIP 不能都用 entries.length === 0 表示。 */
  totalEntries: number
}

/**
 * 严格读取中央目录。
 *
 * 只检查开头的 PK 魔数识别不了“下载到一半的 ZIP”——本地文件头在开头，中央目录却在
 * 文件末尾。这里同时核对 EOCD、中央目录范围、每个本地头和成员数据范围，任何一步越界
 * 都视为损坏。这样截断包不会再被误当成一个普通二进制文件继续交给模拟器。
 */
function readZipDirectory(buf: ArrayBuffer): ZipDirectory | null {
  const b = new Uint8Array(buf)
  const dv = new DataView(buf)

  if (!isZip(b) || b.length < 22) return null

  // 从尾部往前找「中央目录结束记录」(EOCD)，注释最长 65535 字节
  let eocd = -1
  const from = Math.max(0, b.length - 22 - 65535)
  for (let i = b.length - 22; i >= from; i--) {
    if (dv.getUint32(i, true) === 0x06054b50) {
      eocd = i
      break
    }
  }
  if (eocd < 0) return null

  const disk = dv.getUint16(eocd + 4, true)
  const centralDisk = dv.getUint16(eocd + 6, true)
  const diskCount = dv.getUint16(eocd + 8, true)
  const count = dv.getUint16(eocd + 10, true)
  const centralSize = dv.getUint32(eocd + 12, true)
  const centralOffset = dv.getUint32(eocd + 16, true)
  const commentLength = dv.getUint16(eocd + 20, true)
  // 当前轻量实现不支持分卷 ZIP / ZIP64；与其读出半真半假的目录，不如明确拒绝。
  if (disk !== 0 || centralDisk !== 0 || diskCount !== count || count === 0xffff) return null
  if (eocd + 22 + commentLength > b.length) return null
  if (centralOffset + centralSize > eocd || centralOffset + centralSize > b.length) return null

  let p = centralOffset
  const centralEnd = centralOffset + centralSize
  const entries: ZipFileEntry[] = []

  for (let i = 0; i < count; i++) {
    if (p + 46 > centralEnd || dv.getUint32(p, true) !== 0x02014b50) return null
    const flags = dv.getUint16(p + 8, true)
    const method = dv.getUint16(p + 10, true)
    const crc32 = dv.getUint32(p + 16, true)
    const compressedSize = dv.getUint32(p + 20, true)
    const uncompressedSize = dv.getUint32(p + 24, true)
    const nameLen = dv.getUint16(p + 28, true)
    const extraLen = dv.getUint16(p + 30, true)
    const commentLen = dv.getUint16(p + 32, true)
    const offset = dv.getUint32(p + 42, true)
    const next = p + 46 + nameLen + extraLen + commentLen
    if (next > centralEnd) return null

    // 中央目录声称成员有多少字节还不够；本地头和真正的数据也必须完整存在。
    if (offset + 30 > b.length || dv.getUint32(offset, true) !== 0x04034b50) return null
    const localNameLen = dv.getUint16(offset + 26, true)
    const localExtraLen = dv.getUint16(offset + 28, true)
    const dataStart = offset + 30 + localNameLen + localExtraLen
    if (dataStart > b.length || dataStart + compressedSize > b.length) return null

    // 反斜杠是某些 Windows 打包器的产物，统一成正斜杠，免得当成文件名的一部分
    const name = decodeZipName(b.subarray(p + 46, p + 46 + nameLen), Boolean(flags & 0x800)).replace(/\\/g, '/')
    // 目录项以 / 结尾；macOS 打包时塞的 __MACOSX/ 和 ._ 开头的资源叉一律跳过
    if (!name.endsWith('/') && !name.startsWith('__MACOSX/') && !name.split('/').pop()?.startsWith('._')) {
      entries.push({ name, method, compressedSize, uncompressedSize, crc32, offset })
    }
    p = next
  }
  if (p > centralEnd) return null
  return { entries, totalEntries: count }
}

/** 读中央目录，列出压缩包里的文件（不含目录项）；损坏时返回空数组以兼容旧调用方。 */
export function listZipEntries(buf: ArrayBuffer): ZipFileEntry[] {
  return readZipDirectory(buf)?.entries ?? []
}

/** 完整性校验通过后返回成员；空包与截断包都会明确报错。 */
export function assertValidZip(buf: ArrayBuffer, label = 'ZIP'): ZipFileEntry[] {
  const directory = readZipDirectory(buf)
  if (!directory || directory.totalEntries === 0 || directory.entries.length === 0) {
    throw new Error(`${label} 压缩包为空、已损坏或下载不完整`)
  }
  return directory.entries
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

/* ══════════════════════════ 往包里追加成员 ══════════════════════════ */

const CRC_TABLE = (() => {
  const t = new Uint32Array(256)
  for (let i = 0; i < 256; i++) {
    let c = i
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[i] = c >>> 0
  }
  return t
})()

/** zip 成员用的 CRC-32（无符号）。RomData 的清单要按 CRC 对 ROM，所以合成产物必须自己算一遍 */
export function crc32(data: Uint8Array): number {
  let c = 0xffffffff
  for (let i = 0; i < data.length; i++) c = CRC_TABLE[(c ^ data[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

/**
 * 往一个现成的 zip 末尾追加几个**未压缩**成员，返回新包。
 *
 * 为什么是"追加"而不是"重打包"：改版包动辄 20 多 MB、二十几个成员，
 * 为了加两块合成 ROM 把整包解压再压回去纯属浪费。zip 的结构允许直接接：
 * 原有成员的本地头和数据一个字节都不用动（中央目录里记的 localOffset 因此仍然有效），
 * 只要把新成员的本地头 + 数据插在**原中央目录之前**，再把中央目录整段抄过来、
 * 接上新成员的目录项、重写 EOCD 就行。
 *
 * 新成员一律 stored(0) 不压缩 —— 合成 ROM 只在本地递给引擎，省下的那点体积
 * 换不来 deflate 的时间，而且不用引 CompressionStream。
 *
 * 同名成员不会去重：调用方给的名字应该是新名字（见 data/arcadeHacks.ts 的合成产物命名）。
 */
export function appendZipEntries(
  buf: ArrayBuffer,
  additions: readonly { name: string; data: Uint8Array }[],
): Uint8Array {
  const b = new Uint8Array(buf)
  const dv = new DataView(buf)
  if (!additions.length) return b

  let eocd = -1
  const from = Math.max(0, b.length - 22 - 65535)
  for (let i = b.length - 22; i >= from; i--) {
    if (dv.getUint32(i, true) === 0x06054b50) {
      eocd = i
      break
    }
  }
  if (eocd < 0) throw new Error('zip: 找不到中央目录结束记录，无法追加')

  const count = dv.getUint16(eocd + 10, true)
  const centralSize = dv.getUint32(eocd + 12, true)
  const centralOffset = dv.getUint32(eocd + 16, true)
  if (centralOffset + centralSize > b.length) throw new Error('zip: 中央目录越界，无法追加')

  const enc = new TextEncoder()
  const rows = additions.map((a) => ({ name: enc.encode(a.name), data: a.data, crc: crc32(a.data) }))

  const localBytes = rows.reduce((n, r) => n + 30 + r.name.length + r.data.length, 0)
  const centralBytes = rows.reduce((n, r) => n + 46 + r.name.length, 0)

  const out = new Uint8Array(centralOffset + localBytes + centralSize + centralBytes + 22)
  const ov = new DataView(out.buffer)
  let p = 0

  // 1) 原包里中央目录之前的全部内容（本地头 + 数据），原样搬过去
  out.set(b.subarray(0, centralOffset), p)
  p += centralOffset

  // 2) 新成员的本地头 + 数据。顺手记下每个的 localOffset，中央目录要用
  const offsets: number[] = []
  for (const r of rows) {
    offsets.push(p)
    ov.setUint32(p, 0x04034b50, true)
    ov.setUint16(p + 4, 20, true) // version needed
    ov.setUint16(p + 6, 0x0800, true) // 名字按 UTF-8（虽然这里都是 ASCII）
    ov.setUint16(p + 8, 0, true) // method = stored
    ov.setUint16(p + 10, 0, true) // time
    ov.setUint16(p + 12, 0x0021, true) // date = 1980-01-01，zip 的最小合法值
    ov.setUint32(p + 14, r.crc, true)
    ov.setUint32(p + 18, r.data.length, true)
    ov.setUint32(p + 22, r.data.length, true)
    ov.setUint16(p + 26, r.name.length, true)
    ov.setUint16(p + 28, 0, true) // extra
    out.set(r.name, p + 30)
    out.set(r.data, p + 30 + r.name.length)
    p += 30 + r.name.length + r.data.length
  }

  // 3) 原中央目录整段照抄 —— 里面记的 localOffset 都还在原位，不用修
  const newCentralOffset = p
  out.set(b.subarray(centralOffset, centralOffset + centralSize), p)
  p += centralSize

  // 4) 新成员的中央目录项
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i]
    ov.setUint32(p, 0x02014b50, true)
    ov.setUint16(p + 4, 20, true) // version made by
    ov.setUint16(p + 6, 20, true) // version needed
    ov.setUint16(p + 8, 0x0800, true)
    ov.setUint16(p + 10, 0, true) // method = stored
    ov.setUint16(p + 12, 0, true) // time
    ov.setUint16(p + 14, 0x0021, true) // date
    ov.setUint32(p + 16, r.crc, true)
    ov.setUint32(p + 20, r.data.length, true)
    ov.setUint32(p + 24, r.data.length, true)
    ov.setUint16(p + 28, r.name.length, true)
    ov.setUint16(p + 30, 0, true) // extra
    ov.setUint16(p + 32, 0, true) // comment
    ov.setUint16(p + 34, 0, true) // disk start
    ov.setUint16(p + 36, 0, true) // internal attrs
    ov.setUint32(p + 38, 0, true) // external attrs
    ov.setUint32(p + 42, offsets[i], true)
    out.set(r.name, p + 46)
    p += 46 + r.name.length
  }

  // 5) 新的 EOCD
  ov.setUint32(p, 0x06054b50, true)
  ov.setUint16(p + 4, 0, true) // this disk
  ov.setUint16(p + 6, 0, true) // disk with central dir
  ov.setUint16(p + 8, count + rows.length, true)
  ov.setUint16(p + 10, count + rows.length, true)
  ov.setUint32(p + 12, centralSize + centralBytes, true)
  ov.setUint32(p + 16, newCentralOffset, true)
  ov.setUint16(p + 20, 0, true) // comment length
  return out
}
