/**
 * Dolphin 即时状态与生成它的核心构建严格绑定。
 *
 * 运行时升级后若沿用同一个 slug，工具栏会把旧构建的状态当成当前档读进去；轻则拒绝，
 * 重则在恢复 CPU / GPU 状态时把核心直接打崩。把构建号写进归档键，升级就是开一格新档。
 */
const DOLPHIN_SAVE_MARKER = '~dolphin-'
const MAX_SAVE_SLUG_LENGTH = 160

/** 超长本地文件名要截短，但仍需留一段稳定指纹，避免两个相同前缀的 ROM 共用一份状态。 */
function slugFingerprint(value: string): string {
  let hash = 0x811c9dc5
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0).toString(36)
}

export function dolphinVersionSaveSlug(gameSlug: string, version: string): string {
  const suffix = `${DOLPHIN_SAVE_MARKER}${version}`
  const next = `${gameSlug}${suffix}`
  if (next.length <= MAX_SAVE_SLUG_LENGTH) return next

  /*
    服务端 game_slug 只有 160 字符。不能像普通截断那样直接丢掉构建号：那会让核心升级后
    重新撞上旧状态；也不能只取文件名前缀：两个长文件名可能前 140 个字符完全相同。
    留下完整构建号 + 原 slug 指纹，极端长文件名仍能安全归档，只是个人页只能显示截短名。
  */
  const fingerprint = `~${slugFingerprint(gameSlug)}`
  const baseLength = Math.max(1, MAX_SAVE_SLUG_LENGTH - suffix.length - fingerprint.length)
  return `${gameSlug.slice(0, baseLength)}${fingerprint}${suffix}`
}

/** 个人页要用基础 slug 查游戏标题；只在 runtime 已经确认是 dolphin 时调用。 */
export function parseDolphinVersionSaveSlug(value: string): { gameSlug: string; version?: string } {
  const markerAt = value.lastIndexOf(DOLPHIN_SAVE_MARKER)
  if (markerAt <= 0) return { gameSlug: value }
  const version = value.slice(markerAt + DOLPHIN_SAVE_MARKER.length)
  if (!/^[a-z0-9._-]{1,32}$/i.test(version)) return { gameSlug: value }
  return { gameSlug: value.slice(0, markerAt), version }
}
