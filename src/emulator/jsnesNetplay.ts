/**
 * jsnes 的 P2P 联机引擎（与 EmulatorJS netplay 完全独立）。
 *
 * 原理：两端各跑一份 jsnes + 同一份 ROM（初始状态一致），每一帧把**自己这一侧的手柄输入**
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
import type { PadAction } from './types'

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

export interface JsnesNetplayOptions {
  /** 进房时带房间号；不带就是开新房 */
  roomId?: string
  /** 0 = 房主（1P），1 = 访客（2P） */
  seat: 0 | 1
  /** 输入延迟帧数（默认 2）。越大越稳但越不跟手 */
  bufferFrames?: number
  onState?: (state: RTCPeerConnectionState) => void
  onPeerCount?: (count: number) => void
  onRoom?: (roomId: string, isHost: boolean) => void
  onHostLeft?: () => void
}

interface WsSignal {
  type: string
  [k: string]: unknown
}

export class JsnesNetplay {
  roomId = ''
  seat: 0 | 1
  bufferFrames: number
  private ws: WebSocket | null = null
  private pc: RTCPeerConnection | null = null
  private dc: RTCDataChannel | null = null
  private peerId: string | null = null
  private openedResolve: (() => void) | null = null
  private openedReject: ((e: Error) => void) | null = null
  /** 收到的对方输入，按帧号索引 */
  private remoteByFrame: Record<number, number> = {}
  private opts: JsnesNetplayOptions

  constructor(opts: JsnesNetplayOptions) {
    this.opts = opts
    this.seat = opts.seat
    this.bufferFrames = opts.bufferFrames ?? 2
  }

  /** 连上信令、拿到房间号（开房）或进房成功（进房）后才 resolve */
  connect(): Promise<void> {
    if (!NETPLAY_URL) return Promise.reject(new Error('NETPLAY_URL 未配置'))
    const base = NETPLAY_URL.replace(/\/netplay$/, '')
    const url = new URL('/jsnes-netplay', base)
    url.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:'
    const ws = new WebSocket(url.toString())
    this.ws = ws
    return new Promise<void>((resolve, reject) => {
      this.openedResolve = resolve
      this.openedReject = reject
      ws.onopen = () => {
        ws.send(JSON.stringify({ type: this.roomId ? 'join' : 'host', roomId: this.roomId }))
      }
      ws.onerror = () => reject(new Error('信令连接失败'))
      ws.onmessage = (e) => this.onWs(JSON.parse(e.data as string) as WsSignal)
      ws.onclose = () => {
        this.opts.onState?.('disconnected')
      }
    })
  }

  private onWs(msg: WsSignal) {
    switch (msg.type) {
      case 'room': {
        this.roomId = String(msg.roomId)
        this.opts.onRoom?.(this.roomId, true)
        void this.setupPc(true)
        this.openedResolve?.()
        this.openedResolve = null
        break
      }
      case 'joined': {
        this.roomId = String(msg.roomId)
        this.peerId = String(msg.host)
        this.opts.onRoom?.(this.roomId, false)
        void this.setupPc(false)
        this.openedResolve?.()
        this.openedResolve = null
        break
      }
      case 'peer-joined': {
        // 房主得知访客来了，开始协商（房主永远是 offerer）
        this.peerId = String(msg.guest)
        void this.makeOffer()
        break
      }
      case 'signal': {
        void this.onSignal(msg.from as string, msg.data as { sdp?: RTCSessionDescriptionInit; candidate?: RTCIceCandidateInit })
        break
      }
      case 'peer-left': {
        this.opts.onHostLeft?.()
        this.close()
        break
      }
      case 'error': {
        this.openedReject?.(new Error(String(msg.reason)))
        this.openedReject = null
        break
      }
    }
  }

  private async setupPc(isHost: boolean) {
    const ice = await fetchIceConfig()
    const pc = new RTCPeerConnection({ iceServers: ice.iceServers })
    this.pc = pc
    pc.onicecandidate = (e) => {
      if (e.candidate) this.signal({ candidate: e.candidate.toJSON() })
    }
    pc.onconnectionstatechange = () => this.opts.onState?.(pc.connectionState)
    if (isHost) {
      const dc = pc.createDataChannel('input')
      this.bindDc(dc)
    } else {
      pc.ondatachannel = (e) => this.bindDc(e.channel)
    }
  }

  private bindDc(dc: RTCDataChannel) {
    this.dc = dc
    dc.onopen = () => this.opts.onState?.('connected')
    dc.onmessage = (e) => {
      try {
        const m = JSON.parse(e.data as string) as { frame: number; bits: number }
        if (typeof m.frame === 'number') this.remoteByFrame[m.frame] = m.bits
      } catch {
        /* 坏包忽略 */
      }
    }
  }

  private async makeOffer() {
    const pc = this.pc
    if (!pc) return
    const offer = await pc.createOffer()
    await pc.setLocalDescription(offer)
    this.signal({ sdp: pc.localDescription!.toJSON() })
  }

  private async onSignal(from: string, data: { sdp?: RTCSessionDescriptionInit; candidate?: RTCIceCandidateInit }) {
    const pc = this.pc
    if (!pc) return
    if (data.sdp) {
      await pc.setRemoteDescription(data.sdp)
      if (data.sdp.type === 'offer') {
        const answer = await pc.createAnswer()
        await pc.setLocalDescription(answer)
        this.signal({ sdp: pc.localDescription!.toJSON() })
      }
    } else if (data.candidate) {
      try {
        await pc.addIceCandidate(data.candidate)
      } catch {
        /* 候选可能迟到，忽略 */
      }
    }
  }

  private signal(data: unknown) {
    if (this.ws?.readyState === WebSocket.OPEN && this.peerId) {
      this.ws.send(JSON.stringify({ type: 'signal', to: this.peerId, data }))
    }
  }

  /** 把本帧本地输入发给对方 */
  sendLocal(frame: number, bits: number) {
    if (this.dc?.readyState === 'open') {
      this.dc.send(JSON.stringify({ frame, bits }))
    }
  }

  /** 取某帧的对方输入（可能尚未到达，返回 undefined） */
  remoteBitsFor(frame: number): number | undefined {
    return this.remoteByFrame[frame]
  }

  /** 清掉比某帧更老的输入缓存 */
  pruneRemote(beforeFrame: number) {
    for (const k of Object.keys(this.remoteByFrame)) {
      if (Number(k) < beforeFrame) delete this.remoteByFrame[k]
    }
  }

  setBuffer(frames: number) {
    this.bufferFrames = Math.max(0, Math.min(8, frames | 0))
  }

  close() {
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
  }
}
