/**
 * 只把确定的 WASM 陷阱当作核心崩溃；下载、BIOS 与普通日志错误不应重启游戏。
 * 已经运行的旧核心也不能再次回到新核心，否则两个核心会无限互换。
 */
export function isNdsWasmCrash(text: string, error?: unknown): boolean {
  const value = error && typeof error === 'object' ? error as { name?: unknown; message?: unknown } : null
  if (value?.name === 'RuntimeError' && typeof value.message === 'string') {
    return /^(?:unreachable|memory access out of bounds)$/i.test(value.message.trim())
  }
  return /\b(?:WebAssembly\.)?RuntimeError:\s*(?:unreachable|memory access out of bounds)\b/i.test(text)
}

/** 只对可原地重开的单机 melonDS DS 会话启用一次旧核心。 */
export function ndsCrashFallbackCore(core: string, restartable: boolean, alreadyFallback: boolean): string | null {
  return core === 'melondsds' && restartable && !alreadyFallback ? 'melonds-compat' : null
}
