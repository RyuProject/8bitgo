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

/**
 * 头部嗅探读多少字节。
 *
 * 以前是 2048。PSX 的 .bin/.iso 镜像里那句 PLAYSTATION 在第 16 扇区 ——
 * 2048 字节/扇区的 iso 在 0x8000，2352 字节/扇区的 raw bin 在 0x9300，
 * 两个都远超 2KB，所以那条判断实际上一次都没命中过。64KB 能把两种都覆盖住，
 * 而且只是从 File 上切一片，不会把整个 ROM 读进内存。
 */
const HEAD_BYTES = 65536

function ascii(bytes: Uint8Array, start: number, len: number): string {
  const end = Math.min(start + len, bytes.length)
  // String.fromCharCode(...) 是按参数展开的，几万字节会直接把调用栈撑爆，所以分块拼
  let out = ''
  for (let i = start; i < end; i += 4096) {
    out += String.fromCharCode(...bytes.subarray(i, Math.min(i + 4096, end)))
  }
  return out
}

/**
 * SNES 没有魔数 —— 只有一个「内部头」，位置取决于卡带映射方式：
 *   LoROM 在 0x7FC0，HiROM 在 0xFFC0；有些老 dump 前面还多一个 512 字节的拷贝机头。
 *
 * 判据是内部头末尾那对校验和：checksum 与 complement 必须互补（异或等于 0xFFFF），
 * 再要求 21 字节的标题基本都是可打印 ASCII。两条一起卡，撞上巧合的概率极低。
 *
 * 没有这条的话，压缩包里叫 game.bin 的超任游戏只能让用户自己去选平台。
 */
function sniffSnes(b: Uint8Array): boolean {
  for (const copier of [0, 512]) {
    for (const base of [0x7fc0, 0xffc0]) {
      const o = base + copier
      if (o + 32 > b.length) continue
      const complement = b[o + 0x1c] | (b[o + 0x1d] << 8)
      const checksum = b[o + 0x1e] | (b[o + 0x1f] << 8)
      if (!checksum && !complement) continue
      if (((complement ^ checksum) & 0xffff) !== 0xffff) continue
      let printable = 0
      for (let i = 0; i < 21; i++) {
        const c = b[o + i]
        if (c >= 0x20 && c <= 0x7e) printable++
      }
      if (printable >= 18) return true
    }
  }
  return false
}

/** 按文件头判断 */
function sniffHeader(bytes: Uint8Array): RomDetection | null {
  if (bytes.length < 16) return null
  const d = getT().detect
  const head4 = ascii(bytes, 0, 4)
  const head3 = head4.slice(0, 3)
  if (head4 === 'NES\x1A') return { platform: 'nes', confidence: 'high', reason: d.ines }
  if (head3 === 'FWS' || head3 === 'CWS' || head3 === 'ZWS') return { platform: 'flash', confidence: 'high', reason: d.swf }
  if (head4 === 'UNIF') return { platform: 'nes', confidence: 'high', reason: d.unif }
  if (ascii(bytes, 0, 3) === 'FDS' || ascii(bytes, 0, 4) === '\x01*NI') return { platform: 'nes', confidence: 'medium', reason: d.fds }
  const b = bytes
  if (b[0] === 0x80 && b[1] === 0x37 && b[2] === 0x12 && b[3] === 0x40) return { platform: 'n64', confidence: 'high', reason: d.n64z64 }
  if (b[0] === 0x37 && b[1] === 0x80 && b[2] === 0x40 && b[3] === 0x12) return { platform: 'n64', confidence: 'high', reason: d.n64v64 }
  if (b[0] === 0x40 && b[1] === 0x12 && b[2] === 0x37 && b[3] === 0x80) return { platform: 'n64', confidence: 'high', reason: d.n64n64 }
  if (bytes.length >= 0x108 && b[0x104] === 0xce && b[0x105] === 0xed && b[0x106] === 0x66 && b[0x107] === 0x66) {
    return { platform: 'gb', confidence: 'high', reason: d.gbHeader }
  }
  if (b[4] === 0x24 && b[5] === 0xff && b[6] === 0xae && b[7] === 0x51) return { platform: 'gba', confidence: 'high', reason: d.gbaHeader }
  if (bytes.length >= 0x104 && ascii(bytes, 0x100, 4) === 'SEGA') return { platform: 'segaMD', confidence: 'high', reason: d.segaHeader }
  if (sniffSnes(bytes)) return { platform: 'snes', confidence: 'high', reason: d.snesHeader }
  // NDS：0xC0 处是任天堂 logo，头四字节固定 24 FF AE 51（GBA 是同一份 logo，但在 0x04）。
  // 原来比的是 ascii(bytes, 0x0c, 4) === 'NDS' —— 4 个字符去比 3 个字符，恒为 false；
  // 而且 0x0C 本来就是 4 字节的 game code，不可能是 'NDS'。这条判断从来没生效过。
  if (
    bytes.length >= 0x200 &&
    b[0xc0] === 0x24 && b[0xc1] === 0xff && b[0xc2] === 0xae && b[0xc3] === 0x51
  ) {
    return { platform: 'nds', confidence: 'high', reason: d.ndsHeader }
  }
  if (bytes.length >= 0x200 && ascii(bytes, 0, 2) === 'MZ') return { platform: 'dos', confidence: 'medium', reason: d.dosExe }
  // PSX：镜像的系统区在第 16 扇区，要在整个读取窗口里找（见 HEAD_BYTES 的说明）
  const window = ascii(bytes, 0, bytes.length)
  if (window.includes('PLAYSTATION') || window.includes('Sony Computer Entertainment')) {
    return { platform: 'psx', confidence: 'high', reason: d.psxImage }
  }
  return null
}

interface ZipEntry {
  name: string
  /** 解压后大小，用来挑出「那个真正的 ROM」 */
  size: number
  /** 0 = 未压缩，8 = deflate；其它方式我们解不了 */
  method: number
  /** 本地文件头的偏移（真正的数据在它后面） */
  offset: number
  compressedSize: number
}

/** 解析 zip 中央目录（只读文件尾部，不解压） */
async function zipEntries(file: File): Promise<ZipEntry[]> {
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
  const entries: ZipEntry[] = []
  let off = 0
  for (let i = 0; i < count && off + 46 <= cd.length; i++) {
    if (cdView.getUint32(off, true) !== 0x02014b50) break
    const method = cdView.getUint16(off + 10, true)
    const compressedSize = cdView.getUint32(off + 20, true)
    const size = cdView.getUint32(off + 24, true)
    const nameLen = cdView.getUint16(off + 28, true)
    const extraLen = cdView.getUint16(off + 30, true)
    const commentLen = cdView.getUint16(off + 32, true)
    const localOffset = cdView.getUint32(off + 42, true)
    const name = new TextDecoder().decode(cd.subarray(off + 46, off + 46 + nameLen))
    if (!name.endsWith('/')) entries.push({ name, size, method, offset: localOffset, compressedSize })
    off += 46 + nameLen + extraLen + commentLen
  }
  return entries
}

/**
 * 解出压缩包内某个文件的**开头若干字节**，好让 sniffHeader 去认它。
 *
 * 以前只看压缩包里的文件名就下结论，名字叫 game.bin 就直接放弃了 ——
 * 可其实解开头一段看一眼文件头就知道是 MD 还是 N64 还是 PSX。
 *
 * 只喂开头一段压缩数据然后 close()，deflate 会因为数据不完整报错，
 * 这是预期内的：我们要的前几 KB 早就吐出来了，拿到多少算多少。
 */
async function readEntryHead(file: File, entry: ZipEntry, maxBytes: number): Promise<Uint8Array | null> {
  if (entry.method !== 0 && entry.method !== 8) return null
  // 本地文件头的 nameLen / extraLen 可能和中央目录里的不一样，必须重新读一次
  const localHead = new Uint8Array(await file.slice(entry.offset, entry.offset + 30).arrayBuffer())
  if (localHead.length < 30) return null
  const lv = new DataView(localHead.buffer, localHead.byteOffset)
  if (lv.getUint32(0, true) !== 0x04034b50) return null
  const dataStart = entry.offset + 30 + lv.getUint16(26, true) + lv.getUint16(28, true)

  if (entry.method === 0) {
    return new Uint8Array(await file.slice(dataStart, dataStart + maxBytes).arrayBuffer())
  }

  // deflate：用浏览器自带的 DecompressionStream，不引入任何库
  if (typeof DecompressionStream === 'undefined') return null
  // 喂足够多的压缩数据来换出 maxBytes 的明文；ROM 压缩比再好也到不了 16 倍
  const feed = Math.min(entry.compressedSize || maxBytes * 16, maxBytes * 16)
  const chunk = new Uint8Array(await file.slice(dataStart, dataStart + feed).arrayBuffer())

  const out = new Uint8Array(maxBytes)
  let n = 0
  try {
    const ds = new DecompressionStream('deflate-raw')
    const writer = ds.writable.getWriter()
    void writer.write(chunk).catch(() => {})
    void writer.close().catch(() => {})
    const reader = ds.readable.getReader()
    try {
      while (n < maxBytes) {
        const { value, done } = await reader.read()
        if (done) break
        if (!value) continue
        const take = Math.min(value.length, maxBytes - n)
        out.set(value.subarray(0, take), n)
        n += take
      }
    } finally {
      void reader.cancel().catch(() => {})
    }
  } catch {
    // 数据不完整导致的解压报错：见上面的说明，已拿到的部分照样能用
  }
  return n ? out.subarray(0, n) : null
}

export async function detectRom(file: File): Promise<RomDetection> {
  const d = getT().detect
  const e = ext(file.name)

  // 1. 压缩包
  if (e === 'zip' || e === '7z') {
    if (e === '7z') return { confidence: 'low', reason: d.sevenZip }
    const entries = await zipEntries(file)
    const names = entries.map((x) => x.name)

    // 1a. 内部文件名的扩展名就能定平台（最常见）
    const known = entries.map((x) => ({ n: x.name, p: EXT_TO_PLATFORM[ext(x.name)] })).filter((x) => x.p)
    if (known.length) {
      // cue 优先于 bin
      const pick = known.find((x) => ext(x.n) === 'cue') ?? known[0]
      return { platform: pick.p, confidence: 'high', reason: fmt(d.zipContains, { ext: ext(pick.n) }), innerName: pick.n }
    }

    // 1b. 名字看不出来就解开最大的那个文件的开头，用同一套文件头规则认。
    // 压缩包里叫 game.bin / rom.dat 的太常见了，只看名字就放弃等于白白扔掉
    // 已经写好的文件头识别 —— 解开头 64KB 一看，MD / N64 / NES / PSX 都能认出来。
    const biggest = entries.slice().sort((a, b) => b.size - a.size)[0]
    if (biggest) {
      const head = await readEntryHead(file, biggest, HEAD_BYTES)
      const byHeader = head && sniffHeader(head)
      // 只认高置信度：街机 ROM 组里的芯片 dump 偶尔会撞上弱特征
      if (byHeader?.platform && byHeader.confidence === 'high') {
        return {
          platform: byHeader.platform,
          confidence: 'high',
          reason: fmt(d.zipInner, { name: biggest.name, reason: byHeader.reason }),
          innerName: biggest.name,
        }
      }
    }

    // 1c. 多段小文件：街机 ROM 组的典型形态
    if (names.length >= 3) return { platform: 'arcade', confidence: 'medium', reason: d.zipArcade, innerName: names[0] }
    if (names.length === 1 && AMBIGUOUS.has(ext(names[0]))) return { confidence: 'low', reason: fmt(d.zipAmbiguous, { ext: ext(names[0]) }), innerName: names[0] }
    return { confidence: 'low', reason: d.zipUnknown }
  }

  // 2. 文件头
  const head = new Uint8Array(await file.slice(0, HEAD_BYTES).arrayBuffer())
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
