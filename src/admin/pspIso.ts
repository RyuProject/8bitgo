const SECTOR_BYTES = 2048
const PVD_OFFSET = 16 * SECTOR_BYTES
const MAX_DIRECTORY_BYTES = 1024 * 1024

interface IsoEntry {
  name: string
  extent: number
  size: number
  directory: boolean
}

function bothEndian32(bytes: Uint8Array, offset: number): number | null {
  if (offset < 0 || offset + 8 > bytes.byteLength) return null
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const little = view.getUint32(offset, true)
  return little === view.getUint32(offset + 4, false) ? little : null
}

function parseDirectory(bytes: Uint8Array): IsoEntry[] | null {
  const entries: IsoEntry[] = []
  for (let at = 0; at < bytes.byteLength;) {
    const recordBytes = bytes[at]
    if (recordBytes === 0) {
      at = (Math.floor(at / SECTOR_BYTES) + 1) * SECTOR_BYTES
      continue
    }
    if (recordBytes < 34 || at + recordBytes > bytes.byteLength) return null
    const nameBytes = bytes[at + 32]
    if (nameBytes < 1 || 33 + nameBytes > recordBytes) return null
    const extent = bothEndian32(bytes, at + 2)
    const size = bothEndian32(bytes, at + 10)
    if (extent === null || size === null) return null
    const rawName = String.fromCharCode(...bytes.subarray(at + 33, at + 33 + nameBytes))
    const name = (rawName === '\u0000' ? '.' : rawName === '\u0001' ? '..' : rawName)
      .replace(/;\d+$/, '')
      .replace(/\.$/, '')
      .toUpperCase()
    entries.push({ name, extent, size, directory: (bytes[at + 25] & 0x02) !== 0 })
    at += recordBytes
  }
  return entries
}

function inBounds(entry: IsoEntry, fileSize: number): boolean {
  const offset = entry.extent * SECTOR_BYTES
  return Number.isSafeInteger(offset) && entry.extent > 0 && entry.size > 0 && offset + entry.size <= fileSize
}

async function readRange(file: Blob, offset: number, size: number): Promise<Uint8Array> {
  return new Uint8Array(await file.slice(offset, offset + size).arrayBuffer())
}

/** 上传前只读目录与两个小文件头，避免坏镜像先占用整盘上行再由服务器拒绝。 */
export async function pspIsoValidationProblem(file: Blob): Promise<string | null> {
  if (file.size < 0x9000 || file.size % SECTOR_BYTES !== 0) {
    return 'PSP UMD ISO 必须由 2048-byte 扇区组成；文件长度或镜像范围不合法'
  }

  const head = await readRange(file, 0, 0x9000)
  const view = new DataView(head.buffer, head.byteOffset, head.byteLength)
  if (
    head[PVD_OFFSET] !== 1 || String.fromCharCode(...head.subarray(PVD_OFFSET + 1, PVD_OFFSET + 6)) !== 'CD001' ||
    head[PVD_OFFSET + 6] !== 1 || view.getUint16(PVD_OFFSET + 128, true) !== SECTOR_BYTES ||
    view.getUint16(PVD_OFFSET + 130, false) !== SECTOR_BYTES
  ) return '缺少有效 ISO9660 主卷描述符；这可能不是 PSP UMD ISO'

  const rootAt = PVD_OFFSET + 156
  if (head[rootAt] < 34 || head[rootAt + 32] !== 1 || head[rootAt + 33] !== 0 || (head[rootAt + 25] & 0x02) === 0) {
    return 'PSP ISO9660 根目录记录无效'
  }
  const root: IsoEntry = {
    name: '.',
    extent: bothEndian32(head, rootAt + 2) ?? 0,
    size: bothEndian32(head, rootAt + 10) ?? 0,
    directory: true,
  }
  if (!inBounds(root, file.size) || root.size > MAX_DIRECTORY_BYTES) return 'PSP ISO9660 根目录超出镜像范围'

  const readDirectory = async (entry: IsoEntry): Promise<IsoEntry[] | null> => {
    if (!entry.directory || !inBounds(entry, file.size) || entry.size > MAX_DIRECTORY_BYTES) return null
    const bytes = await readRange(file, entry.extent * SECTOR_BYTES, entry.size)
    return bytes.byteLength === entry.size ? parseDirectory(bytes) : null
  }
  const rootEntries = await readDirectory(root)
  const game = rootEntries?.find((entry) => entry.name === 'PSP_GAME' && entry.directory)
  if (!game) return 'ISO 根目录没有 PSP_GAME；文件可能不是 PSP 游戏镜像'

  const gameEntries = await readDirectory(game)
  const param = gameEntries?.find((entry) => entry.name === 'PARAM.SFO' && !entry.directory)
  const sysdir = gameEntries?.find((entry) => entry.name === 'SYSDIR' && entry.directory)
  if (!param || param.size < 4 || !inBounds(param, file.size) || !sysdir) {
    return 'PSP_GAME 缺少有效 PARAM.SFO 或 SYSDIR'
  }
  const paramHeader = await readRange(file, param.extent * SECTOR_BYTES, 4)
  if (paramHeader[0] !== 0x00 || paramHeader[1] !== 0x50 || paramHeader[2] !== 0x53 || paramHeader[3] !== 0x46) {
    return 'PSP_GAME/PARAM.SFO 文件头无效'
  }

  const systemEntries = await readDirectory(sysdir)
  const eboot = systemEntries?.find((entry) => entry.name === 'EBOOT.BIN' && !entry.directory)
  if (!eboot || eboot.size < 4 || !inBounds(eboot, file.size)) return 'PSP_GAME/SYSDIR 缺少有效 EBOOT.BIN'
  const ebootHeader = await readRange(file, eboot.extent * SECTOR_BYTES, 4)
  const isPrx = ebootHeader[0] === 0x7e && ebootHeader[1] === 0x50 && ebootHeader[2] === 0x53 && ebootHeader[3] === 0x50
  const isElf = ebootHeader[0] === 0x7f && ebootHeader[1] === 0x45 && ebootHeader[2] === 0x4c && ebootHeader[3] === 0x46
  return isPrx || isElf ? null : 'PSP_GAME/SYSDIR/EBOOT.BIN 不是可识别的 PSP PRX 或 ELF'
}
