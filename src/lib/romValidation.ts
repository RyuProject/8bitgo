/**
 * ROM 的第一道格式校验。
 *
 * 模拟器核心仍是最终裁判；这里负责在启动核心之前挡住 HTML 错误页、截断压缩包和明显
 * 不属于目标平台的文件。提前报出“文件损坏/格式不对”比让每个核心吐一条晦涩错误可靠。
 */
import { assertValidZip, assertValidZipBlob, extractRomFromZip, isZip, type ZipFileEntry } from './unzip'

function ascii(bytes: Uint8Array, start: number, length: number): string {
  return String.fromCharCode(...bytes.subarray(start, Math.min(bytes.length, start + length)))
}

/** 没有 Content-Type 或 CDN 标错类型时，仍按正文识别 SSR / 网关错误页。 */
export function assertNotHtml(buf: ArrayBuffer, label = 'ROM'): void {
  if (buf.byteLength === 0) throw new Error(`${label} 文件为空`)
  const head = new Uint8Array(buf, 0, Math.min(256, buf.byteLength))
  const text = new TextDecoder().decode(head).replace(/^\uFEFF/, '').trimStart().toLowerCase()
  if (text.startsWith('<!doctype html') || text.startsWith('<html') || text.startsWith('<head')) {
    throw new Error(`${label} 地址返回了网页，不是游戏文件`)
  }
}

/** jsnes 最终只会接受这些 NES 容器；先挡住改错扩展名的其它文件。 */
export function assertNesRom(buf: ArrayBuffer): void {
  assertNotHtml(buf, 'NES ROM')
  const b = new Uint8Array(buf)
  const head4 = ascii(b, 0, 4)
  const ines = head4 === 'NES\x1a'
  const unif = head4 === 'UNIF'
  const fds = ascii(b, 0, 3) === 'FDS' || head4 === '\x01*NI'
  if (b.length < 16 || (!ines && !unif && !fds)) {
    throw new Error('不是有效的 NES ROM（缺少 iNES / UNIF / FDS 文件头）')
  }
  if (ines) {
    const trainer = b[6] & 0x04 ? 512 : 0
    const nes2 = (b[7] & 0x0c) === 0x08
    const prgHigh = nes2 ? b[9] & 0x0f : 0
    const chrHigh = nes2 ? (b[9] >>> 4) & 0x0f : 0
    // NES 2.0 的 0xF 是指数编码，另有公式；那一小撮 ROM 留给 jsnes 最终判断。
    if (prgHigh !== 0x0f && chrHigh !== 0x0f) {
      const prgUnits = b[4] | (prgHigh << 8)
      const chrUnits = b[5] | (chrHigh << 8)
      const expected = 16 + trainer + prgUnits * 16_384 + chrUnits * 8_192
      if (b.length < expected) throw new Error(`NES ROM 下载不完整：文件头声明至少 ${expected} 字节`)
    }
  }
}

/** SWF 的签名在压缩之前，FWS/CWS/ZWS 三种都能稳定识别。 */
export function assertSwf(buf: ArrayBuffer): void {
  assertNotHtml(buf, 'Flash 文件')
  const b = new Uint8Array(buf)
  const magic = ascii(b, 0, 3)
  if (b.length < 8 || !['FWS', 'CWS', 'ZWS'].includes(magic)) {
    throw new Error('不是有效的 SWF 文件（缺少 FWS / CWS / ZWS 文件头）')
  }
  const declared = new DataView(buf).getUint32(4, true)
  if (declared < 8) throw new Error('SWF 文件头中的长度无效')
  // 只有 FWS 是未压缩文件，声明长度应当能在当前字节里完整兑现；CWS/ZWS 声明的是解压后大小。
  if (magic === 'FWS' && declared > b.length) throw new Error('SWF 文件下载不完整')
}

function isNdsHeader(buf: ArrayBuffer): boolean {
  const b = new Uint8Array(buf)
  // 任天堂 Logo 从 0xC0 开始；四字节签名加头部最小长度足以挡住改后缀和错误页，
  // 最终完整 Logo / ROM 映射仍由 melonDS 校验，兼容自制 ROM 的非标准头部字段。
  return b.length >= 0x200 && b[0xc0] === 0x24 && b[0xc1] === 0xff && b[0xc2] === 0xae && b[0xc3] === 0x51
}

function assertNdsSections(buf: ArrayBuffer, totalBytes = buf.byteLength): void {
  const view = new DataView(buf)
  for (const [label, offsetAt, sizeAt] of [
    ['ARM9', 0x20, 0x2c],
    ['ARM7', 0x30, 0x3c],
  ] as const) {
    const offset = view.getUint32(offsetAt, true)
    const size = view.getUint32(sizeAt, true)
    if (size > 0 && (offset < 0x200 || offset + size > totalBytes)) {
      throw new Error(`NDS ROM 下载不完整：${label} 程序段超出文件范围`)
    }
  }
}

/** 任天堂 DS 卡带的官方容量上限是 512 MiB；超过它的 ZIP 多半是损坏头或解压炸弹。 */
const MAX_NDS_ROM_BYTES = 512 * 1024 * 1024

export interface NdsBlobValidation {
  /** ZIP 包里唯一的 ROM 路径；裸 ROM 没有。适配器用它绕过 EmulatorJS“取第一个文件”的兜底。 */
  archiveEntry?: string
}

/**
 * 大 NDS ROM 的流式路径只读文件头和 ZIP 中央目录，不把几百 MB Blob 变回 ArrayBuffer。
 *
 * 这道校验必须发生在 romCachePutBlob **之前**：反代有时会 200 返回 JSON/HTML 错误体，
 * 若先缓存，之后每次重试都会从 IndexedDB 复活同一份假 ROM，网络恢复也救不回来。
 * ZIP 还要钉住“恰好一个 ROM”与解压大小；否则 EmulatorJS 会在找不到支持扩展名时取包内
 * 第一个文件，README 排在 `.srl` 前面就会把文本交给核心，表现仍是无原因的 No Items。
 */
export async function assertNdsRomBlob(blob: Blob): Promise<NdsBlobValidation> {
  if (blob.size === 0) throw new Error('NDS ROM 文件为空')
  const head = await blob.slice(0, 0x200).arrayBuffer()
  assertNotHtml(head, 'NDS ROM')

  if (isZip(head)) {
    const entries = await assertValidZipBlob(blob, 'NDS ROM')
    if (entries.length > 128) throw new Error('NDS ZIP 文件过多，疑似错误的整包或解压炸弹')
    let unpackedTotal = 0
    for (const entry of entries) {
      // EJS 会把包内每一项写进虚拟文件系统；先挡掉目录穿越，不能只检查最后选中的 ROM。
      if (
        entry.name.startsWith('/')
        // eslint-disable-next-line no-control-regex -- ZIP 路径不能含 NUL/控制字符；这是输入校验，不是文本搜索。
        || /[\x00-\x1f]/.test(entry.name)
        || entry.name.split('/').some((part) => !part || part === '.' || part === '..')
      ) throw new Error(`NDS ZIP 内含不安全路径：${entry.name}`)
      unpackedTotal += entry.uncompressedSize
    }
    if (unpackedTotal > MAX_NDS_ROM_BYTES + 16 * 1024 * 1024) {
      throw new Error('NDS ZIP 解开后的总大小异常，疑似解压炸弹')
    }
    const roms = entries.filter((entry) => /\.(?:nds|srl)$/i.test(entry.name))
    if (roms.length !== 1) {
      throw new Error(roms.length
        ? 'NDS ZIP 内有多个 ROM，请每个压缩包只保留一款游戏'
        : 'NDS ZIP 内找不到 .nds 或 .srl ROM')
    }
    if (roms[0].uncompressedSize < 0x200) throw new Error('NDS ZIP 内的 ROM 文件过短')
    if (roms[0].uncompressedSize > MAX_NDS_ROM_BYTES) throw new Error('NDS ZIP 解开后超过 512MB，疑似损坏或解压炸弹')
    return { archiveEntry: roms[0].name }
  }

  if (blob.size > MAX_NDS_ROM_BYTES) throw new Error('NDS ROM 超过 512MB，不是有效的 DS 卡带镜像')
  if (!isNdsHeader(head)) throw new Error('不是有效的 NDS ROM（缺少 Nintendo DS 文件头）')
  assertNdsSections(head, blob.size)
  return {}
}

/** ZIP 版 NDS 解出真正的 ROM 再验证，避免把包装层交给 webretro 猜。 */
export async function prepareNdsRom(buf: ArrayBuffer, name: string): Promise<{ data: ArrayBuffer; name: string }> {
  assertNotHtml(buf, 'NDS ROM')
  let data = buf
  let romName = name
  if (isZip(buf)) {
    assertValidZip(buf, 'NDS ROM')
    const extracted = await extractRomFromZip(buf, ['nds', 'srl'])
    data = extracted.data.buffer.slice(extracted.data.byteOffset, extracted.data.byteOffset + extracted.data.byteLength) as ArrayBuffer
    romName = extracted.name
  }
  if (!isNdsHeader(data)) throw new Error('不是有效的 NDS ROM（缺少 Nintendo DS 文件头）')
  assertNdsSections(data)
  return { data, name: romName }
}

/** JAR 本质是 ZIP；manifest 与 class 同时存在才像一个能启动的 MIDlet。 */
export function assertJar(buf: ArrayBuffer): ZipFileEntry[] {
  assertNotHtml(buf, 'J2ME 文件')
  const entries = assertValidZip(buf, 'J2ME JAR')
  const names = entries.map((e) => e.name.toLowerCase())
  if (!names.includes('meta-inf/manifest.mf')) throw new Error('J2ME JAR 缺少 META-INF/MANIFEST.MF')
  if (!names.some((n) => n.endsWith('.class'))) throw new Error('J2ME JAR 里没有 Java class 文件')
  return entries
}
