import { arcadeArchiveUnsafePathProblem, identifyNamcoSystem11Tekken } from './namcoSystem11'
import { assertValidZipBlob, type ZipFileEntry } from './unzip'

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
   * 这个已核实的 Tekken/System 11 包把父集放在根目录、克隆集放在子目录。
   * MAME 会按 tekken.zip 只读取父集成员；重写整个 ZIP 虽然不改 ROM 字节，却会改变
   * 原始归档结构，而且容易把克隆 ROM 一并摊进目标 set。命中完整 CRC 指纹时保留原 Blob，
   * 后续识别会把游戏名纠正为 tekken.zip；其它包仍走常规拍平/重名保护。
   */
  if (identifyNamcoSystem11Tekken(entries)) return { blob, flattenedCount: 0 }

  const nestedCount = entries.reduce((count, entry) => count + Number(entry.name.includes('/')), 0)
  if (!nestedCount) return { blob, flattenedCount: 0 }

  const names = new Set<string>()
  const rows = [] as Array<{
    entry: typeof entries[number]
    name: Uint8Array
    localHeader: Uint8Array
    dataStart: number
    outputOffset: number
    flags: number
    version: number
    time: number
    date: number
  }>
  const encoder = new TextEncoder()
  let localBytes = 0

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

    if ((entry.flags ?? 0) & 0x41) {
      throw new Error(`ZIP 成员“${entry.name}”使用加密格式，无法安全自动拍平；请先解密后重新打包。`)
    }
    if (entry.method !== 0 && entry.method !== 8) {
      throw new Error(`ZIP 成员“${entry.name}”使用不支持的压缩方式 ${entry.method}，无法安全自动拍平。`)
    }
    if (
      entry.compressedSize >= 0xffffffff || entry.uncompressedSize >= 0xffffffff || entry.offset >= 0xffffffff
    ) {
      throw new Error('街机 ZIP 使用了当前浏览器拍平器不支持的 ZIP64 格式；请先在电脑上拍平后上传。')
    }

    const localHeader = new Uint8Array(await blob.slice(entry.offset, entry.offset + 30).arrayBuffer())
    if (localHeader.byteLength !== 30) throw new Error(`ZIP 成员“${entry.name}”的本地文件头不完整。`)
    const local = new DataView(localHeader.buffer, localHeader.byteOffset, localHeader.byteLength)
    if (local.getUint32(0, true) !== 0x04034b50) throw new Error(`ZIP 成员“${entry.name}”的本地文件头损坏。`)
    if (local.getUint16(8, true) !== entry.method) throw new Error(`ZIP 成员“${entry.name}”的压缩方式信息不一致。`)
    if (local.getUint16(6, true) & 0x41) throw new Error(`ZIP 成员“${entry.name}”的本地头标记为加密，无法安全自动拍平。`)
    const localNameLength = local.getUint16(26, true)
    const localExtraLength = local.getUint16(28, true)
    const dataStart = entry.offset + 30 + localNameLength + localExtraLength
    if (dataStart + entry.compressedSize > blob.size) throw new Error(`ZIP 成员“${entry.name}”的数据超出文件范围。`)

    const encodedName = encoder.encode(baseName)
    if (encodedName.byteLength > 0xffff) throw new Error(`ZIP 成员文件名过长：${baseName}`)
    const nextOffset = localBytes + 30 + encodedName.byteLength + entry.compressedSize
    if (nextOffset > 0xffffffff) throw new Error('拍平后的街机 ZIP 超过标准 ZIP 的 4 GiB 上限。')
    rows.push({
      entry,
      name: encodedName,
      localHeader,
      dataStart,
      outputOffset: localBytes,
      // 清掉加密与数据描述符标志；输出头中会写入中央目录提供的 CRC 和大小。
      flags: ((entry.flags ?? 0) & ~0x0009) | 0x0800,
      version: local.getUint16(4, true),
      time: local.getUint16(10, true),
      date: local.getUint16(12, true),
    })
    localBytes = nextOffset
  }

  let centralBytes = 0
  for (const row of rows) centralBytes += 46 + row.name.byteLength
  const endOffset = localBytes + centralBytes
  if (endOffset + 22 > 0xffffffff || rows.length > 0xffff) {
    throw new Error('拍平后的街机 ZIP 超过标准 ZIP 容量上限；请先在电脑上拍平后上传。')
  }

  const parts: BlobPart[] = []
  for (const row of rows) {
    const local = new Uint8Array(30 + row.name.byteLength)
    const view = new DataView(local.buffer)
    view.setUint32(0, 0x04034b50, true)
    view.setUint16(4, row.version, true)
    view.setUint16(6, row.flags, true)
    view.setUint16(8, row.entry.method, true)
    view.setUint16(10, row.time, true)
    view.setUint16(12, row.date, true)
    view.setUint32(14, row.entry.crc32 >>> 0, true)
    view.setUint32(18, row.entry.compressedSize, true)
    view.setUint32(22, row.entry.uncompressedSize, true)
    view.setUint16(26, row.name.byteLength, true)
    view.setUint16(28, 0, true)
    local.set(row.name, 30)
    parts.push(local, blob.slice(row.dataStart, row.dataStart + row.entry.compressedSize))
  }

  const central = new Uint8Array(centralBytes)
  const centralView = new DataView(central.buffer)
  let offset = 0
  for (const row of rows) {
    centralView.setUint32(offset, 0x02014b50, true)
    centralView.setUint16(offset + 4, 20, true) // made by: DOS/FAT
    centralView.setUint16(offset + 6, row.version, true)
    centralView.setUint16(offset + 8, row.flags, true)
    centralView.setUint16(offset + 10, row.entry.method, true)
    centralView.setUint16(offset + 12, row.time, true)
    centralView.setUint16(offset + 14, row.date, true)
    centralView.setUint32(offset + 16, row.entry.crc32 >>> 0, true)
    centralView.setUint32(offset + 20, row.entry.compressedSize, true)
    centralView.setUint32(offset + 24, row.entry.uncompressedSize, true)
    centralView.setUint16(offset + 28, row.name.byteLength, true)
    centralView.setUint16(offset + 30, 0, true) // extra
    centralView.setUint16(offset + 32, 0, true) // comment
    centralView.setUint16(offset + 34, 0, true) // disk number
    centralView.setUint16(offset + 36, 0, true) // internal attributes
    centralView.setUint32(offset + 38, 0, true) // external attributes
    centralView.setUint32(offset + 42, row.outputOffset, true)
    central.set(row.name, offset + 46)
    offset += 46 + row.name.byteLength
  }
  parts.push(central)

  const eocd = new Uint8Array(22)
  const end = new DataView(eocd.buffer)
  end.setUint32(0, 0x06054b50, true)
  end.setUint16(4, 0, true)
  end.setUint16(6, 0, true)
  end.setUint16(8, rows.length, true)
  end.setUint16(10, rows.length, true)
  end.setUint32(12, centralBytes, true)
  end.setUint32(16, localBytes, true)
  end.setUint16(20, 0, true)
  parts.push(eocd)

  return { blob: new Blob(parts, { type: blob.type || 'application/zip' }), flattenedCount: nestedCount }
}
