/**
 * EmulatorJS 引擎自带的「离开页面就退出」要拦下来（2026-11-21 诊断包 #2744，《黄金太阳》mGBA）。
 *
 * 现场：开局 96 秒出画面、玩了十几分钟，第 913 秒控制台先打 `Aborted(undefined)`，紧接着
 * `console.warn(RuntimeError: Aborted(undefined)…)`，适配器按核心崩溃上报。这两行不是 mGBA 崩了，
 * 而是引擎自己的退出流程（emulator.min.js 里 GameManager 构造时注册的 `EJS.on("exit")`）：
 *
 *     saveSaveFiles() → restart() → saveSaveFiles() → toggleMainLoop(0)
 *     → setTimeout(() => { try { Module.abort() } catch (t) { console.warn(t) } }, 1000)
 *
 * `Module.abort()` 不带参数，所以原文是 `Aborted(undefined)`；核心自己的 C abort() 走 `__abort_js`
 * 打的是 `Aborted()`（空串），两者能分开。而 exit 由 **iframe 的 beforeunload** 触发
 *（`this.started && this.callEvent("exit")`）—— 顶层页面开始导航（点了别的链接、刷新、点了会触发下载
 * 的链接、外部协议链接）时，子框架也会收到 beforeunload。弱网下旧页面在 1 秒后还活着，abort 就被当成
 * 「运行中崩溃」报上来；导航被取消 / 实际是下载时页面根本不走，游戏却已经停了主循环、重置、abort，
 * 玩家对着一块死画面。
 *
 * 处理：
 *   1. loader.js 之前在 iframe window 上抢先挂一个捕获阶段的 beforeunload，`stopImmediatePropagation`
 *      不让引擎的监听收到，改由我们自己刷一次电池存档（页面真的要走，pagehide 时还会再刷一次）。
 *      不 preventDefault，不会弹「确定离开」。
 *   2. 引擎的 exit 仍可能由别的路走到（菜单里的退出按钮、startGame 失败）。适配器在 `EJS.on('exit')`
 *      上记时间：之后几秒内出现的 `Aborted(undefined)` 是计划内的退出，不是核心崩溃。
 */

/** exit 之后这么久之内的 Aborted(undefined) 视为退出流程（引擎是 1 秒后 abort，留余量） */
export const ENGINE_EXIT_ABORT_WINDOW_MS = 10_000

/** 引擎退出流程 `Module.abort()`（不带参数）的原文；核心自己的 abort 是 `Aborted()` */
export function isEngineExitAbortText(text: string): boolean {
  return /Aborted\(undefined\)/.test(text)
}

/** 这句 abort 是不是刚才那次 exit 的收尾 */
export function isPlannedEngineExitAbort(text: string, exitAt: number, now: number): boolean {
  return exitAt > 0 && now >= exitAt && now - exitAt <= ENGINE_EXIT_ABORT_WINDOW_MS && isEngineExitAbortText(text)
}

/**
 * 在引擎之前挂上 beforeunload 拦截。必须在 loader.js 执行前调用：同一目标上、捕获阶段、
 * 先注册的监听先跑，stopImmediatePropagation 才挡得住引擎后注册的那条。
 * 返回卸载函数。
 */
export function guardEngineAutoUnload(
  win: Pick<Window, 'addEventListener' | 'removeEventListener'>,
  onBeforeUnload: () => void,
): () => void {
  const handler = (event: Event) => {
    event.stopImmediatePropagation()
    try {
      onBeforeUnload()
    } catch {
      /* 刷存档失败也不能让离开页面卡住 */
    }
  }
  win.addEventListener('beforeunload', handler, { capture: true })
  return () => {
    try {
      win.removeEventListener('beforeunload', handler, { capture: true })
    } catch {
      /* iframe 可能已经不可访问 */
    }
  }
}
