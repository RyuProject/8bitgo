import { ensureParentDir, type WritableFs } from './fsWrite'

/** 要写进 Emscripten 虚拟文件系统的一份附加文件。 */
export interface FsInjection {
  path: string
  /** null 表示资源没拿到；可选资源跳过后仍让核心按原配置尝试。Blob 到写入时才物化。 */
  bytes: string | Promise<Uint8Array | Blob | null>
  /**
   * 这份字节只属于这一次写入（例如 160MB 的 MAME CHD）：写进 MEMFS 时交出所有权（canOwn），
   * 不再复制第二份；写完立刻放掉引用，不让 startGame 的闭包把它钉在内存里一整局。
   * 按 URL 去重共享的 BIOS 不能标这个。
   */
  exclusive?: boolean
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
      const raw = typeof item.bytes === 'string' ? item.bytes : await item.bytes
      const fromBlob = typeof Blob !== 'undefined' && raw instanceof Blob
      const bytes = fromBlob ? new Uint8Array(await (raw as Blob).arrayBuffer()) : raw as string | Uint8Array | null
      if (bytes == null) {
        const message = '资源未下载完成'
        failures.push({ path: item.path, required: Boolean(item.required), message })
        onFail(item.path, message)
        continue
      }
      ensureParentDir(fs, item.path)
      // 只有我们自己刚物化出来、没有别人引用的缓冲区才能交给 MEMFS 直接持有
      if (item.exclusive && fromBlob && typeof bytes !== 'string') fs.writeFile(item.path, bytes, { canOwn: true })
      else fs.writeFile(item.path, bytes)
      if (item.exclusive) (item as { bytes: FsInjection['bytes'] }).bytes = Promise.resolve(null)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      failures.push({ path: item.path, required: Boolean(item.required), message })
      onFail(item.path, message)
    }
  }
  return failures
}
