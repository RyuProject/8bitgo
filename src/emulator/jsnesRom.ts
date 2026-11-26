/** jsnes 专用 ROM 入口：限制主线程要同时持有的副本，并在交给核心前解开容器。 */
import { assertValidZip, extractRomFromZip, isZip } from '@/lib/unzip'
import { assertNesRom } from '@/lib/romValidation'
import { loadGameBytes } from './romLoader'
import type { LoadProgress } from './types'
import { JSNES_MAX_ROM_BYTES } from './nesMapper'

const MAX_JSNES_ARCHIVE_BYTES = JSNES_MAX_ROM_BYTES

function validateJsnesContainer(data: ArrayBuffer): void {
  if (!isZip(data)) {
    assertNesRom(data)
    return
  }

  const entries = assertValidZip(data, 'NES ZIP')
  if (entries.length > 256) throw new Error('NES ZIP 内文件过多，已交给兼容面更广的模拟器处理')
  const extOf = (name: string) => name.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1] ?? ''
  let selected: (typeof entries)[number] | undefined
  for (const ext of ['nes', 'unf', 'unif', 'fds']) {
    selected = entries.find((entry) => extOf(entry.name) === ext)
    if (selected) break
  }
  const candidate = selected ?? entries.reduce((a, b) => b.uncompressedSize > a.uncompressedSize ? b : a)
  if (candidate.uncompressedSize > JSNES_MAX_ROM_BYTES) throw new JsnesRomTooLargeError()
  if (candidate.uncompressedSize < 16) throw new Error('NES ZIP 内的 ROM 文件过短')
  if ((candidate.flags ?? 0) & 0x01) throw new Error('NES ZIP 内的 ROM 经过加密，无法由浏览器解压')
  if (candidate.method !== 0 && candidate.method !== 8) throw new Error(`NES ZIP 使用了不支持的压缩方式 ${candidate.method}`)
}

export class JsnesRomTooLargeError extends Error {
  constructor() {
    super(`NES ROM 超过 jsnes 的 ${Math.floor(JSNES_MAX_ROM_BYTES / 1024 / 1024)} MiB 安全上限，将改用兼容面更广的模拟器`)
    this.name = 'JsnesRomTooLargeError'
  }
}

/**
 * 把 ZIP 内层大小上限和纯 JS 核心的输入上限统一起来。
 * 先限制外层下载和 8BG 解包，再限制 ZIP 成员，避免移动浏览器为解压炸弹分配大块内存。
 */
export async function prepareJsnesRom(data: ArrayBuffer): Promise<ArrayBuffer> {
  if (data.byteLength > MAX_JSNES_ARCHIVE_BYTES) throw new JsnesRomTooLargeError()
  let buf = data

  if (isZip(buf)) {
    let extracted: Awaited<ReturnType<typeof extractRomFromZip>>
    try {
      // 浏览器的 deflate-raw 通常不校验 ZIP CRC；坏包可能解出同长度垃圾并被当作可玩 ROM。
      extracted = await extractRomFromZip(buf, ['nes', 'unf', 'unif', 'fds'], JSNES_MAX_ROM_BYTES, true)
    } catch (error) {
      if (/解包后的 ROM 过大/.test(error instanceof Error ? error.message : String(error))) {
        throw new JsnesRomTooLargeError()
      }
      throw error
    }
    if (extracted.data.byteLength > JSNES_MAX_ROM_BYTES) throw new JsnesRomTooLargeError()
    buf = extracted.data.buffer.slice(
      extracted.data.byteOffset,
      extracted.data.byteOffset + extracted.data.byteLength,
    ) as ArrayBuffer
  }

  if (buf.byteLength > JSNES_MAX_ROM_BYTES) throw new JsnesRomTooLargeError()
  assertNesRom(buf)
  return buf
}

export async function readJsnesRom(
  game: File | string,
  onProgress?: (progress: LoadProgress) => void,
  signal?: AbortSignal,
): Promise<ArrayBuffer> {
  let loaded: Awaited<ReturnType<typeof loadGameBytes>>
  try {
    loaded = await loadGameBytes(game, onProgress, signal, {
      maxBytes: MAX_JSNES_ARCHIVE_BYTES,
      maxUnpackedBytes: JSNES_MAX_ROM_BYTES,
      // 格式与 ZIP 元数据必须在 romLoader 写 IndexedDB 前验证，坏对象不能被重试永久复用。
      validate: validateJsnesContainer,
    })
  } catch (error) {
    // 大文件走 onUnsupported，让播放器切到 EmulatorJS；否则纯 JS 字符串转换会在移动端耗尽内存。
    if (error instanceof RangeError) throw new JsnesRomTooLargeError()
    throw error
  }
  return prepareJsnesRom(loaded.data)
}
