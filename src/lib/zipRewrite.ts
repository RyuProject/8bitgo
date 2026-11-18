import type { ZipFileEntry } from './unzip'

/** 输出 ZIP 里的一个成员：取原包里的 entry，换成 name 写出 */
export interface ZipRewriteItem {
  entry: ZipFileEntry
  name: string
}

/**
 * 只重写 ZIP 头和文件名，压缩数据直接引用原 Blob 的切片。
 *
 * 街机包动辄几十上百 MB：先解压再压缩既吃 CPU，又会在浏览器里堆出同等大小的内存峰值
 * （手机后台页直接被杀）。所以拍平子目录（flattenArcadeZip）和从 merged 包里抽出单个
 * MAME set（mameSetCatalog）都走这里：同一个原成员可以在输出里出现多次（MAME 清单里
 * 两个名字同一份 CRC 时），数据切片共用，不额外占内存。
 *
 * `action` 只用在报错文案里（「拍平」「重组」），让管理员知道是哪一步拒绝的。
 */
export async function rewriteZipEntries(blob: Blob, items: readonly ZipRewriteItem[], action = '重组'): Promise<Blob> {
  const names = new Set<string>()
  const rows = [] as Array<{
    entry: ZipFileEntry
    name: Uint8Array
    dataStart: number
    outputOffset: number
    flags: number
    version: number
    time: number
    date: number
  }>
  const encoder = new TextEncoder()
  const localHeaders = new Map<number, Uint8Array>()
  let localBytes = 0

  for (const { entry, name } of items) {
    // DOS/街机虚拟文件系统不接受路径字符；非 ASCII 仍以 UTF-8 保存。
    // eslint-disable-next-line no-control-regex -- ZIP 文件名中的控制字节不能进入模拟器虚拟文件系统。
    if (!name || name === '.' || name === '..' || /[\\/:\u0000-\u001f]/.test(name)) {
      throw new Error(`无法安全${action} ZIP 成员“${entry.name}”→“${name}”；请先手动整理压缩包。`)
    }
    const folded = name.toLocaleLowerCase('en-US')
    if (names.has(folded)) throw new Error(`${action}后会出现两个同名成员：${name}。为避免覆盖文件，已取消。`)
    names.add(folded)

    if ((entry.flags ?? 0) & 0x41) {
      throw new Error(`ZIP 成员“${entry.name}”使用加密格式，无法安全自动${action}；请先解密后重新打包。`)
    }
    if (entry.method !== 0 && entry.method !== 8) {
      throw new Error(`ZIP 成员“${entry.name}”使用不支持的压缩方式 ${entry.method}，无法安全自动${action}。`)
    }
    if (
      entry.compressedSize >= 0xffffffff || entry.uncompressedSize >= 0xffffffff || entry.offset >= 0xffffffff
    ) {
      throw new Error(`街机 ZIP 使用了当前浏览器${action}器不支持的 ZIP64 格式；请先在电脑上处理后上传。`)
    }

    let localHeader = localHeaders.get(entry.offset)
    if (!localHeader) {
      localHeader = new Uint8Array(await blob.slice(entry.offset, entry.offset + 30).arrayBuffer())
      localHeaders.set(entry.offset, localHeader)
    }
    if (localHeader.byteLength !== 30) throw new Error(`ZIP 成员“${entry.name}”的本地文件头不完整。`)
    const local = new DataView(localHeader.buffer, localHeader.byteOffset, localHeader.byteLength)
    if (local.getUint32(0, true) !== 0x04034b50) throw new Error(`ZIP 成员“${entry.name}”的本地文件头损坏。`)
    if (local.getUint16(8, true) !== entry.method) throw new Error(`ZIP 成员“${entry.name}”的压缩方式信息不一致。`)
    if (local.getUint16(6, true) & 0x41) throw new Error(`ZIP 成员“${entry.name}”的本地头标记为加密，无法安全自动${action}。`)
    const localNameLength = local.getUint16(26, true)
    const localExtraLength = local.getUint16(28, true)
    const dataStart = entry.offset + 30 + localNameLength + localExtraLength
    if (dataStart + entry.compressedSize > blob.size) throw new Error(`ZIP 成员“${entry.name}”的数据超出文件范围。`)

    const encodedName = encoder.encode(name)
    if (encodedName.byteLength > 0xffff) throw new Error(`ZIP 成员文件名过长：${name}`)
    const nextOffset = localBytes + 30 + encodedName.byteLength + entry.compressedSize
    if (nextOffset > 0xffffffff) throw new Error(`${action}后的街机 ZIP 超过标准 ZIP 的 4 GiB 上限。`)
    rows.push({
      entry,
      name: encodedName,
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
    throw new Error(`${action}后的街机 ZIP 超过标准 ZIP 容量上限；请先在电脑上处理后上传。`)
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

  return new Blob(parts, { type: blob.type || 'application/zip' })
}
