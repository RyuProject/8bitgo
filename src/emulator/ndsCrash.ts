/**
 * 只把明确的 WASM 运行时陷阱当成核心崩溃。
 * 普通游戏日志、缺 BIOS 提示和可恢复的 JS 异常都不能触发换核心；误切会丢掉当前进度。
 *
 * ⚠️ 陷阱不止 `unreachable` / 越界两种。melonDS DS 一旦调到空函数指针或签名不符的指针，V8 报
 * `null function`（旧版是 `null function or function signature mismatch`），Firefox 报
 * `indirect call to null`，Safari 报 `call_indirect to a null table entry`。以前只认前两种，
 * 这类崩溃会掉进普通 onError：先原地重试、再把各语言 ROM 挨个判坏重下，弱网下等很久却始终
 * 不切旧 melonDS。WASM 陷阱发生后运行时不可恢复，和是哪种陷阱无关；三大引擎的措辞都列在这里。
 * Emscripten 的 `abort()` 也抛 RuntimeError（`Aborted(...)`），同样意味着这个 WASM 实例已死。
 */
const WASM_TRAP_MESSAGE = new RegExp(
  '^(?:' + [
    'unreachable', // V8；Firefox「unreachable executed」；Safari「Unreachable code should not be executed」
    'memory access out of bounds',
    'out of bounds memory access',
    'index out of bounds', // Firefox 的内存 / 表越界
    'null function', // V8 新旧两种措辞都以此开头
    'function signature mismatch',
    'table index is out of bounds',
    'indirect call to null',
    'indirect call signature mismatch',
    'call_indirect to a null table entry',
    'call_indirect to a signature that does not match',
    'out of bounds call_indirect',
    '(?:integer )?divide by zero',
    'division by zero',
    'remainder by zero',
    'integer overflow',
    'float unrepresentable in integer range',
    'invalid conversion to integer',
    'out of bounds trunc',
    'aborted\\(',
  ].join('|') + ')',
  'i',
)

export function isNdsWasmCrash(text: string, error?: unknown): boolean {
  const value = error && typeof error === 'object' ? error as { name?: unknown; message?: unknown } : null
  if (value?.name === 'RuntimeError' && typeof value.message === 'string') {
    return WASM_TRAP_MESSAGE.test(value.message.trim())
  }
  const hit = /\b(?:WebAssembly\.)?RuntimeError:\s*([^\n]*)/i.exec(text)
  return Boolean(hit && WASM_TRAP_MESSAGE.test(hit[1].trim()))
}

/** 已经确定不能恢复的 melonDS DS 才换到旧核心，且每局最多切一次。 */
export function ndsCrashFallbackCore(core: string, restartable: boolean, alreadyFallback: boolean): string | null {
  return core === 'melondsds' && restartable && !alreadyFallback ? 'melonds-compat' : null
}
