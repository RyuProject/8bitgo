/** 需要在 Pointer Lock 里维护的 0～1 绝对坐标。 */
export interface LockedAbsolutePointer {
  x: number
  y: number
}

interface PointerViewport {
  width: number
  height: number
}

export interface PointerRect extends PointerViewport {
  left: number
  top: number
}

const clamp01 = (value: number): number => Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0))

/**
 * canvas 元素通常铺满播放器，但 DOS 画面会在里面按比例留黑边；绝对坐标必须相对实际画面计算。
 * 否则 4:3 游戏放进宽屏播放器后，左右各有一段到不了 0/1，边缘菜单和滚屏区就会点不准。
 */
export function lockedAbsoluteContentRect(container: PointerRect, content: PointerViewport): PointerRect {
  if (
    !Number.isFinite(container.width) || container.width <= 0
    || !Number.isFinite(container.height) || container.height <= 0
    || !Number.isFinite(content.width) || content.width <= 0
    || !Number.isFinite(content.height) || content.height <= 0
  ) return container

  const aspect = content.width / content.height
  let width = container.width
  let height = width / aspect
  if (height > container.height) {
    height = container.height
    width = height * aspect
  }
  return {
    left: container.left + (container.width - width) / 2,
    top: container.top + (container.height - height) / 2,
    width,
    height,
  }
}

/**
 * Pointer Lock 只给相对位移；绝对坐标客体则要 0～1 的位置，所以在浏览器这一侧累积。
 *
 * Windows 里的 DOSBox-X 集成驱动只消费绝对位置；《主题医院》这类原生 DOS 图形界面也依赖
 * 绝对光标。若让 js-dos 因为捕获鼠标而改发相对包，前者会把正负数钳成四角，后者的软件
 * 光标则不会按屏幕位置移动。以画布 CSS 尺寸归一化可以同时保留点击捕获与准确指向，且不会
 * 因为高 DPI 或模拟器内部切换分辨率而突然变速。
 */
export function advanceLockedAbsolutePointer(
  current: LockedAbsolutePointer,
  deltaX: number,
  deltaY: number,
  viewport: PointerViewport,
  invertY = false,
): LockedAbsolutePointer {
  const width = Number.isFinite(viewport.width) && viewport.width > 0 ? viewport.width : null
  const height = Number.isFinite(viewport.height) && viewport.height > 0 ? viewport.height : null
  const dx = Number.isFinite(deltaX) ? deltaX : 0
  const dy = Number.isFinite(deltaY) ? deltaY : 0
  return {
    // 全屏切换的极短窗口里画布可能报告 0×0；这时保持原位比除以 1 后又撞到边缘安全。
    x: clamp01(current.x + (width ? dx / width : 0)),
    y: clamp01(current.y + (height ? (invertY ? -dy : dy) / height : 0)),
  }
}

/** 首次点击捕获时按画布落点校准；Esc 释放后再次点击也会从新落点开始。 */
export function lockedAbsolutePointerAtClientPosition(
  clientX: number,
  clientY: number,
  rect: PointerRect,
): LockedAbsolutePointer {
  if (!Number.isFinite(rect.width) || rect.width <= 0 || !Number.isFinite(rect.height) || rect.height <= 0) {
    return { x: 0.5, y: 0.5 }
  }
  return {
    x: clamp01((clientX - rect.left) / rect.width),
    y: clamp01((clientY - rect.top) / rect.height),
  }
}
