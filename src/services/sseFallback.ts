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
 * 所以判据换成「连着失败几次都没收到数据」：三个路由都会先发 rooms 快照，
 * 收到它才算真连通并归零。只有 open 说明响应头到了，后续数据仍可能被代理卡住。
 * 连续 limit 次错误之间一次 rooms 都没有，就主动 close() 并退回轮询。
 * 迁机后还实测到 SSE 28 秒连响应头都没有，浏览器这时未必触发 error，
 * 所以首次 rooms 另设 12 秒上限。
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
/** 线上曾出现事件流 28 秒都没有响应头；收到响应头但没有事件也不能一直等。 */
export const SSE_CONNECT_TIMEOUT_MS = 12_000
/**
 * 首个快照之后，多久既没有快照也没有心跳就算这条流已经死了。
 *
 * 服务端每 10 秒发一帧 `event: ping`（sseGuard.js 的 SSE_HEARTBEAT_FRAME）。以前心跳是注释行，
 * 页面看不见，连接在首个快照后静悄悄断掉时（大陆线路上中间设备丢弃空闲 TCP、不回 RST，
 * 浏览器不报 error），列表就永远停在那一刻 —— 侧边栏「一起玩」一直是 0，别人那里明明有房间。
 * 45 秒 = 四个多心跳周期，偶尔丢一两帧不会误判；后台标签页的定时器被节流也不要紧，
 * 判据是墙钟时间差，回到前台那一刻照样判得准。
 */
export const SSE_STALL_MS = 45_000

/** 只用到这几个成员；这样测试里可以喂一个假的，不必有 DOM */
export interface SseLike {
  readyState: number
  close: () => void
  addEventListener: (type: string, listener: () => void) => void
}

/** 停滞检查的节拍；比 SSE_STALL_MS 短得多，判死不至于拖太久 */
const STALL_CHECK_MS = 15_000

/**
 * 给一条 EventSource 装上「放弃」逻辑。
 *
 * @param es 已经建好的连接
 * @param onGiveUp 放弃时调用（各处传自己的 startPolling；这里保证最多调用一次）
 * @param limit 连续失败多少次算放弃
 * @param connectTimeoutMs 收到首个房间快照前最多等多久；返回的清理函数由订阅者卸载时调用
 */
export function fallbackAfterErrors(
  es: SseLike,
  onGiveUp: () => void,
  limit = SSE_ERROR_LIMIT,
  connectTimeoutMs = SSE_CONNECT_TIMEOUT_MS,
  stallMs = SSE_STALL_MS,
  now: () => number = Date.now,
): () => void {
  let errors = 0
  let stopped = false
  let receivedRooms = false
  let timer: ReturnType<typeof setTimeout> | undefined
  let stallTimer: ReturnType<typeof setInterval> | undefined
  /** 最近一次从这条流收到任何事件（快照或心跳）的墙钟时间 */
  let lastSeen = now()
  const clearTimer = () => {
    if (timer !== undefined) clearTimeout(timer)
    timer = undefined
    if (stallTimer !== undefined) clearInterval(stallTimer)
    stallTimer = undefined
  }
  // 收到首个快照才开始盯：之前那段由 connectTimeoutMs 管
  const watchStall = () => {
    if (stallTimer !== undefined || stopped) return
    stallTimer = setInterval(() => {
      if (now() - lastSeen > stallMs) giveUp()
    }, Math.min(STALL_CHECK_MS, stallMs))
  }
  const giveUp = () => {
    if (stopped) return
    stopped = true
    clearTimer()
    try { es.close() } catch { /* 已经关了就无所谓 */ }
    onGiveUp()
  }
  es.addEventListener('rooms', () => {
    if (stopped) return
    receivedRooms = true
    errors = 0
    lastSeen = now()
    if (timer !== undefined) clearTimeout(timer)
    timer = undefined
    watchStall()
  })
  es.addEventListener('ping', () => {
    if (!stopped) lastSeen = now()
  })
  es.addEventListener('error', () => {
    if (stopped) return
    // 浏览器判定「没救了」：立刻退，不用等次数
    if (es.readyState === CLOSED) {
      giveUp()
      return
    }
    errors += 1
    if (errors < limit) return
    giveUp()
  })
  if (!receivedRooms && !stopped) timer = setTimeout(giveUp, connectTimeoutMs)
  // 组件先卸载时，超时回调绝不能把已经无人订阅的大厅重新变成轮询。
  return () => {
    stopped = true
    clearTimer()
  }
}
