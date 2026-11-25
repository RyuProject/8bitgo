/** 只读 ISO 的卷描述符与根目录，避免先传数百 MB 再由服务器发现不是可启动的 PS1 数据轨。 */
function bothEndian32(bytes: Uint8Array, offset: number): number | null {
  if (offset < 0 || offset + 8 > bytes.byteLength) return null
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const little = view.getUint32(offset, true)
  return little === view.getUint32(offset + 4, false) ? little : null
}

export async function psxIsoValidationProblem(file: Blob): Promise<string | null> {
  if (file.size < 0x9000 || file.size % 2048 !== 0) {
    return 'PS1 单数据轨 ISO 必须由 2048-byte 扇区组成；2352-byte 原始轨道需要连同 CUE 在本地转 CHD'
  }
  const pvd = new Uint8Array(await file.slice(0x8000, 0x9000).arrayBuffer())
  const signature = String.fromCharCode(...pvd.subarray(1, 6))
  if (pvd[0] !== 1 || pvd[6] !== 1 || signature !== 'CD001') {
    return '缺少 ISO9660 主卷描述符；这可能不是 2048-byte 的 PS1 ISO'
  }
  const view = new DataView(pvd.buffer, pvd.byteOffset, pvd.byteLength)
  if (view.getUint16(128, true) !== 2048 || view.getUint16(130, false) !== 2048) {
    return 'ISO9660 逻辑扇区大小无效；PS1 转码只接受 2048-byte 数据轨'
  }
  const root = 156
  if (pvd[root] < 34 || pvd[root + 32] !== 1 || pvd[root + 33] !== 0 || (pvd[root + 25] & 0x02) === 0) {
    return 'ISO9660 根目录记录无效'
  }
  const block = bothEndian32(pvd, root + 2)
  const size = bothEndian32(pvd, root + 10)
  if (block === null || size === null) return 'ISO9660 根目录的双字节序字段不一致'
  const offset = block * 2048
  if (!block || !size || size > 1024 * 1024 || offset + size > file.size) {
    return 'ISO9660 根目录损坏或超出镜像范围'
  }
  const bytes = new Uint8Array(await file.slice(offset, offset + size).arrayBuffer())
  for (let at = 0; at + 34 <= bytes.length;) {
    const length = bytes[at]
    if (!length) { at = (Math.floor(at / 2048) + 1) * 2048; continue }
    if (length < 34 || at + length > bytes.length) return 'ISO9660 根目录记录损坏'
    const nameLength = bytes[at + 32]
    if (nameLength < 1 || 33 + nameLength > length) return 'ISO9660 文件名记录损坏'
    const extent = bothEndian32(bytes, at + 2)
    const fileSize = bothEndian32(bytes, at + 10)
    if (extent === null || fileSize === null) return 'ISO9660 根目录双字节序字段不一致'
    const name = String.fromCharCode(...bytes.subarray(at + 33, at + 33 + nameLength)).toUpperCase()
    if (/^SYSTEM\.CNF(?:;1)?$/.test(name)) {
      const fileOffset = extent * 2048
      if ((bytes[at + 25] & 0x02) !== 0 || fileSize < 1 || !Number.isSafeInteger(fileOffset) || fileOffset + fileSize > file.size) {
        return '根目录中的 SYSTEM.CNF 记录无效或超出镜像范围'
      }
      return null
    }
    at += length
  }
  return '根目录没有 PS1 启动所需的 SYSTEM.CNF；请确认不是 PSP/普通光盘 ISO'
}
