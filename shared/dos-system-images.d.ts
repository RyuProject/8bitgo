export type DosSystemImageCatalogEntry = Readonly<{
  file: string
  label: string
}>

export type DosSystemImageMirror = Readonly<{
  id: string
  label: string
  url: string
  enabled: boolean
  verifiedSha256: string
}>

export const DOS_SYSTEM_IMAGE_CATALOG: readonly DosSystemImageCatalogEntry[]
export const DOS_SYSTEM_IMAGE_MAX_MIRRORS: number
export const DEFAULT_DOS_SYSTEM_IMAGE_SOURCES: Readonly<{
  version: 1
  files: Readonly<Record<string, Readonly<{
    sha256: string
    r2Version: string
    mirrors: readonly DosSystemImageMirror[]
  }>>>
}>
