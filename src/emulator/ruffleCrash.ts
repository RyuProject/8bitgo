/**
 * Ruffle 的致命异常识别与接管。
 *
 * ActionScript 自己的普通异常并不等于播放器已经死掉；老游戏经常抛一两条错误后继续运行，
 * 所以这里绝不能把所有 console.error 都升级成红屏。只认 WASM RuntimeError、Ruffle/Rust
 * 明确的 panic，以及 Ruffle 已终止脚本的超时标记：这些故障都不会自行恢复，继续显示「运行中」
 * 只会让玩家对着永久黑屏反复点。
 */

const FATAL_TEXT = [
  /ruffle has panicked/i,
  /panicked at/i,
  /webassembly\.runtimeerror/i,
  /\bRuntimeError\b/i,
  /memory access out of bounds/i,
  /out of bounds memory access/i,
  /call_indirect.*null table entry/i,
  /table index is out of bounds/i,
  /unreachable executed/i,
  /a script in this movie has taken too long to execute and has been terminated/i,
] as const

const SCRIPT_TIMEOUT = /a script in this movie has taken too long to execute and has been terminated/i

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
  if (SCRIPT_TIMEOUT.test(text)) return 'A script in this movie has taken too long to execute and has been terminated.'
  return (message || name || 'Ruffle runtime crashed').trim().slice(0, 320)
}

interface CrashWindow {
  addEventListener: (type: string, listener: EventListener) => void
  removeEventListener: (type: string, listener: EventListener) => void
  console?: Pick<Console, 'error' | 'log'>
}

/**
 * 必须装在 ruffle.js 之前，才能覆盖 glue/WASM 初始化阶段；返回的清理函数在换游戏时恢复
 * console.error / console.log 并摘掉监听，避免 Ruffle 的带样式日志绕过守卫或旧会话迟到的 rejection 顶掉新游戏。
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
  const nativeLog = consoleObject?.log
  let wrappedError: Console['error'] | null = null
  let wrappedLog: Console['log'] | null = null
  const inspectLog = (args: unknown[]) => {
    try {
      for (const arg of args) {
        report(arg)
        if (reported) break
      }
      // Ruffle 的错误日志会把 RustError 和脚本超时文本合在带颜色的 console.log 参数里。
      if (!reported) report(args.map((arg) => errorText(arg).message).join(' '))
    } catch { /* 诊断不能反过来弄挂游戏 */ }
  }
  if (consoleObject && typeof nativeError === 'function') {
    const candidate: Console['error'] = (...args: unknown[]) => {
      try {
        // 保留异常对象本身：压成 message 会丢掉 RuntimeError 类型，某些 WASM trap 只写
        // `unreachable`，既不含 panic 文本也不含 WebAssembly 前缀，黑屏后就会漏报。
        for (const arg of args) {
          report(arg)
          if (reported) break
        }
        // Ruffle 有时把错误类型放在前一个参数、panic 细节放在后一个参数；逐个检查后
        // 再检查组合文本，仍然只会由 report 的一次性闸门上报一回。
        if (!reported) report(args.map((arg) => errorText(arg).message).join(' '))
      } catch { /* 诊断不能反过来弄挂游戏 */ }
      nativeError.apply(consoleObject, args)
    }
    try {
      consoleObject.error = candidate
      wrappedError = candidate
    } catch {
      // 加固 WebView 可能把 console 方法冻结；事件监听仍能接住 WASM 异常，不能让诊断钩子阻断开局。
    }
  }
  if (consoleObject && typeof nativeLog === 'function') {
    const candidate: Console['log'] = (...args: unknown[]) => {
      inspectLog(args)
      nativeLog.apply(consoleObject, args)
    }
    try {
      consoleObject.log = candidate
      wrappedLog = candidate
    } catch {
      // Ruffle 版本会把脚本终止原因输出到 log；冻结的 console 仍由 error/rejection 事件兜底。
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
      if (consoleObject && wrappedLog && consoleObject.log === wrappedLog && nativeLog) {
        consoleObject.log = nativeLog
      }
    } catch { /* 销毁阶段也不能被加固 WebView 的只读属性打断 */ }
  }
}
