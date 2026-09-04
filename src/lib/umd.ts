/**
 * 把一个 UMD 的经典脚本安全地取进来 —— 不碰页面全局。
 *
 * ── 为什么需要这个 ─────────────────────────────────────────
 * UMD 的头长这样（socket.io 的原文）：
 *
 *   typeof exports === 'object' && typeof module !== 'undefined' ? module.exports = factory() :
 *   typeof define === 'function' && define.amd ? define(factory) :
 *   (global.io = factory());
 *
 * 也就是说，**页面上只要有任何一个脚本占了 define / module / exports 这三个名字**，
 * 第三支就轮不到，`window.io` 永远是空的 —— 而 `<script>` 的 onload 照样触发，
 * 表面上是「装好了却没暴露 io()」，查起来毫无头绪。
 *
 * 这个仓库已经被全局名字坑过两次了（另一次是 js-dos 泄漏 `io` 顶掉 socket.io，
 * 见项目记忆 [js-dos 泄漏全局 io]），所以干脆不走全局：取源码，
 * 拿 `new Function` 把 `module` / `exports` 作为**形参**喂进去，逼它走第一支。
 *
 * 这个文件刻意零依赖（不 import 任何东西）—— `services/live.ts` 拉着 React、
 * import.meta.env 一大串，测试脚本没法直接 import 它。放这儿才跑得起
 * `npm run test:live-io`。
 */

/**
 * 把一段 UMD 源码当 CommonJS 模块跑一遍，返回它的 `module.exports`。
 *
 * `module` / `exports` 是 `new Function` 的形参，只在这段代码里可见，
 * 全局一个字节都不动。脚本内部读 window / document / globalThis 照旧 ——
 * 我们只遮了这两个名字，没有做沙箱。
 *
 * ⚠️ 需要 `unsafe-eval`。本站没设 CSP；真加了限制，调用方要有退路。
 */
export function runAsCommonJs(src: string): unknown {
  const shim: { exports: unknown } = { exports: {} }
  new Function('module', 'exports', src)(shim, shim.exports)
  return shim.exports
}

/**
 * 这个值到底是不是 socket.io 的 io()。
 *
 * 不能只看有没有值、是不是函数：页面上任何一个**没包 IIFE 的**经典脚本，
 * 它的顶层函数声明都会变成 window 的属性。`public/jsdos/js-dos.js` 就是这种，
 * 它把 immer 的 `each()` 以 **`io`** 这个名字泄漏到全局。拿它当 socket.io 用，
 * 得到的是 `TypeError: Reflect.ownKeys called on non-object`。
 *
 * socket.io 的客户端会在 io 上挂 Manager / Socket / connect，认这个靠谱得多。
 */
export function looksLikeSocketIo(v: unknown): boolean {
  if (typeof v !== 'function') return false
  const f = v as { Manager?: unknown; Socket?: unknown; connect?: unknown }
  return typeof f.Manager === 'function' || typeof f.Socket === 'function' || typeof f.connect === 'function'
}

/** 拿到的东西不对时，把「到底拿到了啥」说清楚 —— 光说「没暴露 io()」查不下去 */
export function describeExport(v: unknown): string {
  if (typeof v !== 'function') return `拿到的是 ${v === null ? 'null' : typeof v}`
  const own = Object.keys(v as object)
  return `拿到的是个函数，但没有 Manager / Socket / connect（自有属性：${own.join(', ') || '无'}）`
}

/**
 * UMD 那三支各自的门在页面上是开是关。
 * 报错里带上这一句，一眼就能看出是不是被别的脚本抢了 define / module / exports。
 */
export function umdGlobals(): string {
  if (typeof window === 'undefined') return '（非浏览器环境）'
  const w = window as unknown as { define?: unknown; module?: unknown; exports?: unknown }
  // 单独取出来再看 .amd —— 直接在 typeof 收窄后的分支里读，TS 会把它收成 never
  const amd = typeof w.define === 'function' && (w.define as { amd?: unknown }).amd ? '(amd)' : ''
  return `页面全局 define=${typeof w.define}${amd} module=${typeof w.module} exports=${typeof w.exports}`
}
