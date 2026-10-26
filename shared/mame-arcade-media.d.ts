/** 已核验的 MAME 游戏专属 CHD 媒体盘；它们不是平台 BIOS。 */
export interface KnownMameArcadeDisk {
  romset: string
  name: string
  chdSha1: string
  dataSha1: string
  storedBytes: number
  logicalBytes: number
}

export interface KnownMameArcadeMedia {
  romset: string
  board: string
  disks: readonly KnownMameArcadeDisk[]
}

export const KNOWN_MAME_ARCADE_MEDIA: readonly KnownMameArcadeMedia[]
export function knownMameArcadeMediaForRomset(romset: unknown): KnownMameArcadeMedia | null
export function knownMameArcadeDisk(disk: unknown): KnownMameArcadeDisk | null
export function mameArcadeDiskObjectKey(disk: Pick<KnownMameArcadeDisk, 'chdSha1' | 'name'>): string
