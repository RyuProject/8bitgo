/**
 * PS1 游戏区域与 BIOS 的映射。
 *
 * 语言槽只代表翻译版本，不代表光盘制式：简体中文补丁可能基于日版，也可能基于美版。
 * 因此优先识别光盘序列号，其次看文件名中明确的地区标记；无法确定时交给旧的平台 BIOS。
 */
export type PsxBiosRegion = 'jp' | 'us' | 'eu'

export interface PsxRegionSignals {
  slug?: string
  title?: string
  /** 当前实际命中的 ROM；其版本信号必须优先于其它语言槽的备用 ROM。 */
  primaryIdentifier?: string
  identifiers?: Array<string | undefined>
}

const SERIAL_REGION: Record<string, PsxBiosRegion> = {
  SLPS: 'jp',
  SLPM: 'jp',
  SCPS: 'jp',
  PAPX: 'jp',
  PCSG: 'jp',
  SLUS: 'us',
  SCUS: 'us',
  SLES: 'eu',
  SCES: 'eu',
}

/** 当前游戏的日本发行版编号为 SLPM-86600；slug 没带编号时用这个精确别名兜底。 */
const KNOWN_JAPANESE_RELEASES = new Set([
  'world-soccer-jikkyou-winning-eleven-2000-u-23-medal-e-no-chousen',
])

function decodeHint(value: string): string {
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}

function regionFromSerial(value: string): PsxBiosRegion | undefined {
  const normalized = decodeHint(value).toUpperCase()
  const match = normalized.match(/\b(SLPS|SLPM|SCPS|PAPX|PCSG|SLUS|SCUS|SLES|SCES)[\s_-]*\d{4,5}\b/)
  return match ? SERIAL_REGION[match[1]] : undefined
}

function regionFromExplicitTag(value: string): PsxBiosRegion | undefined {
  const normalized = decodeHint(value).toLowerCase().replace(/\\/g, '/')
  const token = /(?:^|[./_\s-])(ntsc[-_ ]?j|ntsc[-_ ]?u|pal|jpn|japan|usa|us|eur|europe|eu)(?=$|[./_\s-])/g
  for (const match of normalized.matchAll(token)) {
    const tag = match[1].replace(/[\s_-]/g, '')
    if (tag === 'ntscj' || tag === 'jpn' || tag === 'japan') return 'jp'
    if (tag === 'ntscu' || tag === 'usa' || tag === 'us') return 'us'
    if (tag === 'pal' || tag === 'eur' || tag === 'europe' || tag === 'eu') return 'eu'
  }
  return undefined
}

/** 从可用的游戏元数据 / ROM 地址推断区域；不把站点 UI 语言当作光盘区域。 */
export function detectPsxBiosRegion(signals: PsxRegionSignals): PsxBiosRegion | undefined {
  const primary = signals.primaryIdentifier?.trim()
  const others = [signals.slug, signals.title, ...(signals.identifiers ?? [])].filter(
    (value): value is string => Boolean(value?.trim()),
  )

  if (primary) {
    const serialRegion = regionFromSerial(primary)
    if (serialRegion) return serialRegion
    const explicitRegion = regionFromExplicitTag(primary)
    if (explicitRegion) return explicitRegion
  }
  // 序列号是光盘版本的直接标识，优先于名称和人为标注。
  for (const value of others) {
    const region = regionFromSerial(value)
    if (region) return region
  }
  // 文件名或 slug 的显式 JP / USA / PAL 标记次之。
  for (const value of others) {
    const region = regionFromExplicitTag(value)
    if (region) return region
  }

  const slug = (signals.slug ?? '').toLowerCase().replace(/\.[a-z0-9]+$/i, '')
  return KNOWN_JAPANESE_RELEASES.has(slug) ? 'jp' : undefined
}

/** 有该区域 BIOS 时优先使用；未上传时兼容旧的 PS1 平台级绑定。 */
export function psxBiosObjectKey(
  bindings: Record<string, string | undefined>,
  region?: PsxBiosRegion,
): string | undefined {
  const regional = region ? bindings[`bios:psx-${region}`]?.trim() : ''
  return regional || bindings.psx?.trim() || undefined
}
