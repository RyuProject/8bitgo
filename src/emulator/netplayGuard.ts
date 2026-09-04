/**
 * 房主这边的联机输入通道守门（EmulatorJS netplay）。
 *
 * 访客的按键真正走的是 WebRTC DataChannel：引擎在 roomJoined 里把访客的
 * gameManager.functions.simulateInput 换成了 dataChannel.send({player, index, value})，
 * 服务器根本看不见这条路 —— server/src/netplay.js 里对 sync-control 的手柄位过滤只管
 * socket.io 那条**备用**路。而房主这端引擎的 onmessage 是照单全收的
 * （见 emulator.min.js 的 createPeerConnection）：
 *   · `simulateInput(e.player, …)` —— player 是对方自己填的，任何访客（观众也一样）都能替 1P 按键；
 *   · `e.type === 'host-left'` → `leaveRoom()` —— 任何访客发一句话就能把房主踢出他自己的房间。
 *
 * 这两样只能在房主的浏览器里挡。iframe 同源，适配器能在 createDataChannel 那一刻把 onmessage 接管：
 * 引擎赋的 handler 收进来，真正挂在通道上的是我们的监听器 —— 先按发送方是谁
 * （pc → peerConnections 里的 socketId → players 表里的位置）算出他**应该**是几号手柄，
 * 观众一律丢，再把清洗过的消息交给引擎的 handler。手柄号的算法和引擎的 getUserIndex()
 * 完全一致（Object.keys(players).indexOf），服务端 usersPayload 的顺序就是这张表的顺序，三方对得上。
 *
 * 拆成独立模块是为了能在 node 里测（npm run test:netplay-guard）：adapters/emulatorjs.ts 本体
 * 依赖一堆浏览器环境，没法直接 import。
 */

/** 引擎 netplay 实例上我们会读的几个字段 */
export interface GuardedNetplay {
  owner?: boolean
  /** users-updated 那张表：userid → { socketId, role, … }，键序就是手柄号 */
  players?: Record<string, unknown>
  /** socketId → 和那个人的连接 */
  peerConnections?: Record<string, { pc?: RTCPeerConnection | null } | undefined>
}

/**
 * 一条输入通道每秒最多放行几条消息。正常一个人手柄 + 摇杆的事件量在几百以内；
 * 再多就是脚本在灌，每一条都会进模拟器一趟，房主的 CPU 扛不住。
 */
export const INPUT_MSGS_PER_SEC = 1000
/** 一条输入消息的长度上限。{"player":0,"index":12,"value":32767} 也就四十来个字符 */
const MAX_INPUT_MSG_LEN = 256

type MessageHandler = ((this: RTCDataChannel, ev: MessageEvent) => unknown) | null

/**
 * 接管一条房主主动建的 DataChannel。
 * @param getNetplay 取当前的 netplay 实例（消息到达时再取：进房前后对象可能换过）
 */
export function guardInputChannel(getNetplay: () => GuardedNetplay | undefined, ch: RTCDataChannel, pc: RTCPeerConnection): void {
  let handler: MessageHandler = null
  let windowStart = 0
  let count = 0
  // 引擎写 `n.onmessage = fn`：收进 handler，通道本身不挂它
  Object.defineProperty(ch, 'onmessage', {
    configurable: true,
    get: () => handler,
    set: (fn: unknown) => {
      handler = typeof fn === 'function' ? (fn as MessageHandler) : null
    },
  })
  ch.addEventListener('message', (ev: MessageEvent) => {
    if (!handler) return
    const now = Date.now()
    if (now - windowStart > 1000) {
      windowStart = now
      count = 0
    }
    if (++count > INPUT_MSGS_PER_SEC) return
    const safe = sanitizeGuestInput(getNetplay(), pc, ev.data)
    if (safe === null) return
    try {
      handler.call(ch, safe === ev.data ? ev : new MessageEvent('message', { data: safe }))
    } catch {
      /* 引擎自己 handler 里的异常，不是我们的事 */
    }
  })
}

/** 访客发来的一条输入：算出他该在的手柄位并改写 player；不合规的返回 null（丢掉） */
export function sanitizeGuestInput(np: GuardedNetplay | undefined, pc: RTCPeerConnection, raw: unknown): string | null {
  if (typeof raw !== 'string' || raw.length > MAX_INPUT_MSG_LEN) return null
  let msg: unknown
  try {
    msg = JSON.parse(raw)
  } catch {
    return null
  }
  if (!msg || typeof msg !== 'object' || Array.isArray(msg)) return null
  const m = msg as { type?: unknown; player?: unknown; index?: unknown; value?: unknown }
  // 访客 → 房主的正常消息只有 {player, index, value}；带 type 的（host-left）只有房主有资格说
  if (m.type !== undefined) return null
  if (!np?.owner) return null
  const seat = seatOfPeer(np, pc)
  if (seat < 0) return null
  const index = Number(m.index)
  const value = Number(m.value)
  if (!Number.isInteger(index) || index < 0 || index > 63) return null
  if (!Number.isFinite(value) || Math.abs(value) > 32768) return null
  if (m.player === seat && typeof m.index === 'number' && typeof m.value === 'number') return raw
  return JSON.stringify({ player: seat, index, value })
}

/** 这条 PeerConnection 对面的人坐在几号手柄位：观众、认不出来的连接都是 -1 */
export function seatOfPeer(np: GuardedNetplay, pc: RTCPeerConnection): number {
  let socketId = ''
  for (const [sid, entry] of Object.entries(np.peerConnections ?? {})) {
    if (entry?.pc === pc) {
      socketId = sid
      break
    }
  }
  if (!socketId) return -1
  const players = (np.players ?? {}) as Record<string, { socketId?: string; role?: string } | undefined>
  const ids = Object.keys(players)
  for (let i = 0; i < ids.length; i++) {
    const u = players[ids[i]]
    if (u?.socketId === socketId) return u.role === 'spectator' ? -1 : i
  }
  return -1
}
