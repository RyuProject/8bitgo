/**
 * 引擎 iframe 里**我们自己的**经典脚本在开局前就解析失败：整份脚本一行都没执行，引擎不会再有任何进展。
 *
 * 2026-11-19 诊断包 #1331 / #1334 / #1343（《1942》，Chrome 111 / Windows 与 Chrome 156 / macOS）：
 * 点开始 0.4～2 秒就在引擎 iframe 里报 `Uncaught SyntaxError: Identifier 'debug' has already been declared`
 * —— 页面里先有一个全局 `debug`（推测是扩展往每个框架注入的），旧 loader.js 顶层的 `const debug` 撞上，整份 loader 不执行。
 * 根因已由 loader.js 整份包进立即执行函数修掉（4b46d14，AGENTS.md §2.7.2 第 5.1 条）。但这一句以前只进日志：
 * 适配器等满 120 秒看门狗才判「卡在 fbneo」，播放器自动重试又撞同一句、再等 120 秒，玩家白等 4 分钟。
 *
 * 这里认出「开局前、来自本站引擎脚本的 SyntaxError」，让适配器当场失败：
 *   - 重复声明（别的脚本先占了同一个全局名）→ 这台浏览器的环境问题，重试多少遍都一样：提示停用扩展 / 换无痕窗口，不自动重试；
 *   - 其它语法错误（文件坏了、被截断）→ 引擎设施故障，照旧走一次原地重试（换线路）。
 * 只认引擎自己的脚本：`/emulatorjs/` 下的文件（主站与大陆加速入口 `/_cn/emulatorjs/`）和本站源下的 blob（核心的 Emscripten 胶水
 * 是引擎用 blob 地址插进来的经典脚本）。扩展自己的脚本、第三方脚本报错不算。
 * ⚠️ 跨源又没带 crossorigin 的经典脚本（大陆加速入口上的 loader.js）报错会被浏览器抹成「Script error.」、没有文件名，认不出 ——
 * 那种情况照旧靠看门狗。
 */

export interface EngineScriptError {
  /** 出错的脚本地址 */
  file: string
  /** 错误原文（去掉 Uncaught 前缀） */
  message: string
  /** 重复声明的全局名；不是重复声明时为 null */
  redeclared: string | null
}

/** 各家浏览器「全局名重复声明」的措辞 */
const REDECLARATION: readonly RegExp[] = [
  // Chrome / Edge：Identifier 'debug' has already been declared
  /Identifier '([^']+)' has already been declared/,
  // Firefox：redeclaration of let debug / redeclaration of var debug
  /redeclaration of (?:let|const|var|class|function)\s+([\w$]+)/i,
  // Safari：Can't create duplicate variable: 'debug' / … that shadows a global property: 'debug'
  /Can't create duplicate (?:variable|global variable)[^']*'([^']+)'/,
  // Safari：Cannot declare a let variable twice: 'debug'
  /Cannot declare a (?:let|const|class) variable twice: '([^']+)'/,
]

function isEngineScript(file: string, pageOrigin: string): boolean {
  if (!file) return false
  try {
    const url = new URL(file)
    if (url.protocol === 'blob:') return Boolean(pageOrigin) && file.startsWith(`blob:${pageOrigin}/`)
    return /\/emulatorjs\//.test(url.pathname)
  } catch {
    return false
  }
}

/** 一条 window `error` 事件是不是本站引擎脚本的语法错误；是就给出文件、原文和（若是重复声明）全局名 */
export function engineScriptSyntaxError(
  event: { message?: unknown; filename?: unknown; error?: unknown },
  pageOrigin: string,
): EngineScriptError | null {
  const error = event.error && typeof event.error === 'object' ? event.error as { name?: unknown; message?: unknown } : null
  const raw = String(event.message ?? '')
  // 鸭子类型：SyntaxError 来自 iframe 的 realm，外层的 instanceof 永远为假
  const syntax = error?.name === 'SyntaxError' || /^(?:Uncaught\s+)?SyntaxError\b/.test(raw)
  if (!syntax) return null
  const file = String(event.filename ?? '')
  if (!isEngineScript(file, pageOrigin)) return null
  const message = String(typeof error?.message === 'string' && error.message ? `SyntaxError: ${error.message}` : raw)
    .replace(/^Uncaught\s+/, '').slice(0, 300)
  let redeclared: string | null = null
  for (const pattern of REDECLARATION) {
    const hit = pattern.exec(message)
    if (hit) {
      redeclared = hit[1].slice(0, 60)
      break
    }
  }
  return { file, message, redeclared }
}

/** 日志里只留文件名（不带查询串） */
export function engineScriptName(file: string): string {
  if (file.startsWith('blob:')) return '核心胶水（blob）'
  return file.split(/[?#]/)[0].split('/').pop() || file
}
