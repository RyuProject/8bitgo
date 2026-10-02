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

/**
 * 元素按显示尺寸布局时，Ruffle 画布 = CSS 面积 × DPR（已钳到 1.25）。为了给 4K 全屏之类的
 * 极大屏封顶，CSS 面积超过约 1080p 时元素停在这个面积，剩下的倍数交给 transform。
 * 1080p 及以下（绝大多数桌面、全部手机）完全按显示分辨率渲染，矢量画面保持锐利。
 */
export const RUFFLE_MAX_RENDER_AREA = 1920 * 1080

export interface RuffleStageRenderPlan {
  /** 元素的 CSS 宽高（整数像素）：Ruffle 按它 × DPR 建画布 */
  width: number
  height: number
  /** 在此基础上再用 transform 放大的倍数；1 表示不用 transform */
  cssScale: number
}

export function ruffleStageRenderPlan(
  containerWidth: number,
  containerHeight: number,
  stage: RuffleStageSize,
  maxArea = RUFFLE_MAX_RENDER_AREA,
): RuffleStageRenderPlan | null {
  const scale = ruffleStageScale(containerWidth, containerHeight, stage)
  if (!scale) return null
  const areaCap = Math.sqrt(maxArea / (stage.width * stage.height))
  const renderScale = Math.min(scale, Number.isFinite(areaCap) && areaCap > 0 ? areaCap : scale)
  const width = Math.max(1, Math.floor(stage.width * renderScale))
  const height = Math.max(1, Math.floor(stage.height * renderScale))
  // 用取整后的真实尺寸反推剩余倍数，保证最终显示区域仍然贴合容器
  const cssScale = renderScale < scale ? Math.min(containerWidth / width, containerHeight / height) : 1
  return { width, height, cssScale }
}
