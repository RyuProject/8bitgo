/**
 * Ruffle 的致命异常识别与接管。
 *
 * ActionScript 自己的异常并不等于播放器已经死掉；老游戏经常抛一两条错误后继续运行，
 * 所以这里绝不能把所有 console.error 都升级成红屏。只认 WASM RuntimeError 和 Ruffle/Rust
 * 明确的 panic 标记：这两类一旦出现，时间轴和画布都不会自行恢复，继续显示「运行中」只会
 * 让玩家对着永久黑屏反复点。
 */

const FATAL_TEXT = [
  /ruffle has panicked/i,
  /panicked at/i,
  /webassembly\.runtimeerror/i,
  /memory access out of bounds/i,
  /out of bounds memory access/i,
  /call_indirect.*null table entry/i,
  /table index is out of bounds/i,
  /unreachable executed/i,
] as const

function errorText(value: unknown): { name: string; message: string } {
  if (value && typeof value === 'object') {
    const record = value as { name?: unknown; message?: unknown }
    const name = typeof record.name === 'string' ? record.name : ''
    const message = typeof record.message === 'string' ? record.message : String(value)
    return { name, message }
  }
  return { name: '', message: String(value ?? '') }
}

/**
 * 返回给玩家/日志的短原因；null 表示不是确定性的运行时崩溃。
 * name 单独判断是为了跨 iframe realm：父页面的 instanceof WebAssembly.RuntimeError
 * 对子页面创建出来的异常永远是 false，但标准 name 仍然是 RuntimeError。
 */
export function ruffleFatalDetail(value: unknown): string | null {
  const { name, message } = errorText(value)
  if (name === 'AbortError' || /\baborterror\b/i.test(message)) return null
  const text = `${name}: ${message}`.trim()
  if (name !== 'RuntimeError' && !FATAL_TEXT.some((pattern) => pattern.test(text))) return null
  return (message || name || 'Ruffle runtime crashed').trim().slice(0, 320)
}

interface CrashWindow {
  addEventListener: (type: string, listener: EventListener) => void
  removeEventListener: (type: string, listener: EventListener) => void
  console?: Pick<Console, 'error'>
}

/**
 * 必须装在 ruffle.js 之前，才能覆盖 glue/WASM 初始化阶段；返回的清理函数在换游戏时恢复
 * console.error 并摘掉监听，避免旧会话迟到的 rejection 把新游戏顶成红屏。
 */
export function installRuffleCrashGuard(win: CrashWindow, onFatal: (detail: string) => void): () => void {
  let reported = false
  const report = (value: unknown) => {
    if (reported) return
    const detail = ruffleFatalDetail(value)
    if (!detail) return
    reported = true
    onFatal(detail)
  }

  const onError = ((event: ErrorEvent) => report(event.error ?? event.message)) as EventListener
  const onRejection = ((event: PromiseRejectionEvent) => report(event.reason)) as EventListener
  win.addEventListener('error', onError)
  win.addEventListener('unhandledrejection', onRejection)

  const consoleObject = win.console
  const nativeError = consoleObject?.error
  let wrappedError: Console['error'] | null = null
  if (consoleObject && typeof nativeError === 'function') {
    const candidate: Console['error'] = (...args: unknown[]) => {
      try { report(args.map((arg) => errorText(arg).message).join(' ')) } catch { /* 诊断不能反过来弄挂游戏 */ }
      nativeError.apply(consoleObject, args)
    }
    try {
      consoleObject.error = candidate
      wrappedError = candidate
    } catch {
      // 加固 WebView 可能把 console 方法冻结；事件监听仍能接住 WASM 异常，不能让诊断钩子阻断开局。
    }
  }

  return () => {
    win.removeEventListener('error', onError)
    win.removeEventListener('unhandledrejection', onRejection)
    // 后装的其它补丁不能被我们误删；只有仍是自己那层时才还原。
    try {
      if (consoleObject && wrappedError && consoleObject.error === wrappedError && nativeError) {
        consoleObject.error = nativeError
      }
    } catch { /* 销毁阶段也不能被加固 WebView 的只读属性打断 */ }
  }
}
