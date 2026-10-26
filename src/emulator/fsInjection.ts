import { ensureParentDir, type WritableFs } from './fsWrite'

/** 要写进 Emscripten 虚拟文件系统的一份附加文件。 */
export interface FsInjection {
  path: string
  /** null 表示资源没拿到；可选资源跳过后仍让核心按原配置尝试。 */
  bytes: string | Promise<Uint8Array | null>
  /**
   * RomData/BIOS 是尽力注入；游戏专属 CHD 缺失则继续开局只会落进 MAME 菜单，
   * 所以它必须显式标为 required，由调用方在 callMain 前阻止错误启动。
   */
  required?: boolean
}

export interface FsInjectionFailure {
  path: string
  required: boolean
  message: string
}

/**
 * 逐份写入 RomData / BIOS，单份失败不能拖掉后面的文件。
 *
 * 街机可能同时需要 `.dat` 与板卡 BIOS。旧实现用一个 try 包住整个循环，第一份写入遇到
 * ENOENT、下载 promise 抛错或存储异常时，后面的文件全部静默消失，最终核心一次报出多份
 * missing files。这里故意把异常边界收窄到单份文件，既保留“尽量开局”的降级策略，
 * 又不会把一个局部故障放大成整局必坏。
 */
export async function writeFsInjections(
  fs: WritableFs,
  injections: readonly FsInjection[],
  onFail: (path: string, message: string) => void,
): Promise<FsInjectionFailure[]> {
  const failures: FsInjectionFailure[] = []
  for (const item of injections) {
    try {
      const bytes = typeof item.bytes === 'string' ? item.bytes : await item.bytes
      if (bytes == null) {
        const message = '资源未下载完成'
        failures.push({ path: item.path, required: Boolean(item.required), message })
        onFail(item.path, message)
        continue
      }
      ensureParentDir(fs, item.path)
      fs.writeFile(item.path, bytes)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      failures.push({ path: item.path, required: Boolean(item.required), message })
      onFail(item.path, message)
    }
  }
  return failures
}
