/** Ruffle 的两种画面布局；旧数据没有这个字段时默认走等比居中。 */
export type RuffleDisplayMode = 'fit' | 'ruffle'

export interface RuffleStageSize {
  width: number
  height: number
}

const MAX_STAGE_EDGE = 16384

/**
 * Ruffle 在 loadedmetadata 后公开 SWF 的原始舞台尺寸。
 *
 * 这里不接受字符串、无穷大或离谱尺寸：这个值最后会进入元素样式，损坏的 SWF 元数据不能
 * 把页面撑成数百万像素。取整是因为浏览器画布最终也只能落到整数像素。
 */
export function ruffleStageSize(metadata: unknown): RuffleStageSize | null {
  if (!metadata || typeof metadata !== 'object') return null
  const { width, height } = metadata as { width?: unknown; height?: unknown }
  if (typeof width !== 'number' || typeof height !== 'number') return null
  if (!Number.isFinite(width) || !Number.isFinite(height)) return null
  const roundedWidth = Math.round(width)
  const roundedHeight = Math.round(height)
  if (roundedWidth < 1 || roundedHeight < 1) return null
  if (roundedWidth > MAX_STAGE_EDGE || roundedHeight > MAX_STAGE_EDGE) return null
  return { width: roundedWidth, height: roundedHeight }
}

/** 计算完整舞台能放进容器的最大等比缩放值。 */
export function ruffleStageScale(
  containerWidth: number,
  containerHeight: number,
  stage: RuffleStageSize,
): number | null {
  if (!Number.isFinite(containerWidth) || !Number.isFinite(containerHeight)) return null
  if (containerWidth <= 0 || containerHeight <= 0) return null
  const scale = Math.min(containerWidth / stage.width, containerHeight / stage.height)
  return Number.isFinite(scale) && scale > 0 ? scale : null
}
