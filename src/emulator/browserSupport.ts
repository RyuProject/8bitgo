/**
 * 浏览器够不够新，跑不跑得动各个模拟器运行时。
 *
 * 页面本身覆盖得很低：Vite legacy 包按 Chrome 64 / Safari 12 / Firefox 67 转译，不支持 `import.meta.resolve`
 * 的浏览器会自动改走它（2026-11-15 用 Chromium 强制走 legacy 包实测：《拳皇97》详情页正常渲染、能开局）。
 * 但模拟器运行时不经过 Vite，是第三方预编译产物，原样发布，2026-11-15 用 acorn 逐个取证的最低语法：
 *
 *   EmulatorJS 引擎 emulator.min.js     ES2020（`?.`、`??`，动态 import 的 ES 模块）
 *   EmulatorJS 各核心胶水 *_libretro.js   ES2022（公有类字段）+ `?.` / `??`
 *   binjgb.js / js-dos emulators.js        ES2022
 *   Ruffle ruffle.js                       ES2021
 *
 * 合起来下限是 Chrome 80、Safari 14、Firefox 74。更老的浏览器（Android 旧 WebView、iOS 12–13、
 * 内核较老的应用内浏览器）页面打得开，点开始后却在 iframe / Worker 里静默语法错误，只剩看门狗超时。
 * 转译这些产物不现实（核心胶水封在 7z 包里、随核心一起更新），所以：
 *   - NES 改走 jsnes（随 Vite 打包，legacy 包里已经转译过），照常能玩；
 *   - 其它运行时开局前直接说清楚「浏览器太旧，请更新」，不去下载几十 MB 再失败。
 */
import type { RuntimeId } from './types'

/** 随站点代码一起经 Vite 转译、在 legacy 包里也能跑的运行时 */
const LEGACY_SAFE_RUNTIMES: ReadonlySet<RuntimeId> = new Set<RuntimeId>(['jsnes', 'liveview', 'cloudgame', 'html5'])

export function runtimeNeedsModernBrowser(id: RuntimeId): boolean {
  return !LEGACY_SAFE_RUNTIMES.has(id)
}

let cached: boolean | undefined

/**
 * 这个浏览器能不能解析运行时用到的最新语法（类字段 + `?.` + `??`）。
 * 只有 SyntaxError 才算不支持：站点若被 CSP 禁了 eval，`new Function` 抛的是 EvalError，
 * 那说明不了语法能力，按「支持」处理，不能因此把所有玩家都挡在门外。
 */
export function modernRuntimeSyntaxSupported(
  compile: (src: string) => unknown = (src) => new Function(src),
): boolean {
  if (cached !== undefined) return cached
  try {
    compile('class A{x=1};var o={a:{b:1}};return o.a?.b??new A().x')
    cached = true
  } catch (error) {
    cached = !(error instanceof SyntaxError)
  }
  return cached
}

/** 测试用：清掉缓存的探测结论 */
export function resetBrowserSupportProbe(): void {
  cached = undefined
}
