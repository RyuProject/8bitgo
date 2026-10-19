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

/**
 * 《天之痕》进入新游戏时才创建 DirectInput 独占设备；DOSBox-X 的 dboxmpi 绝对鼠标驱动
 * 会让这一步失败，所以它使用专门修过的 Win95 系统盘与标准相对鼠标。这里同时校验 EXE，
 * 避免同一个 slug 将来换成启动器后仍误切协议，出现标题页光标完全不动的静默故障。
 */
export function needsRelativeWindowsGuestMouse(gameSlug?: string, executable?: string): boolean {
  const slug = gameSlug?.trim().toLowerCase()
  const file = executable?.trim().replace(/\\/g, '/').split('/').pop()?.toLowerCase()
  return slug === 'xuan-yuan-sword-scar-of-sky' && file === 'swd3e.exe'
}

export function needsLockedAbsoluteDosMouse(gameSlug?: string): boolean {
  // slug 正常来自 API，仍在这里做一次归一化：本地 ROM / 嵌入页若带了大小写或首尾空格，
  // 不该悄悄掉回会让光标失控的相对坐标路径。
  return Boolean(gameSlug && LOCKED_ABSOLUTE_MOUSE_GAMES.has(gameSlug.trim().toLowerCase()))
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

/** 复用 js-dos 的同一条指数曲线；《主题医院》的适配器自管路径也不能出现另一套手感。 */
export function dosMouseSpeedMultiplier(value: number): number {
  return Math.pow(8, normalizeDosMouseSensitivity(value) * 2 - 1)
}
