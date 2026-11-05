/** js-dos 的 0~1 滑块中点正好是 1×；两端按上游公式对应 0.125× 与 8×。 */
export const DOS_MOUSE_SENSITIVITY_DEFAULT = 0.5

/**
 * js-dos 的 Pointer Lock 默认把浏览器位移作为相对包发给 DOSBox，适合 FPS，也适合多数 DOS 游戏。
 * 这里只收「读 INT 33h 绝对位置（03h / 回调里的 CX、DX）」且已实测对齐的游戏，避免把毁灭战士等
 * 需要无限转向的游戏也改成有边界的光标。
 *
 * ⚠️《主题医院》**不能**放进来（2026-11-05 用 INT 33h 记录 TSR 实测）：它只注册 0Ch 事件回调，
 * 拿 SI/DI 的累计 mickey 相减当位移，完全不读位置。绝对桥在浏览器侧把指针钳在 0～1，游戏光标
 * 和指针一旦错位（进菜单时游戏会把光标放回屏幕中央），钳住的那一侧就再也送不出位移，屏幕一块
 * 区域点不到。它当初被移进这里，是因为 js-dos 的回调把 SI/DI 错给成增量、相对路径光标乱跳；
 * 那个根因已由 copy-jsdos.mjs 的 INT74 累计 mickey 补丁修掉，走原生相对 + Pointer Lock 即可。
 */
const LOCKED_ABSOLUTE_MOUSE_GAMES = new Set([
  /*
    《大富翁3》全程点选菜单与棋盘。PLAY.BAT 里的 MOUSE.COM 已由 dosBatchCompat 跳过、改用 DOSBox
    内置 INT 33h 驱动后，绝对坐标在 2026-11-05 实测逐像素对齐；相对路径在指针未锁定时光标会漂。
  */
  'rich-man-3',
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

/** 复用 js-dos 的同一条指数曲线；绝对坐标游戏的适配器自管路径也不能出现另一套手感。 */
export function dosMouseSpeedMultiplier(value: number): number {
  return Math.pow(8, normalizeDosMouseSensitivity(value) * 2 - 1)
}
