/**
 * ROM 类型嗅探：根据扩展名 + 文件头（+ zip 内文件名）判断平台，从而决定用哪个运行时。
 *
 *   detectRom(file) -> { platform: 'gba', confidence: 'high', reason: '文件头含 GBA 标识' }
 *
 * 只读取文件的少量字节，不会把整个 ROM 读进内存。
 */
import type { PlatformId } from '@/types'
import { platformMap } from '@/data/platforms'
import { getT, fmt } from '@/services/i18n'
import { platformLabel } from '@/services/i18nData'

export interface RomDetection {
  platform?: PlatformId
  confidence: 'high' | 'medium' | 'low'
  reason: string
  /** zip 内主文件名（若为压缩包） */
  innerName?: string
}

const EXT_TO_PLATFORM: Record<string, PlatformId> = {
  nes: 'nes',
  unf: 'nes',
  unif: 'nes',
  fds: 'nes',
  sfc: 'snes',
  smc: 'snes',
  fig: 'snes',
  gba: 'gba',
  agb: 'gba',
  gb: 'gb',
  gbc: 'gb',
  sgb: 'gb',
  z64: 'n64',
  n64: 'n64',
  v64: 'n64',
  md: 'segaMD',
  gen: 'segaMD',
  smd: 'segaMD',
  nds: 'nds',
  ws: 'ws',
  wsc: 'ws',
  swf: 'flash',
  jar: 'java',
  jad: 'java',
  cue: 'psx',
  iso: 'psx',
  pbp: 'psx',
  chd: 'psx',
  img: 'psx',
  ecm: 'psx',
  exe: 'dos',
  com: 'dos',
  bat: 'dos',
}

const AMBIGUOUS = new Set(['bin', 'rom', 'dat'])

function ext(name: string): string {
  const m = name.toLowerCase().match(/\.([a-z0-9]+)$/)
  return m ? m[1] : ''
}

function ascii(bytes: Uint8Array, start: number, len: number): string {
  return String.fromCharCode(...bytes.subarray(start, start + len))
}

/** 按文件头判断 */
function sniffHeader(bytes: Uint8Array): RomDetection | null {
  if (bytes.length < 16) return null
  const d = getT().detect
  const head4 = ascii(bytes, 0, 4)
  const head3 = head4.slice(0, 3)
  if (head4 === 'NES') return { platform: 'nes', confidence: 'high', reason: d.ines }
  if (head3 === 'FWS' || head3 === 'CWS' || head3 === 'ZWS') return { platform: 'flash', confidence: 'high', reason: d.swf }
  if (head4 === 'UNIF') return { platform: 'nes', confidence: 'high', reason: d.unif }
  if (ascii(bytes, 0, 3) === 'FDS' || ascii(bytes, 0, 4) === '*NI') return { platform: 'nes', confidence: 'medium', reason: d.fds }
  const b = bytes
  if (b[0] === 0x80 && b[1] === 0x37 && b[2] === 0x12 && b[3] === 0x40) return { platform: 'n64', confidence: 'high', reason: d.n64z64 }
  if (b[0] === 0x37 && b[1] === 0x80 && b[2] === 0x40 && b[3] === 0x12) return { platform: 'n64', confidence: 'high', reason: d.n64v64 }
  if (b[0] === 0x40 && b[1] === 0x12 && b[2] === 0x37 && b[3] === 0x80) return { platform: 'n64', confidence: 'high', reason: d.n64n64 }
  if (bytes.length >= 0x108 && b[0x104] === 0xce && b[0x105] === 0xed && b[0x106] === 0x66 && b[0x107] === 0x66) {
    return { platform: 'gb', confidence: 'high', reason: d.gbHeader }
  }
  if (b[4] === 0x24 && b[5] === 0xff && b[6] === 0xae && b[7] === 0x51) return { platform: 'gba', confidence: 'high', reason: d.gbaHeader }
  if (bytes.length >= 0x104 && ascii(bytes, 0x100, 4) === 'SEGA') return { platform: 'segaMD', confidence: 'high', reason: d.segaHeader }
  if (bytes.length >= 0x200 && ascii(bytes, 0x0c, 4) === 'NDS' ) return { platform: 'nds', confidence: 'medium', reason: d.ndsHeader }
  if (bytes.length >= 0x200 && ascii(bytes, 0, 2) === 'MZ') return { platform: 'dos', confidence: 'medium', reason: d.dosExe }
  // PSX：镜像头 2KB 内常出现 PLAYSTATION 字样
  const window2k = ascii(bytes, 0, Math.min(bytes.length, 2048))
  if (window2k.includes('PLAYSTATION') || window2k.includes('Sony Computer Entertainment')) {
    return { platform: 'psx', confidence: 'medium', reason: d.psxImage }
  }
  return null
}

/** 解析 zip 中央目录，取出文件名列表（只读文件尾部） */
async function zipEntryNames(file: File): Promise<string[]> {
  const tailSize = Math.min(file.size, 65536 + 22)
  const tail = new Uint8Array(await file.slice(file.size - tailSize, file.size).arrayBuffer())
  let eocd = -1
  for (let i = tail.length - 22; i >= 0; i--) {
    if (tail[i] === 0x50 && tail[i + 1] === 0x4b && tail[i + 2] === 0x05 && tail[i + 3] === 0x06) {
      eocd = i
      break
    }
  }
  if (eocd < 0) return []
  const view = new DataView(tail.buffer, tail.byteOffset)
  const count = view.getUint16(eocd + 10, true)
  const cdSize = view.getUint32(eocd + 12, true)
  const cdOffset = view.getUint32(eocd + 16, true)
  const cd = new Uint8Array(await file.slice(cdOffset, cdOffset + cdSize).arrayBuffer())
  const cdView = new DataView(cd.buffer, cd.byteOffset)
  const names: string[] = []
  let off = 0
  for (let i = 0; i < count && off + 46 <= cd.length; i++) {
    if (cdView.getUint32(off, true) !== 0x02014b50) break
    const nameLen = cdView.getUint16(off + 28, true)
    const extraLen = cdView.getUint16(off + 30, true)
    const commentLen = cdView.getUint16(off + 32, true)
    names.push(new TextDecoder().decode(cd.subarray(off + 46, off + 46 + nameLen)))
    off += 46 + nameLen + extraLen + commentLen
  }
  return names.filter((n) => !n.endsWith('/'))
}

export async function detectRom(file: File): Promise<RomDetection> {
  const d = getT().detect
  const e = ext(file.name)

  // 1. 压缩包：看里面的文件名
  if (e === 'zip' || e === '7z') {
    if (e === '7z') return { confidence: 'low', reason: d.sevenZip }
    const names = await zipEntryNames(file)
    const known = names.map((n) => ({ n, p: EXT_TO_PLATFORM[ext(n)] })).filter((x) => x.p)
    if (known.length) {
      // cue 优先于 bin
      const pick = known.find((x) => ext(x.n) === 'cue') ?? known[0]
      return { platform: pick.p, confidence: 'high', reason: fmt(d.zipContains, { ext: ext(pick.n) }), innerName: pick.n }
    }
    if (names.length >= 3) return { platform: 'arcade', confidence: 'medium', reason: d.zipArcade, innerName: names[0] }
    if (names.length === 1 && AMBIGUOUS.has(ext(names[0]))) return { confidence: 'low', reason: fmt(d.zipAmbiguous, { ext: ext(names[0]) }), innerName: names[0] }
    return { confidence: 'low', reason: d.zipUnknown }
  }

  // 2. 文件头
  const head = new Uint8Array(await file.slice(0, 2048).arrayBuffer())
  const byHeader = sniffHeader(head)
  if (byHeader && byHeader.confidence === 'high') return byHeader

  // 3. 扩展名
  const byExt = EXT_TO_PLATFORM[e]
  if (byExt) return { platform: byExt, confidence: 'high', reason: fmt(d.byExt, { ext: e }) }
  if (byHeader) return byHeader
  if (AMBIGUOUS.has(e)) return { confidence: 'low', reason: fmt(d.extAmbiguous, { ext: e }) }
  return { confidence: 'low', reason: d.unknown }
}

/** 检测结果的可读描述 */
export function describeDetection(d: RomDetection): string {
  if (!d.platform) return d.reason
  const t = getT()
  const p = platformMap[d.platform]
  return fmt(t.detect.summary, {
    platform: platformLabel(t, d.platform, p?.name ?? d.platform),
    reason: d.reason,
  })
}
