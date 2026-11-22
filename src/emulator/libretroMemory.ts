/** Libretro `libretro.h` 中的系统 RAM 内存区编号。 */
export const RETRO_MEMORY_SYSTEM_RAM = 2

export interface LibretroMemoryModule {
  HEAPU8?: Uint8Array
  /** EmulatorJS 的 RetroArch 桥，按 Libretro 内存区名称返回一段 WASM heap view。 */
  EmulatorJSGetMemoryData?: (region: string) => Uint8Array | undefined
  cwrap?: (
    name: string,
    returnType: string,
    argumentTypes: string[],
  ) => (...args: number[]) => number
}

export type SystemRamReader = (offset?: number, length?: number) => Uint8Array | null

/**
 * 生成一份 Libretro system RAM 的只读快照读取器。
 *
 * Libretro 只给出内存指针和长度，不提供游戏分数语义。这里每次都从当前 HEAPU8
 * 复制字节，避免把可增长 WASM 内存的旧视图或可变核心内存暴露给调用方。
 */
export function createSystemRamReader(module: LibretroMemoryModule): SystemRamReader {
  const readThroughEmulatorJs = typeof module.EmulatorJSGetMemoryData === 'function'
  let getMemoryData: ((type: number) => number) | null = null
  let getMemorySize: ((type: number) => number) | null = null
  let resolved = false

  return (offset = 0, length) => {
    if (!Number.isSafeInteger(offset) || offset < 0) return null
    if (length !== undefined && (!Number.isSafeInteger(length) || length < 0)) return null

    if (readThroughEmulatorJs) {
      try {
        // 这是 RetroArch EmulatorJS 构建实际提供的桥；它内部再调用核心的
        // retro_get_memory_data/size。核心与 RetroArch 各自是 WASM 模块时，不能
        // 直接对外层 Module.cwrap 核心符号，否则会一直拿到 undefined。
        const ram = module.EmulatorJSGetMemoryData?.('RETRO_MEMORY_SYSTEM_RAM')
        if (!ram || !ArrayBuffer.isView(ram) || ram.BYTES_PER_ELEMENT !== 1) return null
        const size = ram.byteLength
        if (size <= 0) return null
        if (offset > size) return null
        if (offset === size) return length === undefined || length === 0 ? new Uint8Array() : null
        const end = length === undefined ? size : offset + length
        if (!Number.isSafeInteger(end) || end > size) return null
        // 必须复制：EmulatorJS helper 返回的是 WASM heap 的视图，游戏下一帧会继续改写。
        return Uint8Array.from(ram.subarray(offset, end))
      } catch {
        // 读档、重启或卸载期间核心可能暂时没有 RAM，不能影响游戏循环。
        return null
      }
    }

    if (!resolved) {
      resolved = true
      try {
        if (typeof module.cwrap !== 'function') return null
        getMemoryData = module.cwrap('retro_get_memory_data', 'number', ['number'])
        getMemorySize = module.cwrap('retro_get_memory_size', 'number', ['number'])
      } catch {
        // 官方发布的 FCEUmm 未把这两个 C 导出交给 JS；自建核心会显式保留它们。
        return null
      }
    }

    if (!getMemoryData || !getMemorySize) return null
    try {
      const heap = module.HEAPU8
      if (!heap) return null
      const pointer = getMemoryData(RETRO_MEMORY_SYSTEM_RAM)
      const size = getMemorySize(RETRO_MEMORY_SYSTEM_RAM)
      if (!Number.isSafeInteger(pointer) || pointer <= 0) return null
      if (!Number.isSafeInteger(size) || size <= 0 || pointer + size > heap.byteLength) return null
      if (offset > size) return null
      if (offset === size) return length === undefined || length === 0 ? new Uint8Array() : null
      const end = length === undefined ? size : offset + length
      if (!Number.isSafeInteger(end) || end > size) return null
      return heap.slice(pointer + offset, pointer + end)
    } catch {
      // 游戏卸载或核心重启时，旧 manager 可能暂时指向已失效的 WASM 堆。
      return null
    }
  }
}
