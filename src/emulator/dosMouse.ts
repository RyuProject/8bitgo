/** js-dos 的 0~1 滑块中点正好是 1×；两端按上游公式对应 0.125× 与 8×。 */
export const DOS_MOUSE_SENSITIVITY_DEFAULT = 0.5

/**
 * js-dos 的 Pointer Lock 默认把浏览器位移作为相对包发给 DOSBox，适合 FPS，却不适合所有游戏。
 * 《主题医院》是已在真机页面复现的例外：它今天被统一切进相对路径后，软件光标不再随屏幕位置
 * 正常移动。这里按游戏收窄兼容范围，避免把毁灭战士等需要无限转向的游戏也改成有边界的光标。
 */
const LOCKED_ABSOLUTE_MOUSE_GAMES = new Set([
  'theme-hospital',
])

export function needsLockedAbsoluteDosMouse(gameSlug?: string): boolean {
  return Boolean(gameSlug && LOCKED_ABSOLUTE_MOUSE_GAMES.has(gameSlug))
}

export function normalizeDosMouseSensitivity(value: unknown): number {
  const n = typeof value === 'number'
    ? value
    : typeof value === 'string' && value.trim()
      ? Number(value)
      : Number.NaN
  if (!Number.isFinite(n)) return DOS_MOUSE_SENSITIVITY_DEFAULT
  return Math.min(1, Math.max(0, n))
}

/** 只给界面展示；实际换算仍由 js-dos 做，避免我们和上游输入算法分叉。 */
export function dosMouseSpeedMultiplier(value: number): number {
  return Math.pow(8, normalizeDosMouseSensitivity(value) * 2 - 1)
}
