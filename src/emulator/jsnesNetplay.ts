/**
 * jsnes 的 P2P 联机引擎（与 EmulatorJS netplay 完全独立）。
 *
 * 原理：两端各跑一份 jsnes + 同一份 ROM，连通后先由房主下发一份初始状态，再把每一帧
 * **自己这一侧的手柄输入**
 * 经 WebRTC 数据通道发给对方，双方按相同的帧号把「本地输入 + 对方输入」一起喂进模拟器。
 * jsnes 是确定性的，同样的输入序列 → 同样的画面，于是两边自动同步，无需传画面。
 *
 * 信令走浏览器原生 WebSocket（/jsnes-netplay，由 server/src/jsnes-netplay.js 提供），
 * 不引入 socket.io-client。ICE 配置复用现有联机那套（fetchIceConfig，见 services/netplay.ts）。
 *
 * 输入延迟：两帧锁步（bufferFrames，可调）。本地与对方输入都延迟同样多帧再施加，
 * 保证双方按**完全相同的帧号**施加**完全相同的输入对** —— 这才是同步的关键。
 * 比画面串流省带宽、延迟也更低，但要求两边 jsnes 版本与 ROM 完全一致。
 */
import { fetchIceConfig, NETPLAY_URL } from '@/services/netplay'
import type { PadAction } from '@/services/padKeys'

/** 手柄按键 → 位序。顺序固定，适配器和引擎必须共用同一份 */
export const NETPLAY_ACTIONS: PadAction[] = [
  'a',
  'b',
  'select',
  'start',
  'up',
  'down',
  'left',
  'right',
  'turboA',
  'turboB',
]

export function encodeInput(state: Record<string, boolean>): number {
  let bits = 0
  for (let i = 0; i < NETPLAY_ACTIONS.length; i++) {
    if (state[NETPLAY_ACTIONS[i]]) bits |= 1 << i
  }
  return bits
}

export function decodeInput(bits: number): Record<string, boolean> {
  const out: Record<string, boolean> = {}
  for (let i = 0; i < NETPLAY_ACTIONS.length; i++) out[NETPLAY_ACTIONS[i]] = (bits & (1 << i)) !== 0
  return out
}

/** 将生产环境常用的同源 `/netplay` 和独立信令域名都解析为 WebSocket 入口。 */
export function jsnesNetplaySocketUrl(configuredUrl: string, pageUrl: string): string {
  // VITE_NETPLAY_URL 在生产通常是 `/netplay`；先相对页面解析才能取得真实 origin。
  const configured = new URL(configuredUrl, pageUrl)
  const socketUrl = new URL('/jsnes-netplay', configured.origin)
  socketUrl.protocol = new URL(pageUrl).protocol === 'https:' ? 'wss:' : 'ws:'
  return socketUrl.toString()
}

/** 联机结束时释放仍施加在核心里的按键，避免断线正好丢掉 keyup 后单机角色卡键。 */
export function releaseNetplaySeatInputs(
  appliedBits: Record<number, number>,
  release: (seat: 0 | 1, action: PadAction) => void,
): void {
  for (const seat of [0, 1] as const) {
    const bits = appliedBits[seat] ?? -1
    // -1 表示本局还没有把该座位的状态施加到核心，不需要发一串无意义的 keyup。
    if (bits >= 0) {
      for (let i = 0; i < NETPLAY_ACTIONS.length; i++) {
        if ((bits & (1 << i)) !== 0) release(seat, NETPLAY_ACTIONS[i])
      }
    }
    appliedBits[seat] = 0
  }
}

export interface JsnesNetplayOptions {
  /** 进房时带房间号；不带就是开新房 */
  roomId?: string
  /** 0 = 房主（1P），1 = 访客（2P） */
  seat: 0 | 1
  /** 输入延迟帧数（默认 2）。越大越稳但越不跟手 */
  bufferFrames?: number
  /** ROM 内容指纹；只看房间号不够，修改版 / 不同语言版混跑一定会失步。 */
  gameId: string
  /** 房主在数据通道连通后冻结游戏，并交出这一帧的完整状态。 */
  captureInitialState: () => unknown
  /** 访客在锁步开始前载入房主的完整状态。 */
  applyInitialState: (state: unknown) => void
  /** GBA 电缆联机需要双方各自把本机卡带存档同步给对方，按座位组成两份镜像存档。 */
  captureOwnState?: () => unknown
  /** GBA 电缆联机收到对端卡带存档时调用；不影响默认的房主权威同步。 */
  applyPeerState?: (state: unknown) => void
  /** 初始状态已经对齐，可以接管帧时钟。 */
  onReady?: () => void
  /** 协议 / ROM / 状态同步失败。 */
  onError?: (message: string) => void
  onState?: (state: RTCPeerConnectionState) => void
  onPeerCount?: (count: number) => void
  onRoom?: (roomId: string, isHost: boolean) => void
  onHostLeft?: () => void
}

interface WsSignal {
  type: string
  [k: string]: unknown
}

// 4.0 增加双向卡带存档握手；旧页面不能误把它当成房主单向状态同步。
const PROTOCOL_VERSION = 4
const CONNECT_TIMEOUT_MS = 15_000
const PEER_TIMEOUT_MS = 25_000
const DISCONNECT_GRACE_MS = 10_000
const STATE_CHUNK_CHARS = 12 * 1024
const MAX_STATE_CHARS = 8 * 1024 * 1024
/** 状态以 12 KiB 小块发送，限制单条消息可避免坏对端在移动端触发大块 JSON 解析。 */
const MAX_DATA_MESSAGE_CHARS = STATE_CHUNK_CHARS + 1024
const MAX_REMOTE_FRAMES = 600
/** 锁步双方最多只会因输入缓冲和网络排队短暂错开；拒收远期帧，避免脏包撑满缓存。 */
const MAX_REMOTE_FRAME_LEAD = 120
/** 多网卡环境的正常 ICE 候选远少于此值；上限防止 SDP 到达前的候选洪泛占用移动端内存。 */
const MAX_PENDING_ICE = 256

/**
 * 不拿文件名当 ROM 身份：同名汉化版和原版也不能锁步。
 * 两个独立的 32 位滚动散列不是安全签名，但足以拦住实际会遇到的错版本，且不会为了
 * 几百 KB 的 NES ROM 再复制一份 ArrayBuffer 给 WebCrypto。
 */
export function jsnesRomFingerprint(bytes: Uint8Array): string {
  let a = 0x811c9dc5
  let b = 0x9e3779b9
  for (let i = 0; i < bytes.length; i++) {
    a = Math.imul(a ^ bytes[i], 0x01000193) >>> 0
    b = Math.imul(b ^ (bytes[i] + i), 0x85ebca6b) >>> 0
  }
  return `${bytes.length.toString(16)}-${a.toString(16).padStart(8, '0')}${b.toString(16).padStart(8, '0')}`
}

export class JsnesNetplay {
  roomId = ''
  seat: 0 | 1
  bufferFrames = 2
  private ws: WebSocket | null = null
  private pc: RTCPeerConnection | null = null
  private dc: RTCDataChannel | null = null
  private peerId: string | null = null
  private pcPromise: Promise<RTCPeerConnection> | null = null
  private openedResolve: (() => void) | null = null
  private openedReject: ((e: Error) => void) | null = null
  private connectTimer = 0
  private peerTimer = 0
  private disconnectTimer = 0
  private closing = false
  private ready = false
  private peerHello = false
  private syncSending = false
  private syncId = ''
  private syncParts: string[] | null = null
  private syncChars = 0
  private ownStateSent = false
  private peerStateReceived = false
  private peerStateAcked = false
  private ownStateId = ''
  private pendingIce: RTCIceCandidateInit[] = []
  /** 收到的对方输入，按帧号索引 */
  private remoteByFrame: Record<number, number> = {}
  /** 输入缓存条数单独维护，避免每个到达帧都分配 Object.keys 临时数组。 */
  private remoteFrameCount = 0
  /** 已发送的最高本地帧，用来把对端输入限制在合理的锁步窗口内。 */
  private latestLocalFrameSent = -1
  private opts: JsnesNetplayOptions

  constructor(opts: JsnesNetplayOptions) {
    this.opts = opts
    this.seat = opts.seat
    this.setBuffer(opts.bufferFrames ?? 2)
    // 旧实现漏了这一句：访客无论填什么房号都会走 host 分支，实际效果是“加入”又开了一间。
    this.roomId = opts.roomId?.trim().toLowerCase() ?? ''
  }

  /** 连上信令、拿到房间号（开房）或进房成功（进房）后才 resolve */
  connect(): Promise<void> {
    if (!NETPLAY_URL) return Promise.reject(new Error('NETPLAY_URL 未配置'))
    const ws = new WebSocket(jsnesNetplaySocketUrl(NETPLAY_URL, window.location.href))
    this.ws = ws
    return new Promise<void>((resolve, reject) => {
      this.openedResolve = resolve
      this.openedReject = reject
      ws.onopen = () => {
        ws.send(JSON.stringify({ type: this.roomId ? 'join' : 'host', roomId: this.roomId }))
      }
      this.connectTimer = window.setTimeout(() => this.rejectOpen(new Error('信令连接超时')), CONNECT_TIMEOUT_MS)
      ws.onerror = () => this.rejectOpen(new Error('信令连接失败'))
      ws.onmessage = (e) => {
        try {
          this.onWs(JSON.parse(e.data as string) as WsSignal)
        } catch {
          /* 服务端坏包不能把页面事件回调打断。 */
        }
      }
      ws.onclose = () => {
        if (!this.closing) {
          this.rejectOpen(new Error('信令连接已断开'))
          this.opts.onState?.('disconnected')
        }
      }
    })
  }

  private resolveOpen() {
    window.clearTimeout(this.connectTimer)
    this.connectTimer = 0
    this.openedResolve?.()
    this.openedResolve = null
    this.openedReject = null
  }

  private rejectOpen(error: Error) {
    window.clearTimeout(this.connectTimer)
    this.connectTimer = 0
    this.openedReject?.(error)
    this.openedResolve = null
    this.openedReject = null
  }

  private onWs(msg: WsSignal) {
    // close() 之后服务端可能还有一两条已经进事件队列的 signal / peer-left；
    // 再处理会重复报“对端离开”，甚至在已销毁页面上重新创建 PeerConnection。
    if (this.closing) return
    switch (msg.type) {
      case 'room': {
        this.roomId = String(msg.roomId)
        this.opts.onRoom?.(this.roomId, true)
        this.opts.onPeerCount?.(1)
        void this.ensurePc(true).catch((error) => this.fail(error))
        this.resolveOpen()
        break
      }
      case 'joined': {
        this.roomId = String(msg.roomId)
        this.peerId = String(msg.host)
        this.opts.onRoom?.(this.roomId, false)
        this.opts.onPeerCount?.(2)
        void this.ensurePc(false).catch((error) => this.fail(error))
        this.armPeerTimeout()
        this.resolveOpen()
        break
      }
      case 'peer-joined': {
        // 房主得知访客来了，开始协商（房主永远是 offerer）
        this.peerId = String(msg.guest)
        this.opts.onPeerCount?.(2)
        this.armPeerTimeout()
        void this.makeOffer().catch((error) => this.fail(error))
        break
      }
      case 'signal': {
        if (!this.peerId && typeof msg.from === 'string') this.peerId = msg.from
        void this.onSignal(msg.data as { sdp?: RTCSessionDescriptionInit; candidate?: RTCIceCandidateInit })
          .catch((error) => this.fail(error))
        break
      }
      case 'peer-left': {
        this.opts.onPeerCount?.(1)
        this.opts.onHostLeft?.()
        this.close()
        break
      }
      case 'error': {
        const error = new Error(String(msg.reason))
        if (this.openedReject) this.rejectOpen(error)
        else this.fail(error)
        break
      }
    }
  }

  private ensurePc(isHost = this.seat === 0): Promise<RTCPeerConnection> {
    if (this.pcPromise) return this.pcPromise
    this.pcPromise = (async () => {
      const ice = await fetchIceConfig()
      if (this.closing) throw new Error('联机已经关闭')
      const pc = new RTCPeerConnection({ iceServers: ice.iceServers })
      this.pc = pc
      pc.onicecandidate = (e) => {
        if (e.candidate) this.signal({ candidate: e.candidate.toJSON() })
      }
      pc.onconnectionstatechange = () => {
        this.opts.onState?.(pc.connectionState)
        if (pc.connectionState === 'connected') {
          window.clearTimeout(this.disconnectTimer)
          this.disconnectTimer = 0
        } else if (pc.connectionState === 'disconnected' && !this.disconnectTimer) {
          // Chromium 在切网后可能永远停在 disconnected，既不恢复也不进 failed。
          // 留一个短暂自愈窗口，过期后明确结束，不能让锁步循环永久冻在同一帧。
          this.disconnectTimer = window.setTimeout(() => {
            this.disconnectTimer = 0
            if (!this.closing && this.pc?.connectionState === 'disconnected') {
              this.fail(new Error('WebRTC 连接已断开'))
            }
          }, DISCONNECT_GRACE_MS)
        } else if (!this.closing && (pc.connectionState === 'failed' || pc.connectionState === 'closed')) {
          this.fail(new Error('WebRTC 连接失败'))
        }
      }
      if (isHost) {
        const dc = pc.createDataChannel('input')
        this.bindDc(dc)
      } else {
        pc.ondatachannel = (e) => this.bindDc(e.channel)
      }
      return pc
    })()
    return this.pcPromise
  }

  private bindDc(dc: RTCDataChannel) {
    this.dc = dc
    dc.onopen = () => {
      this.sendData({
        kind: 'hello',
        version: PROTOCOL_VERSION,
        gameId: this.opts.gameId,
        bufferFrames: this.bufferFrames,
        exchangeState: Boolean(this.opts.captureOwnState && this.opts.applyPeerState),
      })
    }
    dc.onclose = () => {
      if (!this.closing) this.fail(new Error('输入通道已断开'))
    }
    dc.onerror = () => {
      if (!this.closing) this.fail(new Error('输入通道发生错误'))
    }
    dc.onmessage = (e) => {
      if (typeof e.data !== 'string' || e.data.length > MAX_DATA_MESSAGE_CHARS) {
        if (!this.closing) this.fail(new Error('对端联机消息格式错误或超过大小限制'))
        return
      }
      try {
        const m = JSON.parse(e.data) as Record<string, unknown>
        this.onData(m)
      } catch {
        /* 坏包忽略 */
      }
    }
  }

  private onData(m: Record<string, unknown>) {
    if (m.kind === 'hello') {
      if (m.version !== PROTOCOL_VERSION) return this.fail(new Error('双方联机协议版本不同，请刷新页面后重试'))
      if (m.gameId !== this.opts.gameId) return this.fail(new Error('双方 ROM 内容不同，不能进行锁步联机'))
      if (Boolean(m.exchangeState) !== Boolean(this.opts.captureOwnState && this.opts.applyPeerState)) {
        return this.fail(new Error('双方联机模式不一致，请刷新页面后重新开房'))
      }
      const peerBuffer = Number(m.bufferFrames)
      if (this.seat === 1 && Number.isInteger(peerBuffer)) this.setBuffer(peerBuffer)
      this.peerHello = true
      if (this.opts.captureOwnState && this.opts.applyPeerState) void this.sendOwnState()
      else if (this.seat === 0) void this.sendInitialState()
      return
    }
    if (m.kind === 'sync-start' && (this.seat === 1 || (this.opts.captureOwnState && this.opts.applyPeerState))) {
      const id = typeof m.id === 'string' ? m.id : ''
      const fromSeat = m.fromSeat === 0 || m.fromSeat === 1 ? m.fromSeat : null
      const chunks = Number(m.chunks)
      const chars = Number(m.chars)
      if (!id || !Number.isInteger(chunks) || chunks < 1 || chunks > Math.ceil(MAX_STATE_CHARS / STATE_CHUNK_CHARS)
        || !Number.isInteger(chars) || chars < 2 || chars > MAX_STATE_CHARS
        || (this.opts.captureOwnState && this.opts.applyPeerState && fromSeat !== (this.seat === 0 ? 1 : 0))) {
        return this.fail(new Error('房主状态数据不合法'))
      }
      this.syncId = id
      this.syncParts = Array.from<string>({ length: chunks })
      this.syncChars = chars
      return
    }
    if (m.kind === 'sync-chunk' && (this.seat === 1 || (this.opts.captureOwnState && this.opts.applyPeerState)) && this.syncParts && m.id === this.syncId) {
      const index = Number(m.index)
      if (!Number.isInteger(index) || index < 0 || index >= this.syncParts.length || typeof m.data !== 'string'
        || m.data.length > STATE_CHUNK_CHARS) return
      this.syncParts[index] = m.data
      return
    }
    if (m.kind === 'sync-end' && (this.seat === 1 || (this.opts.captureOwnState && this.opts.applyPeerState)) && this.syncParts && m.id === this.syncId) {
      if (this.syncParts.some((part) => typeof part !== 'string')) return this.fail(new Error('房主状态数据不完整'))
      const json = this.syncParts.join('')
      if (json.length !== this.syncChars) return this.fail(new Error('房主状态长度不匹配'))
      try {
        const state = JSON.parse(json)
        if (this.opts.captureOwnState && this.opts.applyPeerState) {
          this.opts.applyPeerState(state)
          this.peerStateReceived = true
        } else {
          this.opts.applyInitialState(state)
        }
      } catch {
        return this.fail(new Error('无法载入房主的游戏状态'))
      }
      this.syncParts = null
      this.sendData({ kind: 'sync-ready', id: this.syncId, fromSeat: this.seat })
      if (this.opts.captureOwnState && this.opts.applyPeerState) this.maybeStartSymmetricSync()
      return
    }
    if (m.kind === 'sync-ready' && this.opts.captureOwnState && this.opts.applyPeerState && m.id === this.ownStateId
      && m.fromSeat === (this.seat === 0 ? 1 : 0)) {
      this.peerStateAcked = true
      this.maybeStartSymmetricSync()
      return
    }
    if (m.kind === 'sync-ready' && this.seat === 0 && m.id === this.syncId) {
      this.sendData({ kind: 'sync-go', id: this.syncId })
      this.markReady()
      return
    }
    if (m.kind === 'sync-go' && this.seat === 1 && m.id === this.syncId) {
      this.markReady()
      return
    }
    if (m.kind === 'fatal' && typeof m.message === 'string') {
      this.fail(new Error(m.message.slice(0, 200)), false)
      return
    }
    if (m.kind === 'input' && this.ready) {
      const frame = Number(m.frame)
      const bits = Number(m.bits)
      if (!Number.isInteger(frame) || frame < 0 || frame > 2 ** 31 - 1
        || !Number.isInteger(bits) || bits < 0 || bits >= 1 << NETPLAY_ACTIONS.length) {
        return this.fail(new Error('对端发送了无效的按键帧'))
      }
      // 锁步通道是可靠且有序的，正常对端不会领先数秒；保留宽裕窗口处理
      // 低帧率设备和临时抖动，同时防止伪造的远期帧占满缓存后卡死当前帧。
      if (frame > Math.max(0, this.latestLocalFrameSent) + MAX_REMOTE_FRAME_LEAD) {
        return this.fail(new Error('对端输入帧超前过多，联机已停止'))
      }
      if (frame < Math.max(0, this.latestLocalFrameSent - MAX_REMOTE_FRAMES)) return
      const previous = this.remoteByFrame[frame]
      if (previous !== undefined) {
        if (previous !== bits) return this.fail(new Error('对端重复发送了不同的按键帧'))
        return
      }
      if (this.remoteFrameCount >= MAX_REMOTE_FRAMES) {
        return this.fail(new Error('对端输入缓存超限，联机已停止'))
      }
      this.remoteByFrame[frame] = bits
      this.remoteFrameCount++
    }
  }

  private async sendInitialState() {
    if (!this.peerHello || this.syncSending || this.closing || this.seat !== 0) return
    this.syncSending = true
    try {
      const state = this.opts.captureInitialState()
      const json = JSON.stringify(state)
      if (!json || json.length > MAX_STATE_CHARS) throw new Error('初始状态过大，无法联机同步')
      this.syncId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
      const chunks = Math.ceil(json.length / STATE_CHUNK_CHARS)
      this.sendData({ kind: 'sync-start', id: this.syncId, chunks, chars: json.length })
      for (let index = 0; index < chunks; index++) {
        await this.waitForBuffer()
        if (this.closing) return
        this.sendData({
          kind: 'sync-chunk',
          id: this.syncId,
          index,
          data: json.slice(index * STATE_CHUNK_CHARS, (index + 1) * STATE_CHUNK_CHARS),
        })
      }
      this.sendData({ kind: 'sync-end', id: this.syncId })
    } catch (error) {
      this.fail(error)
    }
  }

  /** 双方交换自己座位的卡带存档；确保两端在开局前都拿到同一对存档。 */
  private async sendOwnState() {
    if (!this.peerHello || this.ownStateSent || this.closing || !this.opts.captureOwnState || !this.opts.applyPeerState) return
    this.ownStateSent = true
    try {
      const json = JSON.stringify(this.opts.captureOwnState())
      if (!json || json.length > MAX_STATE_CHARS) throw new Error('卡带存档过大，无法联机同步')
      this.ownStateId = `${this.seat}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
      const chunks = Math.ceil(json.length / STATE_CHUNK_CHARS)
      this.sendData({ kind: 'sync-start', id: this.ownStateId, fromSeat: this.seat, chunks, chars: json.length })
      for (let index = 0; index < chunks; index++) {
        await this.waitForBuffer()
        if (this.closing) return
        this.sendData({
          kind: 'sync-chunk',
          id: this.ownStateId,
          index,
          data: json.slice(index * STATE_CHUNK_CHARS, (index + 1) * STATE_CHUNK_CHARS),
        })
      }
      this.sendData({ kind: 'sync-end', id: this.ownStateId })
    } catch (error) {
      this.fail(error)
    }
  }

  private maybeStartSymmetricSync() {
    if (!this.opts.captureOwnState || !this.opts.applyPeerState || this.closing || !this.ownStateSent
      || !this.peerStateReceived || !this.peerStateAcked) return
    if (this.seat === 0) {
      this.sendData({ kind: 'sync-go', id: this.ownStateId })
      this.markReady()
    }
  }

  private async waitForBuffer() {
    const dc = this.dc
    if (!dc || dc.bufferedAmount <= 512 * 1024) return
    dc.bufferedAmountLowThreshold = 128 * 1024
    await new Promise<void>((resolve) => {
      const done = () => {
        window.clearTimeout(timer)
        dc.removeEventListener('bufferedamountlow', done)
        resolve()
      }
      const timer = window.setTimeout(done, 1000)
      dc.addEventListener('bufferedamountlow', done, { once: true })
    })
  }

  private sendData(data: Record<string, unknown>): boolean {
    if (this.dc?.readyState !== 'open') {
      if (!this.closing) this.fail(new Error('输入通道已经关闭'), false)
      return false
    }
    try {
      this.dc.send(JSON.stringify(data))
      return true
    } catch (error) {
      // RTCDataChannel.send 在切网、缓冲区满或关闭竞态时会同步抛错；不能让异常逃出
      // requestAnimationFrame，否则帧循环停止且玩家只会看到画面冻结。
      if (!this.closing) {
        const detail = error instanceof Error ? `：${error.message}` : ''
        this.fail(new Error(`输入通道发送失败${detail}`), false)
      }
      return false
    }
  }

  private markReady() {
    if (this.ready || this.closing) return
    this.ready = true
    window.clearTimeout(this.peerTimer)
    this.peerTimer = 0
    this.opts.onState?.('connected')
    this.opts.onPeerCount?.(2)
    this.opts.onReady?.()
  }

  private armPeerTimeout() {
    window.clearTimeout(this.peerTimer)
    this.peerTimer = window.setTimeout(() => {
      if (!this.ready && !this.closing) this.fail(new Error('与对端握手超时'))
    }, PEER_TIMEOUT_MS)
  }

  private fail(error: unknown, tellPeer = true) {
    if (this.closing) return
    const message = error instanceof Error ? error.message : String(error)
    if (tellPeer) {
      try {
        // 错误上报不能走 sendData：若发送本身抛错，会递归进入 fail。
        if (this.dc?.readyState === 'open') this.dc.send(JSON.stringify({ kind: 'fatal', message: message.slice(0, 200) }))
      } catch {
        /* 通道已经断了。 */
      }
    }
    try {
      this.opts.onState?.('failed')
    } catch (callbackError) {
      console.warn('[jsnes-netplay] 状态回调失败', callbackError)
    }
    try {
      this.opts.onError?.(message)
    } catch (callbackError) {
      console.warn('[jsnes-netplay] 错误回调失败', callbackError)
    } finally {
      this.close()
    }
  }

  private async makeOffer() {
    const pc = await this.ensurePc(true)
    const offer = await pc.createOffer()
    await pc.setLocalDescription(offer)
    this.signal({ sdp: pc.localDescription!.toJSON() })
  }

  private async onSignal(data: { sdp?: RTCSessionDescriptionInit; candidate?: RTCIceCandidateInit }) {
    const pc = await this.ensurePc(this.seat === 0)
    if (data.sdp) {
      await pc.setRemoteDescription(data.sdp)
      while (this.pendingIce.length) await pc.addIceCandidate(this.pendingIce.shift()!)
      if (data.sdp.type === 'offer') {
        const answer = await pc.createAnswer()
        await pc.setLocalDescription(answer)
        this.signal({ sdp: pc.localDescription!.toJSON() })
      }
    } else if (data.candidate) {
      // ICE 常常先于 SDP 到。直接 add 会抛 InvalidStateError，而且这颗候选永远找不回来。
      if (!pc.remoteDescription) {
        if (this.pendingIce.length >= MAX_PENDING_ICE) return this.fail(new Error('ICE 候选过多，无法建立联机'))
        this.pendingIce.push(data.candidate)
      }
      else await pc.addIceCandidate(data.candidate)
    }
  }

  private signal(data: unknown) {
    if (this.ws?.readyState === WebSocket.OPEN && this.peerId) {
      try {
        this.ws.send(JSON.stringify({ type: 'signal', to: this.peerId, data }))
      } catch (error) {
        const detail = error instanceof Error ? `：${error.message}` : ''
        this.fail(new Error(`联机信令发送失败${detail}`), false)
      }
    }
  }

  /** 把本帧本地输入发给对方 */
  sendLocal(frame: number, bits: number): boolean {
    if (!this.ready) return false
    if (!Number.isInteger(frame) || frame < 0 || frame > 2 ** 31 - 1
      || !Number.isInteger(bits) || bits < 0 || bits >= 1 << NETPLAY_ACTIONS.length) {
      this.fail(new Error('本地输入帧无效'), false)
      return false
    }
    if (!this.sendData({ kind: 'input', frame, bits })) return false
    this.latestLocalFrameSent = Math.max(this.latestLocalFrameSent, frame)
    return true
  }

  /** 取某帧的对方输入（可能尚未到达，返回 undefined） */
  remoteBitsFor(frame: number): number | undefined {
    return this.remoteByFrame[frame]
  }

  /** 清掉比某帧更老的输入缓存 */
  pruneRemote(beforeFrame: number) {
    for (const k of Object.keys(this.remoteByFrame)) {
      if (Number(k) < beforeFrame) {
        delete this.remoteByFrame[Number(k)]
        this.remoteFrameCount--
      }
    }
  }

  setBuffer(frames: number) {
    // 房间参数来自 UI / 对端；夹在 0..8 帧，避免异常值造成过大延迟或环形缓冲分配失控。
    this.bufferFrames = Math.max(0, Math.min(8, Number.isFinite(frames) ? Math.trunc(frames) : 2))
  }

  close() {
    if (this.closing) return
    this.closing = true
    window.clearTimeout(this.connectTimer)
    window.clearTimeout(this.peerTimer)
    window.clearTimeout(this.disconnectTimer)
    this.connectTimer = 0
    this.peerTimer = 0
    this.disconnectTimer = 0
    this.rejectOpen(new Error('联机已经关闭'))
    try {
      this.ws?.send(JSON.stringify({ type: 'leave' }))
    } catch {
      /* 连接已断，忽略 */
    }
    try {
      this.dc?.close()
    } catch {
      /* ignore */
    }
    try {
      this.pc?.close()
    } catch {
      /* ignore */
    }
    try {
      this.ws?.close()
    } catch {
      /* ignore */
    }
    this.remoteByFrame = {}
    this.remoteFrameCount = 0
    this.pendingIce = []
    this.syncParts = null
  }
}
