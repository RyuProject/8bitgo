export type ManualCoreRecoveryCause = 'core' | 'runtime' | 'content' | 'deterministic' | 'network' | 'config'

/** 找下一个尚未试过的核心；按当前核心真正映射到的目录名去重，避免 `psx` 与 `pcsx_rearmed` 被当成两颗。 */
export function nextManualCoreOption(
  options: readonly { id: string }[],
  attempted: readonly string[],
  resolveCore: (id: string) => string | undefined = (id) => id,
): string | null {
  const tried = new Set(attempted)
  return options.find(({ id }) => {
    const resolved = resolveCore(id) ?? id
    return !tried.has(id) && !tried.has(resolved)
  })?.id ?? null
}

/**
 * 确定性内容错误通常不能靠换核心修复；街机未知驱动是例外，同一 ROM 可能只被另一个街机核心收录。
 * MAME 专属识别结果仍由调用方的 fallbackAllowed=false 关闭，不能给玩家推荐必然不兼容的核心。
 */
export function canTryManualCoreRecovery(
  runtime: string,
  platform: string,
  cause: ManualCoreRecoveryCause,
  fallbackAllowed: boolean | undefined,
): boolean {
  if (runtime !== 'emulatorjs' || fallbackAllowed === false) return false
  if (cause === 'core' || cause === 'content') return true
  return cause === 'deterministic' && platform === 'arcade'
}

/** 街机未知驱动时，低内存 FBNeo 不增加驱动覆盖；同一 FBNeo 家族试过后也不再互相推荐。 */
export function manualCoreOptionsForFailure<T extends { id: string }>(
  options: readonly T[],
  platform: string,
  cause: ManualCoreRecoveryCause,
  attempted: readonly string[],
): T[] {
  if (platform !== 'arcade' || cause !== 'deterministic') return [...options]
  const triedFbneoFamily = attempted.some((id) => id === 'fbneo' || id === 'fbneo-lowmem')
  return options.filter((option) =>
    option.id !== 'fbneo-lowmem' && !(triedFbneoFamily && option.id === 'fbneo'),
  )
}

/** 只有同一局实际解析出的核心才可覆盖启动参数，避免迟到回调污染新会话。 */
export function coreResolvedForSession(
  report: { sessionId: number; core: string; manualFallbackAllowed?: boolean } | null,
  sessionId: number,
  fallback: string | undefined,
): string | undefined {
  return report?.sessionId === sessionId ? report.core : fallback
}

/** 只有同一局的识别结论能禁止手动换核；旧 ROM 的迟到回调不能关闭新局的兜底入口。 */
export function manualFallbackAllowedForSession(
  report: { sessionId: number; manualFallbackAllowed?: boolean } | null,
  sessionId: number,
  fallback: boolean | undefined,
): boolean {
  return fallback !== false && !(report?.sessionId === sessionId && report.manualFallbackAllowed === false)
}
