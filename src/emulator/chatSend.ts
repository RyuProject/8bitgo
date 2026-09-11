/**
 * 「发一条弹幕，并且**把服务端的答复带回来**」。
 *
 * ## 为什么要有这么个小模块
 *
 * 主播和观众发弹幕走的是两个不同的句柄（`Broadcast.sendChat` / `LiveSession.liveChat`），
 * 而这两处原来都是同一段代码：
 *
 *     if (socket.connected) socket.emit('chat', { text: clean })
 *
 * 也就是**发完就不管了**。服务端其实一直在 ack 拒收原因（太快、房间散了、不在房间里），
 * 一个字都没人看。配上「弹幕不做本地回显」这条设计（顺序由服务端定，见 LiveChat.tsx），
 * 结果是：用户按下回车 → 输入框清空 → 画面上什么都没有 —— 和「没人说话」一模一样。
 * 他只会再打一遍，然后再被限流一次。
 *
 * 抽出来而不是在两处各写一遍：这段逻辑有三条分支（没连上 / ack 说不行 / ack 根本没来），
 * 抄两份就一定会有一份漏掉其中一条 —— 弹幕这块已经吃过一次「两条路径不一致」的亏了
 * （分享标签页那一路漏接 onChat，见 scripts/test-live-chat.mjs 的文件头）。
 * 而且这样它能在 node 里被真的跑一遍（scripts/test-chat-send.mjs），不用靠 grep 源码。
 */
import { CHAT_ACK_TIMEOUT_MS, chatSendOutcome, sanitizeChatText } from '../../shared/live-chat.js'

/** null = 发出去了；'too-fast' = 被限流；'dropped' = 没发出去 */
export type ChatSendResult = 'too-fast' | 'dropped' | null

/** 只声明我们真的用到的那部分 socket.io 客户端，方便测试里塞一个假的 */
export interface ChatSocketLike {
  connected: boolean
  emit: (event: string, payload: unknown, ack: (err?: unknown) => void) => void
}

/**
 * 发一条，等 ack。**永不抛异常**（调用方是个输入框，不该为此崩掉）。
 *
 * 三条「没发出去」的路，一条都不能漏：
 *   1. **socket 没连上** —— 原来这里是 `if (socket.connected)` 然后什么都不做。
 *      补发没有意义（那一刻早过去了），但**告诉用户一声**是必须的。
 *   2. **ack 说不行** —— 太快 / 不在房间里 / 房间没了。
 *   3. **ack 根本没来** —— 发出去之后 socket 断了。没有超时兜底的话这个 promise
 *      永远挂着，调用方的「发送中」状态也就永远不结束。
 */
export function sendChatWithAck(
  socket: ChatSocketLike | null | undefined,
  text: string,
  timeoutMs: number = CHAT_ACK_TIMEOUT_MS,
): Promise<ChatSendResult> {
  const clean = sanitizeChatText(text)
  // 正常路径走不到：输入框自己会拦住空消息。走到了就是真的没发出去，照实说
  if (!clean) return Promise.resolve('dropped')
  if (!socket?.connected) return Promise.resolve('dropped')

  return new Promise<ChatSendResult>((resolve) => {
    // 先兑现的那个算数：ack 和超时只可能有一个有意义，另一个到了要当没看见
    let settled = false
    const done = (r: ChatSendResult) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(r)
    }
    const timer = setTimeout(() => done('dropped'), timeoutMs)
    try {
      socket.emit('chat', { text: clean }, (err?: unknown) => done(chatSendOutcome(err)))
    } catch {
      // emit 本身抛了（socket 正在被拆）
      done('dropped')
    }
  })
}
