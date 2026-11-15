/**
 * 内存里的 ROM 替身：浏览器的 Blob 存储坏掉时（建得出、一读就 NotReadableError），
 * 下载结果和解包结果都只能留在 JS 内存里。替身只实现 size / type / slice() / arrayBuffer()，
 * 够 8BG 解包、ZIP 目录校验用；交给引擎时由 memoryRomOf 取出块数据流式回应（见 installBlobFetchShortcut）。
 *
 * ⚠️ 它不是真 Blob：不能 URL.createObjectURL、不能塞进 new Blob([...])、不能写 IndexedDB、没有 stream()。
 */
/** 内存里的 ROM。parts 交给引擎时逐块置 null，让这份内存在引擎拷走后就能回收。 */
export interface MemoryRom {
  parts: (Uint8Array<ArrayBuffer> | null)[]
  size: number
  type: string
}

/**
 * 每块在整份里的起点（多一个末尾哨兵）。块被置 null 之后长度就没了，偏移不能再靠现算；
 * 内存下载按网络读块切分，几百 MB 有上万块，按偏移二分才不会让每次切片都从头扫一遍。
 */
const memoryRoms = new WeakMap<object, MemoryRom>()
const partOffsets = new WeakMap<MemoryRom, number[]>()

/** memoryRomBlob 造出的替身对应的内存 ROM；真 Blob 返回 undefined。 */
export function memoryRomOf(blob: Blob): MemoryRom | undefined {
  return memoryRoms.get(blob)
}

function offsetsOf(rom: MemoryRom): number[] {
  let offsets = partOffsets.get(rom)
  if (!offsets) {
    // 测试 / 外部手造的 MemoryRom 没登记过偏移：按当前块现算（此时还没有块被放掉）
    offsets = [0]
    for (const part of rom.parts) offsets.push(offsets[offsets.length - 1] + (part?.byteLength ?? 0))
    partOffsets.set(rom, offsets)
  }
  return offsets
}

/** 含 position 的那一块的下标（position 落在 [offsets[i], offsets[i+1])）。 */
function partIndexAt(offsets: number[], position: number): number {
  let lo = 0
  let hi = offsets.length - 2
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1
    if (offsets[mid] <= position) lo = mid
    else hi = mid - 1
  }
  return lo
}

function copyMemoryRange(rom: MemoryRom, start: number, end: number): ArrayBuffer {
  const out = new Uint8Array(Math.max(0, end - start))
  if (start >= end) return out.buffer
  const offsets = offsetsOf(rom)
  for (let index = partIndexAt(offsets, start); index < rom.parts.length && offsets[index] < end; index++) {
    const partAt = offsets[index]
    const size = offsets[index + 1] - partAt
    if (!size) continue
    const part = rom.parts[index]
    // 只有真正要读的那几块被放掉了才算读不出；前面已经消费掉的块不影响后面的读取
    if (!part) throw new DOMException('内存里的 ROM 这一段已经释放（交给引擎或解包时消费掉了）', 'NotReadableError')
    const from = Math.max(start, partAt)
    const to = Math.min(end, partAt + size)
    out.set(part.subarray(from - partAt, to - partAt), from - start)
  }
  return out.buffer
}

/**
 * 放掉整份里 offset 之前的所有完整块：顺序消费（8BG 逐块解密）时，读过的密文不再需要，
 * 及早还给 GC，峰值从「密文 + 明文」降到「明文 + 一块密文」。之后再读这一段会报 NotReadableError。
 */
export function releaseMemoryRomBefore(blob: Blob, offset: number): void {
  const rom = memoryRoms.get(blob)
  if (!rom) return
  const offsets = offsetsOf(rom)
  for (let index = 0; index < rom.parts.length && offsets[index + 1] <= offset; index++) rom.parts[index] = null
}

/** 按 Blob.slice 的规则归一 start / end（负数从尾部算，越界截断）。 */
function clampSliceIndex(value: number | undefined, size: number, fallback: number): number {
  if (value === undefined) return fallback
  return value < 0 ? Math.max(size + value, 0) : Math.min(value, size)
}

/** 把若干块字节包成只读的 Blob 替身（不复制）。 */
export function memoryRomBlob(parts: Uint8Array<ArrayBuffer>[], type = 'application/octet-stream'): Blob {
  const offsets = [0]
  for (const part of parts) offsets.push(offsets[offsets.length - 1] + part.byteLength)
  const rom: MemoryRom = { parts: [...parts], size: offsets[offsets.length - 1], type }
  partOffsets.set(rom, offsets)
  const view = (start: number, end: number): Blob => ({
    size: Math.max(0, end - start),
    type,
    slice: (s?: number, e?: number) => {
      const len = Math.max(0, end - start)
      const from = clampSliceIndex(s, len, 0)
      const to = clampSliceIndex(e, len, len)
      return view(start + from, start + Math.max(from, to))
    },
    arrayBuffer: async () => copyMemoryRange(rom, start, end),
  }) as unknown as Blob
  const whole = view(0, rom.size)
  memoryRoms.set(whole, rom)
  return whole
}
