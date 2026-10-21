/** 只读 ISO 的卷描述符与根目录，避免先传数百 MB 再由服务器发现不是可启动的 PS1 数据轨。 */
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
  const root = 156
  const block = view.getUint32(root + 2, true)
  const size = view.getUint32(root + 10, true)
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
    if (33 + nameLength > length) return 'ISO9660 文件名记录损坏'
    const name = String.fromCharCode(...bytes.subarray(at + 33, at + 33 + nameLength)).toUpperCase()
    if (/^SYSTEM\.CNF(?:;1)?$/.test(name)) return null
    at += length
  }
  return '根目录没有 PS1 启动所需的 SYSTEM.CNF；请确认不是 PSP/普通光盘 ISO'
}
