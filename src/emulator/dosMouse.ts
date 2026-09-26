/** js-dos 的 0~1 滑块中点正好是 1×；两端按上游公式对应 0.125× 与 8×。 */
export const DOS_MOUSE_SENSITIVITY_DEFAULT = 0.5

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
