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
