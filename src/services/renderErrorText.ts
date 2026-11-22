/**
 * 页面渲染崩溃（AppErrorBoundary）的错误文字整理。纯函数，单独成文件是为了脚本测试能直接 import。
 */

/**
 * 错误原文。React 生产包的报错带一长串固定套话（「visit … for the full message or use the non-minified dev
 * environment …」，约 170 字），把它压成一句：漏斗事件的摘要只留 160 字、诊断包原因只留 600 字，
 * 2026-11-17 / 11-20 两份「React 页面更新循环」（#185）的摘要全被套话占满，组件栈一个字都没进库，查不出是哪个组件在循环。
 * 保留「Minified React error #N」这几个字：服务端按它归类（server/src/startup-diagnostics.js）。
 */
export function errorHead(error: unknown): string {
  const head = error instanceof Error ? `${error.name}: ${error.message}` : String(error)
  return head
    .replace(/(Minified React error #\d+);[\s\S]*?(?:helpful warnings\.|$)/i, '$1')
    .slice(0, 400)
}

/** 调用栈前几帧（Chrome 的 `at …` 与 Safari / Firefox 的 `fn@url` 两种写法） */
export function stackFrames(error: unknown, limit = 4): string[] {
  return error instanceof Error && typeof error.stack === 'string'
    ? error.stack
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.startsWith('at ') || line.includes('@'))
      .slice(0, limit)
      .map((frame) => frame.slice(0, 200))
    : []
}

/** React 更新循环（#185 最大更新深度 / #301 渲染中反复 setState）：组件栈才是线索，调用栈全是 react-dom 内部 */
export function isReactUpdateLoop(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return /Minified React error #(?:185|301)\b|Maximum update depth exceeded|Too many re-renders/i.test(message)
}

/** 组件栈的前几层，用「<」连起来（最内层在前） */
export function componentPath(componentStack: string | null | undefined, limit: number): string {
  return String(componentStack ?? '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, limit)
    .join(' < ')
}
