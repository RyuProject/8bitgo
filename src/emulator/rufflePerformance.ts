/**
 * Ruffle 的固定「高清抗锯齿」参数。
 *
 * `quality: high` 提高舞台抗锯齿；Retina 屏上 Ruffle 仍会按
 * CSS 尺寸 × devicePixelRatio 建画布，DPR=2 就是四倍填充量和四倍显存带宽。
 * 旧上限 1× 在大屏全屏时边缘偏糊，因此只在 iframe realm 内把 DPR 钳到 1.25：
 * 像素量比 1× 增加 56.25%，同时仍比原生 DPR=2 少约 61%，给更高抗锯齿留出性能余量。
 * 它不改父页面，也不改游戏时间轴。
 */
export const RUFFLE_FIXED_QUALITY = 'high' as const
export const RUFFLE_RENDER_PIXEL_RATIO = 1.25

type PixelRatioTarget = { devicePixelRatio: number }

/** 必须在加载 ruffle.js 之前调用；失败时保留浏览器原值，不让优化变成启动故障。 */
export function installRufflePixelRatioCap(target: PixelRatioTarget): number {
  const current = Number(target.devicePixelRatio) || 1
  if (current <= RUFFLE_RENDER_PIXEL_RATIO) return current
  try {
    Object.defineProperty(target, 'devicePixelRatio', {
      configurable: true,
      get: () => RUFFLE_RENDER_PIXEL_RATIO,
    })
  } catch {
    return current
  }
  return Number(target.devicePixelRatio) || current
}

/**
 * Ruffle 0.6 会按这五项能力在增强版 / 兼容版 WASM 之间二选一。
 * 预热必须做同样的选择；猜错会先白下约 14 MB，再由 Ruffle 下载另一份。
 */
const WASM_EXTENSION_PROBES = [
  [0, 97, 115, 109, 1, 0, 0, 0, 1, 4, 1, 96, 0, 0, 3, 2, 1, 0, 5, 3, 1, 0, 1, 10, 14, 1, 12, 0, 65, 0, 65, 0, 65, 0, 252, 10, 0, 0, 11],
  [0, 97, 115, 109, 1, 0, 0, 0, 1, 5, 1, 96, 0, 1, 123, 3, 2, 1, 0, 10, 10, 1, 8, 0, 65, 0, 253, 15, 253, 98, 11],
  [0, 97, 115, 109, 1, 0, 0, 0, 1, 4, 1, 96, 0, 0, 3, 2, 1, 0, 10, 12, 1, 10, 0, 67, 0, 0, 0, 0, 252, 0, 26, 11],
  [0, 97, 115, 109, 1, 0, 0, 0, 1, 4, 1, 96, 0, 0, 3, 2, 1, 0, 10, 8, 1, 6, 0, 65, 0, 192, 26, 11],
  [0, 97, 115, 109, 1, 0, 0, 0, 1, 4, 1, 96, 0, 0, 3, 2, 1, 0, 10, 7, 1, 5, 0, 208, 112, 26, 11],
] as const

export function supportsRuffleWasmExtensions(
  validate: (bytes: BufferSource) => boolean = WebAssembly.validate,
): boolean {
  try {
    return WASM_EXTENSION_PROBES.every((probe) => validate(new Uint8Array(probe)))
  } catch {
    return false
  }
}
