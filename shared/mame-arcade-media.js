/**
 * 已经用原始文件与 chdman verify 双重核过的 MAME 游戏专属媒体盘目录。
 *
 * 这不是 BIOS 目录：每条盘只属于具体 romset，前后端共用它是为了让后台不能靠手工 JSON
 * 把任意 R2 对象挂进模拟器。新增游戏前应先补充真实文件的核验记录和回归，再往这里加条目。
 */
export const KNOWN_MAME_ARCADE_MEDIA = Object.freeze([
  Object.freeze({
    romset: 'taiko2',
    board: 'Namco System 10',
    disks: Object.freeze([
      Object.freeze({
        romset: 'taiko2',
        name: 'nm-002',
        chdSha1: 'cede127f3d87f894ccaa1d77c8b279f209f6a8e4',
        dataSha1: '56912053bcdf7545ecd09f879bb7ed87bc366c55',
        storedBytes: 159949410,
        logicalBytes: 249774336,
      }),
    ]),
  }),
  /*
   * Konami GQ753 的首作。MAME 把这块 IDE 硬盘视为游戏内容而不是主板 BIOS：
   * 它必须挂到 /roms/bm1stmix/753jaa11.chd，不能复用给其它 beatmania 版本。
   * 两个 SHA-1 和容量由 MAME 驱动 + chdman info 实盘核对，避免管理员只凭文件名绑错盘。
   */
  Object.freeze({
    romset: 'bm1stmix',
    board: 'Konami DJ Main (GQ753)',
    disks: Object.freeze([
      Object.freeze({
        romset: 'bm1stmix',
        name: '753jaa11',
        chdSha1: '2e70cf31a853322f29f99b6f292c187a2cf33015',
        dataSha1: '71d200d1bd3f1f3a01f4daa78dc9abcca8b8a1fb',
        storedBytes: 177560308,
        logicalBytes: 1443004416,
      }),
    ]),
  }),
])

export function knownMameArcadeMediaForRomset(romset) {
  const id = String(romset ?? '').trim().toLowerCase()
  return KNOWN_MAME_ARCADE_MEDIA.find((profile) => profile.romset === id) ?? null
}

export function knownMameArcadeDisk(disk) {
  if (!disk || typeof disk !== 'object') return null
  const profile = knownMameArcadeMediaForRomset(disk.romset)
  if (!profile) return null
  return profile.disks.find((candidate) =>
    candidate.name === String(disk.name ?? '').trim().toLowerCase() &&
    candidate.chdSha1 === String(disk.chdSha1 ?? '').trim().toLowerCase() &&
    candidate.dataSha1 === String(disk.dataSha1 ?? '').trim().toLowerCase() &&
    candidate.storedBytes === Number(disk.storedBytes) &&
    candidate.logicalBytes === Number(disk.logicalBytes),
  ) ?? null
}

/** 同一份已核验盘的对象身份固定，多个游戏引用它时不重复上传也不会原地覆盖。 */
export function mameArcadeDiskObjectKey(disk) {
  return `roms/arcade-media/mame/${disk.chdSha1}/${disk.name}.chd`
}
