/**
 * IM 的**接缝**。现在这里没有任何通信逻辑 —— 它存在的意义是把「顶栏那颗按钮」
 * 和「将来真正的 IM 实现」彻底解耦：顶栏只认这个模块，不认 socket、不认协议、
 * 不认消息结构。真接 IM 的时候只往下面两个口子里插，顶栏一行都不用改。
 *
 * **零 import**，和 services/hotkeys.ts、services/padKeys.ts 同一个理由：
 * 以后要在 node 里测未读数的合并逻辑，直接 import 就行，不需要浏览器。
 *
 * ## 两个口子
 *
 * 1. `registerImOpener(fn)` —— IM 面板挂载时把「怎么打开我」交上来。
 *    没人注册时 `openIm()` 返回 false，顶栏据此显示一个「即将上线」的占位面板，
 *    而不是给一颗点了没反应的按钮（那比没有更糟）。
 * 2. `setImUnread(n)` —— IM 那边收到新消息就报个数，顶栏的红点自己会跟上。
 *    刻意做成「报总数」而不是「+1」：断线重连之后客户端本地的累加值一定是错的，
 *    唯一可靠的做法是让服务端告诉你现在到底有几条未读。
 */

/** 红点上最多显示到几，再多就是 99+。IM 里未读上千是常态，全写出来会把按钮撑坏 */
export const IM_UNREAD_CAP = 99

/* ---------------- 打开面板 ---------------- */

type ImOpener = () => void

let opener: ImOpener | null = null

/**
 * IM 面板注册「怎么打开我」。返回注销函数。
 *
 * 后注册的覆盖先注册的，注销时只有「当前这个就是我」才真的清掉 ——
 * React 严格模式下 effect 会跑两遍（挂、卸、再挂），不判一下会把新的那次注销掉，
 * 表现是开发模式下按钮突然又变回占位面板。
 */
export function registerImOpener(fn: ImOpener): () => void {
  opener = fn
  return () => {
    if (opener === fn) opener = null
  }
}

/** IM 到底接上了没有。顶栏用它决定是打开面板还是显示占位 */
export function imReady(): boolean {
  return opener !== null
}

/** 打开 IM。返回 false = 还没接上，调用方自己兜底 */
export function openIm(): boolean {
  if (!opener) return false
  try {
    opener()
  } catch {
    // IM 那边炸了不该让顶栏跟着白屏
    return false
  }
  return true
}

/* ---------------- 未读数 ---------------- */

let unread = 0
const listeners = new Set<() => void>()

/** 订阅未读数变化。返回退订函数 */
export function onImChange(fn: () => void): () => void {
  listeners.add(fn)
  return () => {
    listeners.delete(fn)
  }
}

export function getImUnread(): number {
  return unread
}

/**
 * 报当前未读**总数**（不是增量）。非法值一律当 0，别让一个 NaN 把红点变成「NaN」。
 */
export function setImUnread(next: number): void {
  const n = Number.isFinite(next) ? Math.max(0, Math.floor(next)) : 0
  if (n === unread) return
  unread = n
  // 拷一份再遍历：监听者在回调里退订是常事（React 的 cleanup 就会）
  for (const fn of [...listeners]) {
    try {
      fn()
    } catch {
      /* 一个监听者炸了不该连累其他人 */
    }
  }
}

/** 红点上显示的文字。0 返回空串（调用方据此决定不画） */
export function imUnreadLabel(n: number = unread): string {
  if (n <= 0) return ''
  return n > IM_UNREAD_CAP ? `${IM_UNREAD_CAP}+` : String(n)
}
