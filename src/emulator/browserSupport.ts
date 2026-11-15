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
const LEGACY_SAFE_RUNTIMES: ReadonlySet<RuntimeId> = new Set<RuntimeId>(['jsnes', 'iodinegba', 'liveview', 'cloudgame', 'html5'])

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

/**
 * 浏览器有没有 WebAssembly。
 *
 * 不只是老浏览器：Edge 的「增强安全性」、iOS 锁定模式、关了 JIT 的安卓模拟器 / 精简浏览器都会把它整个拿掉
 * （2026-11-15 Android 模拟器 Chrome 110：`ReferenceError: WebAssembly is not defined`）。
 * 所有模拟器核心都是 WebAssembly，只有 jsnes 是纯 JS（8BG 解压没有 WebAssembly 时改用纯 JS 的 fzstd）。
 */
export function webAssemblyAvailable(): boolean {
  return typeof WebAssembly === 'object' && WebAssembly !== null && typeof WebAssembly.instantiate === 'function'
}

/**
 * 这一局在没有 WebAssembly 的浏览器里起得来吗。
 * jsnes 是纯 JS；8BG 外壳在没有 WebAssembly 时改用纯 JS 的 fzstd 解压（romPack.ts），所以本站的 NES 游戏照样能玩。
 * GB/GBC 的 binjgb 没有 WebAssembly 时自动换成它的纯 JavaScript 构建（public/binjgb/binjgb-js.js）；
 * GBA 没有 WebAssembly 时使用 IodineGBA 纯 JavaScript 核心（没绑官方 BIOS 时用随站的开源替代 BIOS）。
 * 直播观看、云游戏只收视频，不需要。
 * 其余核心（EmulatorJS、js-dos、Ruffle …）本身就是 WebAssembly；Flash 仅验证名单中的游戏可由 AwayFL 回退。
 */
export function runtimeRunsWithoutWasm(id: RuntimeId, _game?: File | string): boolean {
  // 网页游戏各有各的实现，纯 JS 的不少：让它自己试，别一刀切挡住
  return id === 'jsnes' || id === 'binjgb' || id === 'iodinegba' || id === 'awayfl' || id === 'liveview' || id === 'cloudgame' || id === 'html5'
}
