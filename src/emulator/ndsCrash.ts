/**
 * 只把明确的 WASM 运行时陷阱当成核心崩溃。
 * 普通游戏日志、缺 BIOS 提示和可恢复的 JS 异常都不能触发换核心；误切会丢掉当前进度。
 */
export function isNdsWasmCrash(text: string, error?: unknown): boolean {
  const value = error && typeof error === 'object' ? error as { name?: unknown; message?: unknown } : null
  if (value?.name === 'RuntimeError' && typeof value.message === 'string') {
    return /^(?:unreachable|memory access out of bounds)$/i.test(value.message.trim())
  }
  return /\b(?:WebAssembly\.)?RuntimeError:\s*(?:unreachable|memory access out of bounds)\b/i.test(text)
}

/** 已经确定不能恢复的 melonDS DS 才换到旧核心，且每局最多切一次。 */
export function ndsCrashFallbackCore(core: string, restartable: boolean, alreadyFallback: boolean): string | null {
  return core === 'melondsds' && restartable && !alreadyFallback ? 'melonds-compat' : null
}
