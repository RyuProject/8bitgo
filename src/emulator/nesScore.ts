/** NES 分数只是游戏 RAM 中的字节；只有精确 ROM 指纹命中配置后才尝试解码。 */
export type NesScoreEncoding =
  | { kind: 'binary'; byteOrder: 'little' | 'big' }
  | { kind: 'packed-bcd'; byteOrder: 'little' | 'big'; nibbleOrder: 'high-first' | 'low-first' }
  | { kind: 'decimal-digits'; byteOrder: 'little' | 'big' }
  | { kind: 'ascii-decimal' }

/** 一份已核实的游戏 / ROM 版本分数布局。byteOffsets 按 RAM 地址顺序填写。 */
export interface NesScoreProfile {
  gameSlug: string
  /** 裸 NES ROM 的 SHA-256；不能用文件名、语言槽或标题替代版本指纹。 */
  romSha256: string
  /** 便于维护者辨认的 ROM 版本说明，不参与匹配。 */
  version: string
  /** 分数占用的 system RAM 偏移；允许非连续地址。 */
  byteOffsets: readonly number[]
  encoding: NesScoreEncoding
}

export interface NesScoreFileSystem {
  readFile: (path: string) => Uint8Array
}

/** ROM 指纹读取仅对已配置游戏启用，避免给其它 NES 游戏增加拷贝或启动开销。 */
export const MAX_NES_SCORE_ROM_BYTES = 16 * 1024 * 1024

const SHA256_RE = /^[a-f0-9]{64}$/

function validProfile(profile: NesScoreProfile): boolean {
  if (!profile || typeof profile !== 'object' || typeof profile.gameSlug !== 'string' ||
      typeof profile.romSha256 !== 'string' || typeof profile.version !== 'string' ||
      !profile.gameSlug.trim() || !SHA256_RE.test(profile.romSha256) || !profile.version.trim() ||
      !profile.encoding || typeof profile.encoding !== 'object') return false
  const offsets = profile.byteOffsets
  if (!Array.isArray(offsets) || offsets.length < 1 || offsets.length > 16) return false
  if (offsets.some((offset, index) => !Number.isSafeInteger(offset) || offset < 0 || (index > 0 && offset <= offsets[index - 1])) ||
      new Set(offsets).size !== offsets.length) return false
  switch (profile.encoding.kind) {
    case 'binary':
      return offsets.length <= 8 && (profile.encoding.byteOrder === 'little' || profile.encoding.byteOrder === 'big')
    case 'packed-bcd':
      return (profile.encoding.byteOrder === 'little' || profile.encoding.byteOrder === 'big') &&
        (profile.encoding.nibbleOrder === 'high-first' || profile.encoding.nibbleOrder === 'low-first')
    case 'decimal-digits':
      return profile.encoding.byteOrder === 'little' || profile.encoding.byteOrder === 'big'
    case 'ascii-decimal':
      return true
    default:
      return false
  }
}

/** 只在游戏 slug 和完整 SHA-256 都相同时返回配置；未知版本不继承同名游戏的地址。 */
export function findNesScoreProfile(
  profiles: readonly NesScoreProfile[],
  gameSlug: string,
  romSha256: string,
): NesScoreProfile | null {
  const slug = gameSlug.trim()
  const digest = romSha256.trim().toLowerCase()
  if (!slug || !SHA256_RE.test(digest)) return null
  const matches = profiles.filter((profile) => validProfile(profile) && profile.gameSlug === slug && profile.romSha256 === digest)
  // 配置重复时不能随数组顺序挑一个地址；拒绝识别比读错分数安全。
  return matches.length === 1 ? matches[0] : null
}

/** 游戏启动后读取 MEMFS 中已经交给核心的 ROM；失败只关闭分数识别，不影响开局。 */
export async function hashNesRomInFs(
  fs: NesScoreFileSystem,
  fileName: string,
  subtle: Pick<SubtleCrypto, 'digest'> | undefined = globalThis.crypto?.subtle,
): Promise<string | null> {
  try {
    if (!subtle || !fileName.trim()) return null
    const relative = fileName.replace(/^\/+/, '')
    if (!relative || relative.split('/').some((part) => !part || part === '.' || part === '..')) return null
    const bytes = fs.readFile(`/${relative}`)
    // FS 在 EmulatorJS iframe 里，instanceof 会因跨 realm 失败；按 TypedArray 视图特征判断。
    if (!ArrayBuffer.isView(bytes) || bytes.BYTES_PER_ELEMENT !== 1 || bytes.byteLength < 16 || bytes.byteLength > MAX_NES_SCORE_ROM_BYTES) return null
    // MEMFS 可能返回 WASM heap 的视图；WebCrypto 只收到一份有界副本，不暴露也不改写模拟器内存。
    const owned = Uint8Array.from(bytes)
    const digest = await subtle.digest('SHA-256', owned.buffer)
    return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
  } catch {
    return null
  }
}

/** 把 RAM 快照解成十进制字符串，保留 BCD / ASCII 分数的前导零。 */
export function decodeNesScore(ram: Uint8Array | null, profile: NesScoreProfile): string | null {
  if (!ram || !validProfile(profile) || profile.byteOffsets.some((offset) => offset >= ram.length)) return null
  const bytes = profile.byteOffsets.map((offset) => ram[offset])
  const encoding = profile.encoding

  if (encoding.kind === 'binary') {
    const significanceOrder = encoding.byteOrder === 'little' ? [...bytes].reverse() : bytes
    let value = 0n
    for (const byte of significanceOrder) value = (value << 8n) | BigInt(byte)
    return value.toString(10)
  }

  if (encoding.kind === 'packed-bcd') {
    const significanceOrder = encoding.byteOrder === 'little' ? [...bytes].reverse() : bytes
    let digits = ''
    for (const byte of significanceOrder) {
      const pair = encoding.nibbleOrder === 'high-first'
        ? [byte >>> 4, byte & 0x0f]
        : [byte & 0x0f, byte >>> 4]
      if (pair.some((digit) => digit > 9)) return null
      digits += pair.join('')
    }
    return digits
  }

  if (encoding.kind === 'decimal-digits') {
    const digits = encoding.byteOrder === 'little' ? [...bytes].reverse() : bytes
    return digits.every((digit) => digit <= 9) ? digits.join('') : null
  }

  if (encoding.kind === 'ascii-decimal') {
    return bytes.every((byte) => byte >= 0x30 && byte <= 0x39)
      ? String.fromCharCode(...bytes)
      : null
  }

  return null
}
