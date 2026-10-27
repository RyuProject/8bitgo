/**
 * 自动生成：node scripts/gen-mame-chd-catalog.mjs <mame-source>。
 * MAME 源码版本：39eb9e44c394；共 940 个带 CHD 的可识别 romset。
 * 只含 MAME 驱动公开的文件名/CRC/CHD SHA-1，不含游戏内容。
 */
export interface MameChdCatalogRow {
  /** MAME machine short name */
  r: string
  /** [required file name without .chd, CHD SHA-1 required by MAME] */
  d: readonly (readonly [string, string])[]
  /** Space separated name:crc32 ROM fingerprint */
  f: string
  /** Source path for diagnostics */
  s: string
}
export const MAME_CHD_CATALOG_REVISION: string
export const MAME_CHD_CATALOG: readonly MameChdCatalogRow[]
export function mameChdProfileForRomset(romset: unknown): MameChdCatalogRow | null
export function knownMameChdDiskExpectation(disk: unknown): readonly [string, string] | null
