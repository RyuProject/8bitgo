import { ensureParentDir, type WritableFs } from './fsWrite'

/** 要写进 Emscripten 虚拟文件系统的一份附加文件。 */
export interface FsInjection {
  path: string
  /** null 表示资源没拿到；跳过后让核心自己报告缺的是哪一份。 */
  bytes: string | Promise<Uint8Array | null>
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
): Promise<void> {
  for (const item of injections) {
    try {
      const bytes = typeof item.bytes === 'string' ? item.bytes : await item.bytes
      if (bytes == null) continue
      ensureParentDir(fs, item.path)
      fs.writeFile(item.path, bytes)
    } catch (error) {
      onFail(item.path, error instanceof Error ? error.message : String(error))
    }
  }
}
