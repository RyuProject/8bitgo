/** DOS 需要在浏览器内存里重打包时使用的保守预算；已打好的 bundle 仍可走 Blob 透传。 */
export interface DosLoadHints {
  deviceMemory?: number
  hardwareConcurrency?: number
  userAgent?: string
  platform?: string
  maxTouchPoints?: number
  effectiveType?: string
  saveData?: boolean
}

export interface DosLoadLimits {
  arrayBufferBytes: number
  /** 已成形 bundle 可用 Blob 透传，但下载与引擎展开仍需独立硬上限。 */
  bundleBlobBytes: number
  bundleUnpackedBytes: number
  extraFileBytes: number
  extraTotalBytes: number
  extraConcurrency: number
  systemImageBytes: number
}

const MIB = 1024 * 1024

export function dosLoadLimits(hints: DosLoadHints = {}): DosLoadLimits {
  const deviceMemory = Number.isFinite(hints.deviceMemory) ? Number(hints.deviceMemory) : 0
  const hardwareConcurrency = Number.isFinite(hints.hardwareConcurrency) ? Number(hints.hardwareConcurrency) : 0
  const mobileUserAgent = /Android|iPhone|iPad|iPod|Mobile/i.test(hints.userAgent ?? '')
  const touchMac = (hints.maxTouchPoints ?? 0) > 1 && /^Mac/i.test(hints.platform ?? '')
  // Safari 不公开 deviceMemory；设备类型与线程数共同兜底，避免把单份大包的两次复制压到手机上。
  const lowMemory = mobileUserAgent || touchMac || (deviceMemory > 0 && deviceMemory <= 4) ||
    (hardwareConcurrency > 0 && hardwareConcurrency <= 2)
  const weakNetwork = Boolean(hints.saveData) || /^(?:slow-2g|2g|3g)$/i.test(hints.effectiveType ?? '')

  return lowMemory
    ? {
        arrayBufferBytes: 256 * MIB,
        // Blob 避免整包常驻 JS 堆，但引擎仍会展开虚拟盘；大游戏应配置 Sockdrive 按需读取。
        bundleBlobBytes: 768 * MIB,
        bundleUnpackedBytes: 512 * MIB,
        extraFileBytes: 128 * MIB,
        extraTotalBytes: 256 * MIB,
        extraConcurrency: 1,
        // 现场实测最大的正式 Windows 95 镜像约 93 MiB；手机留 128 MiB 上限，拦住错误页/错绑大包。
        systemImageBytes: 128 * MIB,
      }
    : {
        arrayBufferBytes: 1024 * MIB,
        bundleBlobBytes: 2048 * MIB,
        // js-dos 与 DOSBox-X 运行时本身也占 WASM 线性内存，展开盘留在 2 GiB 内避免逼近地址空间上限。
        bundleUnpackedBytes: 2048 * MIB,
        extraFileBytes: 512 * MIB,
        extraTotalBytes: 1024 * MIB,
        // 附加文件会同时驻留内存；两路足够重叠 RTT，也限制 500 MiB 资料片造成的峰值。
        extraConcurrency: weakNetwork ? 1 : 2,
        systemImageBytes: 512 * MIB,
      }
}

/** ROM 与系统镜像必须按同一套设备信息判断，Safari 不公开 deviceMemory 时以平台和触控特征兜底。 */
export function dosLoadLimitsForBrowser(): DosLoadLimits {
  if (typeof navigator === 'undefined') return dosLoadLimits()
  const browser = navigator as Navigator & {
    deviceMemory?: number
    connection?: { effectiveType?: string; saveData?: boolean }
  }
  return dosLoadLimits({
    deviceMemory: browser.deviceMemory,
    hardwareConcurrency: browser.hardwareConcurrency,
    userAgent: browser.userAgent,
    platform: browser.platform,
    maxTouchPoints: browser.maxTouchPoints,
    effectiveType: browser.connection?.effectiveType,
    saveData: browser.connection?.saveData,
  })
}
