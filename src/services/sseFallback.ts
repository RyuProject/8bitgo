/**
 * SSE 连不上时**什么时候放弃、退回轮询**。
 *
 * ── 为什么需要这一层 ────────────────────────────────────────
 * 三处 EventSource（直播大厅、联机大厅、单个房间）原来的兜底条件都是
 * `if (es.readyState === EventSource.CLOSED) startPolling()`。这条判断只对
 * **一种**失败有效：服务端明确回了 4xx/5xx（比如老后端没有这个端点），浏览器
 * 认为「没救了」才把状态置成 CLOSED。
 *
 * 而真实线上遇到的是另一种（2026-09-08 控制台实测）：
 *
 *     GET https://8bitgo.com/api/live/events    net::ERR_QUIC_PROTOCOL_ERROR 200 (OK)
 *     GET https://8bitgo.com/api/netplay/events net::ERR_QUIC_PROTOCOL_ERROR 200 (OK)
 *
 * HTTP/3 那条长连接在传输层被掐断。**这类网络错误浏览器会一直自己重连**，
 * readyState 停在 CONNECTING(0) 永远不到 CLOSED —— 于是兜底一次都不会触发，
 * 大厅列表就那么静静地不再更新，没有报错、没有降级、玩家只当「没人在播」。
 * 而 QUIC 一旦在这条路上不通，重连大概率继续不通，等下去没有意义。
 *
 * 所以判据换成「连着失败几次都没能接上」：`open` 一到就归零（真连上了，
 * 哪怕之后偶尔抖一下也不算），连续 limit 次错误之间一次 open 都没有，
 * 就主动 close() 并交给调用方退回轮询。
 *
 * ⚠️ 放弃之后**不再自动回到 SSE**：轮询能用，而这条链路刚刚证明了自己不通，
 * 反复试只是白烧请求。下一次订阅（换页、重新挂载）会重新尝试 SSE。
 */

/**
 * EventSource 的 readyState 常量。
 * 刻意不写 `EventSource.CLOSED` —— SSR 那一侧和纯 node 的测试里没有这个全局，
 * 引用它会在导入时就抛。数值是 spec 里定死的。
 */
const CLOSED = 2

/** 连着这么多次错误都没接上就放弃（约等于浏览器重试 3 轮，几秒到十几秒） */
export const SSE_ERROR_LIMIT = 3

/** 只用到这几个成员；这样测试里可以喂一个假的，不必有 DOM */
export interface SseLike {
  readyState: number
  close: () => void
  addEventListener: (type: string, listener: () => void) => void
}

/**
 * 给一条 EventSource 装上「放弃」逻辑。
 *
 * @param es 已经建好的连接
 * @param onGiveUp 放弃时调用（各处传自己的 startPolling —— **必须幂等**，
 *                 CLOSED 那一路和连续失败那一路都可能调到）
 * @param limit 连续失败多少次算放弃
 */
export function fallbackAfterErrors(es: SseLike, onGiveUp: () => void, limit = SSE_ERROR_LIMIT): void {
  let errors = 0
  es.addEventListener('open', () => {
    errors = 0
  })
  es.addEventListener('error', () => {
    // 浏览器判定「没救了」：立刻退，不用等次数
    if (es.readyState === CLOSED) {
      onGiveUp()
      return
    }
    errors += 1
    if (errors < limit) return
    // 主动收掉，否则浏览器会继续在这条不通的链路上重连
    try {
      es.close()
    } catch {
      /* 已经关了就无所谓 */
    }
    onGiveUp()
  })
}
