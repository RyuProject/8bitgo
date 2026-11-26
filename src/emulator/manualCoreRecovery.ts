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

/** 只有同一局实际解析出的核心才可覆盖启动参数，避免迟到回调污染新会话。 */
export function coreResolvedForSession(
  report: { sessionId: number; core: string } | null,
  sessionId: number,
  fallback: string | undefined,
): string | undefined {
  return report?.sessionId === sessionId ? report.core : fallback
}
