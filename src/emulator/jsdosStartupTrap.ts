/** 判断 Windows 客体建立命令接口前是否遇到了不可恢复的 DOSBox-X WASM 陷阱。 */
export function isWindowsGuestStartupWasmTrap(
  event: { message?: unknown; filename?: unknown; error?: unknown },
  fullWindowsGuest: boolean,
  stage: 'ci' | 'boot' | 'desktop' | 'launched',
): boolean {
  if (!fullWindowsGuest || stage !== 'ci') return false
  const error = event.error
  if (!error || typeof error !== 'object' || (error as { name?: unknown }).name !== 'RuntimeError') return false
  if (!/\bRuntimeError:\s*unreachable\b/i.test(String(event.message ?? ''))) return false

  // 有些浏览器不给 filename；给了的话只接受 WASM 来源，避免把普通脚本异常当成模拟器崩溃。
  const filename = String(event.filename ?? '').trim()
  return !filename || /^(?:wasm:|blob:)/i.test(filename) || /(?:^|\/)wasm(?:\/|$)|\.wasm(?:$|[?#])|wasm-function\[/i.test(filename)
}
