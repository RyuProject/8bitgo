/**
 * IM 连接的**状态机**。零 import，可以在 node 里直接跑（同 services/im.ts）。
 *
 * ## 为什么要把这一层单独抽出来
 *
 * 第一版把连接逻辑全写在 imClient.ts 里，用一个裸的 `starting` promise 防重入。
 * 2026-09-07 的自查发现那是个**跨账号冒充**漏洞，而且当时的测试完全查不出来 ——
 * 它只 grep 了两个防护的**代码形状**，形状在、但两个都能绕过：
 *
 *   1. A 点私信 -> ensureImStarted 开始拉 700 KB 的 SDK 分包（几百毫秒到几秒）
 *   2. A 退出登录 -> imStop() -> hardReset() 里 `chat` 还是 null，直接 early return，
 *      **`starting` 一个字都没动**
 *   3. B 在同一个标签页登录，点私信 -> ensureImStarted 看到 `starting` 非空，
 *      **把 A 那次的 promise 原样返回**
 *   4. 那次 promise 带着 **A 的 sig** 完成登录。于是 B 的抽屉里是 A 的会话列表、
 *      A 的未读数，而且 B 打的字**以 A 的身份发出去**
 *
 * 根因是「在飞的那次异步没有主人」：既不记它属于谁，也没有任何 await 之后的存活检查。
 * 所以这里引入 **epoch（代）**：
 *
 *   · 每次启动领一个 epoch；
 *   · 任何一次作废（登出、换账号、手动重连）都 `epoch++`；
 *   · 异步过程每跨一个 await 就问一次 isStale(epoch)，是旧代就自己收摊；
 *   · 在飞的那次**记住属于哪个 userId**，换人时绝不复用。
 *
 * 抽成零依赖模块的唯一目的是**能被测试真的跑一遍**（scripts/test-im-session.mjs），
 * 而不是继续靠正则去看代码长什么样。
 */

/**
 * 连接状态。
 *
 * `kicked` 和 `error` 分开：前者要用户点一下才重连（自动重连会和另一个标签页无限互踢），
 * 后者可以重试。`unavailable` 是「后端没配 IM」，属于正常地不可用，UI 不该报红。
 */
export type ImState = 'off' | 'connecting' | 'ready' | 'error' | 'kicked' | 'unavailable'

let state: ImState = 'off'
let detail = ''
let epoch = 0
/** 在飞的那次启动。**必须记住属于哪个 userId** —— 这是那个漏洞的核心 */
let inflight: { userId: string; epoch: number; promise: Promise<boolean> } | null = null

const listeners = new Set<() => void>()

function emit() {
  // 拷一份再遍历：监听者在回调里退订是常事（React 的 cleanup 就会）
  for (const fn of [...listeners]) {
    try {
      fn()
    } catch {
      /* 一个监听者炸了不该连累其他人 */
    }
  }
}

export function onImStateChange(fn: () => void): () => void {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

export function imState(): ImState {
  return state
}

/** 出错时给 UI 看的补充信息（腾讯的错误码之类）。正常时是空串 */
export function imStateDetail(): string {
  return detail
}

export function currentEpoch(): number {
  return epoch
}

/** 这一代还算数吗。**每跨一个 await 都要问一次** */
export function isStale(e: number): boolean {
  return e !== epoch
}

/**
 * 作废当前这一代：epoch++ 并丢掉在飞的那次。返回新的 epoch。
 *
 * 登出、换账号、手动重连都要先调它。丢掉 inflight 是关键 ——
 * 留着它下一个人就会拿到上一个人的连接。
 */
export function invalidate(): number {
  inflight = null
  return ++epoch
}

/**
 * 改状态。**带 epoch 的版本**：旧代的异步过程改不动当前状态。
 *
 * 没有这一层的话，A 退出登录之后 A 那次失败的 login 还会把状态写成 error，
 * 于是一个已经登出的模块停在 error 上。
 */
export function setStateIf(e: number, next: ImState, nextDetail = ''): boolean {
  if (isStale(e)) return false
  setState(next, nextDetail)
  return true
}

/** 改状态，不看代。只给「当下就是现在」的同步路径用（比如 invalidate 之后紧跟着设 off） */
export function setState(next: ImState, nextDetail = ''): void {
  if (state === next && detail === nextDetail) return
  state = next
  detail = nextDetail
  emit()
}

/**
 * 启动一次连接，自带防重入。
 *
 * - 同一个 userId、同一代、已经在飞 -> 复用那次
 * - **换了 userId** -> 作废旧的，开新的一代（绝不复用）
 * - 上一代已被作废 -> 同上
 *
 * `run(epoch)` 里每跨一个 await 都应该 `if (isStale(epoch)) return false`。
 */
export function startOnce(userId: string, run: (e: number) => Promise<boolean>): Promise<boolean> {
  if (inflight && inflight.userId === userId && !isStale(inflight.epoch)) return inflight.promise

  const e = invalidate()
  const promise = (async () => run(e))().finally(() => {
    // 只清自己那一条：作废之后可能已经有新的一次在飞了
    if (inflight && inflight.epoch === e) inflight = null
  })
  inflight = { userId, epoch: e, promise }
  return promise
}

/** 当前在飞的那次属于谁。给测试和排障用；没有在飞的返回空串 */
export function inflightUserId(): string {
  return inflight?.userId ?? ''
}

/** 只给测试用：把模块恢复成初始状态 */
export function __resetImSession(): void {
  state = 'off'
  detail = ''
  epoch = 0
  inflight = null
  listeners.clear()
}
