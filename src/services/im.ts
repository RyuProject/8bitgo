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

/* ---------------- 新消息预览（顶栏气泡上的走马灯） ---------------- */

/** 预览里最多带多少字。一条 2000 字的消息不该产出一个两分钟的走马灯 */
export const IM_PREVIEW_MAX = 140

export interface ImPreview {
  /**
   * 递增序号。**这是给 React 当 key 用的，不是装饰。**
   *
   * 连着收到两条一样的「哈喽」时，nick 和 text 都没变，React 会复用同一个节点 ——
   * CSS 动画不会重新播，用户看不出来有新消息。序号变了才会重挂、动画才会重头跑。
   */
  seq: number
  /** 发件人昵称。解析不出来时是空串，调用方自己兜底文案 */
  nick: string
  text: string
}

let previewSeq = 0
const previewListeners = new Set<(p: ImPreview) => void>()

/** 订阅新消息预览。返回退订函数 */
export function onImPreview(fn: (p: ImPreview) => void): () => void {
  previewListeners.add(fn)
  return () => {
    previewListeners.delete(fn)
  }
}

/**
 * 广播一条新消息预览。
 *
 * **不留状态**：这是个事件，不是可读取的当前值。存下来的话，用户切个页面
 * 顶栏重挂就会把几分钟前那条消息又滚一遍 —— 那不是通知，是骚扰。
 * 没有监听者时（顶栏不在，比如沉浸模式）这一条就是丢掉，也是对的。
 *
 * 空文本直接忽略：非文字消息 messageForShow 可能是空的，滚一条空白毫无意义。
 */
export function pushImPreview(input: { nick?: string; text?: string }): void {
  const text = String(input.text ?? '').replace(/\s+/g, ' ').trim().slice(0, IM_PREVIEW_MAX)
  if (!text) return
  previewSeq += 1
  const p: ImPreview = { seq: previewSeq, nick: String(input.nick ?? '').trim(), text }
  // 拷一份再遍历，同 setImUnread
  for (const fn of [...previewListeners]) {
    try {
      fn(p)
    } catch {
      /* 一个监听者炸了不该连累其他人 */
    }
  }
}
