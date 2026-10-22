/**
 * 浏览器端的 WFC DNS 应答。
 *
 * 为什么不能全交给中继：DS 的解析器每 ~2 秒就换一个新的 UDP socket 重查，而 SOCKFS 给每个新
 * socket 都新开一条 WSS。线上实测一条 WSS 经 Cloudflare 要 2.5～3 秒才 OPEN，中继再去
 * Kaeru 查（生产机 UDP 不回、只能走 TCP）又要 3～9 秒 —— 每一次都在 DS 放弃之后才回来，
 * 游戏报 52100（DNS 失败），走到 NAS 时报 20100。
 *
 * 做法：会话接口顺带下发服务端已经解析好的 WFC 名字（服务端同时给本会话放行这些 IP）。
 * 核心对 DNS 节点:53 新建 WebSocket 时换成一个本地假 socket：表里有的 A 查询当场作答；
 * 表里没有的才懒开一条真的中继 WSS 转发，并把答案记进表里。其它所有 socket 原样走真 WebSocket。
 */

export interface NdsWfcDnsTable {
  server: string
  answers: Record<string, string[]>
}

const IPV4 = /^(?:\d{1,3}\.){3}\d{1,3}$/
const WFC_NAME = /^(?:[a-z0-9-]{1,63}\.)*nintendowifi\.net$/

export function sanitizeDnsTable(value: unknown): NdsWfcDnsTable | null {
  if (!value || typeof value !== 'object') return null
  const { server, answers } = value as { server?: unknown; answers?: unknown }
  if (typeof server !== 'string' || !IPV4.test(server) || !answers || typeof answers !== 'object') return null
  const clean: Record<string, string[]> = {}
  for (const [name, ips] of Object.entries(answers as Record<string, unknown>).slice(0, 64)) {
    const lower = name.toLowerCase()
    if (!WFC_NAME.test(lower) || !Array.isArray(ips)) continue
    const list = ips.filter((ip): ip is string => typeof ip === 'string' && IPV4.test(ip)).slice(0, 8)
    if (list.length) clean[lower] = list
  }
  return { server, answers: clean }
}

interface DnsQuestion {
  name: string
  type: number
  klass: number
  end: number
}

/** 只认“单个问题、标准查询”的报文；压缩指针在查询里不该出现，出现就当解析失败。 */
export function parseDnsQuestion(bytes: Uint8Array): DnsQuestion | null {
  if (bytes.length < 17 || (bytes[2] & 0x80) || (bytes[2] & 0x78) || ((bytes[4] << 8) | bytes[5]) !== 1) return null
  const labels: string[] = []
  let at = 12
  while (at < bytes.length) {
    const length = bytes[at++]
    if (length === 0) break
    if (length > 63 || at + length > bytes.length) return null
    labels.push(String.fromCharCode(...bytes.subarray(at, at + length)))
    at += length
  }
  if (at + 4 > bytes.length) return null
  const name = labels.join('.').toLowerCase()
  if (!name || name.length > 253) return null
  return { name, type: (bytes[at] << 8) | bytes[at + 1], klass: (bytes[at + 2] << 8) | bytes[at + 3], end: at + 4 }
}

/** 与 server/src/nds-wfc.js 的 dnsAReply 同构：沿用事务 ID 和问题段，A 记录 TTL 30 秒。 */
export function buildDnsAReply(query: Uint8Array, question: DnsQuestion, ips: string[]): Uint8Array {
  const records = ips.slice(0, 8).map((ip) => [0xc0, 0x0c, 0, 1, 0, 1, 0, 0, 0, 30, 0, 4, ...ip.split('.').map(Number)])
  const out = new Uint8Array(question.end + records.length * 16)
  out.set(query.subarray(0, question.end))
  out[2] = 0x80 | (query[2] & 0x01) // QR=1，RD 照抄
  out[3] = 0x80 // RA=1, NOERROR
  out[6] = 0
  out[7] = records.length
  out[8] = out[9] = out[10] = out[11] = 0
  records.forEach((record, i) => out.set(record, question.end + i * 16))
  return out
}

/** 从真实应答里抄出查询名本身的 A 记录（不跟随 CNAME，表里只存直接答案）。 */
export function dnsAnswerIpsFor(reply: Uint8Array, name: string): string[] {
  if (reply.length < 17 || !(reply[2] & 0x80) || (reply[3] & 0x0f) !== 0) return []
  const question = parseDnsQuestion(new Uint8Array([...reply.subarray(0, 2), reply[2] & 0x7f, ...reply.subarray(3)]))
  if (!question || question.name !== name) return []
  const count = Math.min((reply[6] << 8) | reply[7], 16)
  const ips: string[] = []
  let at = question.end
  for (let i = 0; i < count && at < reply.length; i++) {
    // 只处理指向问题名的压缩指针（c0 0c），其它形态直接停，宁可少记不误记
    if (reply[at] !== 0xc0 || reply[at + 1] !== 0x0c || at + 12 > reply.length) break
    const type = (reply[at + 2] << 8) | reply[at + 3]
    const size = (reply[at + 10] << 8) | reply[at + 11]
    at += 12
    if (at + size > reply.length) break
    if (type === 1 && size === 4) ips.push(Array.from(reply.subarray(at, at + 4)).join('.'))
    at += size
  }
  return ips
}

type Listener = ((event: unknown) => void) | null

/**
 * ⚠️ 不能用 instanceof ArrayBuffer：这些类在父页面里定义，核心与 SOCKFS 却在 EmulatorJS 的
 * iframe 里，iframe 的 ArrayBuffer 是另一套构造器，instanceof 恒为 false —— 查询会被当成空包、
 * 中继回来的答案会被当成非二进制直接丢掉（实测就是这样卡到 52100 的）。
 */
function isArrayBuffer(value: unknown): value is ArrayBuffer {
  return Object.prototype.toString.call(value) === '[object ArrayBuffer]'
}

function toBytes(data: unknown): Uint8Array<ArrayBuffer> | null {
  if (isArrayBuffer(data)) return new Uint8Array(data.slice(0))
  if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer)
  return null
}

interface WebSocketLike {
  readonly CONNECTING: 0
  readonly OPEN: 1
  readonly CLOSING: 2
  readonly CLOSED: 3
  readyState: number
  url: string
  protocol: string
  binaryType: BinaryType
  bufferedAmount: number
  onopen: Listener
  onmessage: Listener
  onclose: Listener
  onerror: Listener
  send(data: ArrayBuffer | ArrayBufferView): void
  close(): void
}

type WebSocketCtor = new (url: string, protocols?: string | string[]) => WebSocket

/**
 * 假的 DNS WebSocket。只实现 Emscripten SOCKFS 用到的那一小撮接口：
 * readyState / OPEN… 常量、binaryType、on* 回调、send、close。
 */
export class LocalDnsSocket implements WebSocketLike {
  readonly CONNECTING = 0 as const
  readonly OPEN = 1 as const
  readonly CLOSING = 2 as const
  readonly CLOSED = 3 as const
  readyState = 0
  protocol = 'binary'
  binaryType: BinaryType = 'arraybuffer'
  bufferedAmount = 0
  onopen: Listener = null
  onmessage: Listener = null
  onclose: Listener = null
  onerror: Listener = null
  readonly url: string
  private readonly protocols: string | string[] | undefined
  private readonly table: NdsWfcDnsTable
  private readonly RealWebSocket: WebSocketCtor
  private readonly schedule: (fn: () => void) => void
  private upstream: WebSocket | null = null
  private upstreamQueue: Uint8Array<ArrayBuffer>[] = []
  private pendingNames = new Map<number, string>()

  constructor(
    url: string,
    protocols: string | string[] | undefined,
    table: NdsWfcDnsTable,
    RealWebSocket: WebSocketCtor,
    schedule: (fn: () => void) => void = (fn) => setTimeout(fn, 0),
  ) {
    this.url = url
    this.protocols = protocols
    this.table = table
    this.RealWebSocket = RealWebSocket
    this.schedule = schedule
    // SOCKFS 先把首包塞进自己的发送队列，OPEN 之后再 send；异步开门与真 WebSocket 行为一致。
    this.schedule(() => {
      if (this.readyState !== 0) return
      this.readyState = 1
      this.onopen?.({ type: 'open' })
    })
  }

  send(data: ArrayBuffer | ArrayBufferView): void {
    if (this.readyState !== 1) return
    // SOCKFS 传的是 HEAP 的切片，复制一份免得被后续写入覆盖
    const query = toBytes(data)
    if (!query) return
    const question = parseDnsQuestion(query)
    const ips = question && question.type === 1 && question.klass === 1 ? this.table.answers[question.name] : undefined
    if (question && ips?.length) {
      const reply = buildDnsAReply(query, question, ips)
      this.schedule(() => this.deliver(reply))
      return
    }
    // 表里没有：交给真正的中继（服务端仍然只认白名单域名），回来的答案顺手记进表
    if (question) this.pendingNames.set((query[0] << 8) | query[1], question.name)
    this.forward(query)
  }

  close(): void {
    if (this.readyState >= 2) return
    this.readyState = 3
    try { this.upstream?.close() } catch { /* 已关闭 */ }
    this.upstream = null
    this.schedule(() => this.onclose?.({ type: 'close', code: 1000, wasClean: true }))
  }

  private deliver(reply: Uint8Array): void {
    if (this.readyState !== 1) return
    this.onmessage?.({ data: reply.buffer.slice(reply.byteOffset, reply.byteOffset + reply.byteLength) })
  }

  private forward(query: Uint8Array<ArrayBuffer>): void {
    if (!this.upstream) {
      let ws: WebSocket
      try {
        ws = new this.RealWebSocket(this.url, this.protocols)
      } catch {
        return
      }
      ws.binaryType = 'arraybuffer'
      ws.onopen = () => {
        for (const queued of this.upstreamQueue.splice(0)) ws.send(queued)
      }
      ws.onmessage = (event: MessageEvent) => {
        const reply = toBytes(event.data)
        if (!reply) return
        if (reply.length >= 12) {
          const id = (reply[0] << 8) | reply[1]
          const name = this.pendingNames.get(id)
          if (name) {
            this.pendingNames.delete(id)
            const learned = dnsAnswerIpsFor(reply, name)
            if (learned.length) this.table.answers[name] = learned
          }
        }
        this.deliver(reply)
      }
      // 上游断了不影响本地能答的名字；客体下次查询会再懒开一条
      ws.onclose = () => { if (this.upstream === ws) this.upstream = null }
      ws.onerror = () => {}
      this.upstream = ws
    }
    if (this.upstream.readyState === 1) this.upstream.send(query)
    else if (this.upstreamQueue.length < 8) this.upstreamQueue.push(query)
  }
}

/**
 * 握手失败会自动重连的 WebSocket（只在 OPEN 之前重试）。
 *
 * 线上实测：经 Cloudflare 新开 WSS 大约每 4 条就有 1 条握手直接失败（1006），玩家网络里还常见
 * ERR_HTTP2_PING_FAILED / NETWORK_CHANGED。SOCKFS 对“连不上”没有任何重试：TCP 卡在 SYN、
 * 游戏等到超时报 20100（NAS）或 61020（GP）。OPEN 之前服务端还没有向上游发过一个字节
 * （TCP 是在上游连通后才接受升级），所以换一条连接重来是安全的；OPEN 之后的断线照常交给游戏。
 */
export class RetryingWebSocket implements WebSocketLike {
  readonly CONNECTING = 0 as const
  readonly OPEN = 1 as const
  readonly CLOSING = 2 as const
  readonly CLOSED = 3 as const
  readonly url: string
  onopen: Listener = null
  onmessage: Listener = null
  onclose: Listener = null
  onerror: Listener = null
  private readonly protocols: string | string[] | undefined
  private readonly RealWebSocket: WebSocketCtor
  private readonly delays: number[]
  private current: WebSocket
  private attempt = 0
  private opened = false
  private closedByUser = false
  private type: BinaryType = 'arraybuffer'
  private state = 0

  constructor(url: string, protocols: string | string[] | undefined, RealWebSocket: WebSocketCtor, delays = [250, 800, 1600]) {
    this.url = url
    this.protocols = protocols
    this.RealWebSocket = RealWebSocket
    this.delays = delays
    this.current = this.connect()
  }

  get readyState(): number { return this.state }
  get protocol(): string { return this.current.protocol }
  get bufferedAmount(): number { return this.current.bufferedAmount }
  get binaryType(): BinaryType { return this.type }
  set binaryType(value: BinaryType) {
    this.type = value
    this.current.binaryType = value
  }

  send(data: ArrayBuffer | ArrayBufferView): void {
    this.current.send(data as ArrayBuffer)
  }

  close(): void {
    this.closedByUser = true
    if (this.state === 3) return
    this.state = 2
    this.current.close()
  }

  private connect(): WebSocket {
    const ws = new this.RealWebSocket(this.url, this.protocols)
    ws.binaryType = this.type
    ws.onopen = (event) => {
      if (ws !== this.current) return
      this.opened = true
      this.state = 1
      this.onopen?.(event)
    }
    ws.onmessage = (event) => { if (ws === this.current) this.onmessage?.(event) }
    ws.onerror = (event) => {
      // OPEN 之前的错误先吞掉，等 onclose 决定是否重试；之后的错误照常上报
      if (ws === this.current && this.opened) this.onerror?.(event)
    }
    ws.onclose = (event) => {
      if (ws !== this.current) return
      if (!this.opened && !this.closedByUser && this.attempt < this.delays.length) {
        const delay = this.delays[this.attempt++]
        setTimeout(() => {
          if (this.closedByUser) return this.finish(event)
          this.current = this.connect()
        }, delay)
        return
      }
      if (!this.opened) this.onerror?.(event)
      this.finish(event)
    }
    return ws
  }

  private finish(event: unknown): void {
    if (this.state === 3) return
    this.state = 3
    this.onclose?.(event)
  }
}

/** 中继地址里的目标：…/socket/<token>/(tcp|udp)/<ip>/<port>[/<socketId>/<instanceId>] */
export interface RelayTarget {
  poolUrl: string
  protocol: 'tcp' | 'udp'
  host: string
  port: number
  socketId?: string
}

export function parseRelayUrl(url: string, path: string): RelayTarget | null {
  try {
    const parsed = new URL(url)
    if (!parsed.pathname.startsWith(path)) return null
    const match = parsed.pathname.slice(path.length)
      .match(/^([A-Za-z0-9_-]{32})\/(tcp|udp)\/(\d{1,3}(?:\.\d{1,3}){3})\/(\d{1,5})(?:\/(\d{1,6})\/([a-f0-9]{16}))?$/)
    if (!match) return null
    const [, token, protocol, host, port, socketId, instanceId] = match
    // 连接池按“令牌 + 页面实例”分；TCP 地址里没有实例号，就只能等见过 UDP 地址之后才用池
    const pool = new URL(parsed.href)
    pool.pathname = `${path}${token}/pool/${instanceId ?? ''}`
    return { poolUrl: instanceId ? pool.href : '', protocol: protocol as 'tcp' | 'udp', host, port: Number(port), socketId }
  } catch {
    return null
  }
}

/**
 * 预热好的中继连接池（服务端见 server/src/nds-wfc.js 的 servePool）。
 * 线上每条新 WSS 握手 1.5～3 秒且时有失败，而 DS 的 TCP connect 约 2 秒就放弃 —— NAS 登录因此
 * 反复重来直到 20100。池里的连接已经 OPEN，客体 connect 时只差一条 bind 文本帧。
 */
export class RelayPool {
  private readonly url: string
  private readonly RealWebSocket: WebSocketCtor
  private readonly size: number
  private readonly idle: WebSocket[] = []
  private opening = 0
  private failures = 0
  private lastUse = Date.now()
  private stopped = false

  constructor(url: string, RealWebSocket: WebSocketCtor, size = 3) {
    this.url = url
    this.RealWebSocket = RealWebSocket
    this.size = size
    this.refill()
  }

  take(): WebSocket | null {
    this.lastUse = Date.now()
    let ws = this.idle.shift() ?? null
    while (ws && ws.readyState !== 1) ws = this.idle.shift() ?? null
    this.refill()
    return ws
  }

  stop(): void {
    this.stopped = true
    for (const ws of this.idle.splice(0)) { try { ws.close() } catch { /* 已关闭 */ } }
  }

  private refill(): void {
    // 十分钟没人用就不再补：玩家早就离开 WFC 了，别一直挂着空闲连接
    if (this.stopped || Date.now() - this.lastUse > 10 * 60 * 1000) return
    while (this.idle.length + this.opening < this.size) {
      this.opening++
      let ws: WebSocket
      try {
        ws = new this.RealWebSocket(this.url, 'binary')
      } catch {
        this.opening--
        return
      }
      ws.binaryType = 'arraybuffer'
      let settled = false
      ws.onopen = () => {
        settled = true
        this.opening--
        this.failures = 0
        if (this.stopped) return ws.close()
        this.idle.push(ws)
      }
      ws.onclose = () => {
        const index = this.idle.indexOf(ws)
        if (index >= 0) this.idle.splice(index, 1)
        if (!settled) {
          settled = true
          this.opening--
          // 握手失败：退避后再补，免得网络断开时狂开连接
          this.failures++
          setTimeout(() => this.refill(), Math.min(10_000, 250 * 2 ** this.failures))
          return
        }
        this.refill()
      }
      ws.onerror = () => {}
    }
  }
}

/** 从池里拿到的已 OPEN 连接：先发 bind 文本帧，再像普通 WebSocket 一样把二进制数据交给 SOCKFS。 */
export class PooledSocket implements WebSocketLike {
  readonly CONNECTING = 0 as const
  readonly OPEN = 1 as const
  readonly CLOSING = 2 as const
  readonly CLOSED = 3 as const
  readonly url: string
  readyState = 0
  protocol = 'binary'
  onopen: Listener = null
  onmessage: Listener = null
  onclose: Listener = null
  onerror: Listener = null
  private readonly ws: WebSocket

  constructor(url: string, ws: WebSocket, target: RelayTarget) {
    this.url = url
    this.ws = ws
    ws.binaryType = 'arraybuffer'
    ws.send(JSON.stringify({ protocol: target.protocol, host: target.host, port: target.port, socketId: target.socketId }))
    ws.onmessage = (event) => this.onmessage?.(event)
    ws.onerror = (event) => this.onerror?.(event)
    ws.onclose = (event) => {
      this.readyState = 3
      this.onclose?.(event)
    }
    // SOCKFS 在构造之后才挂 onopen；和真 WebSocket 一样异步宣布 OPEN
    setTimeout(() => {
      if (this.readyState !== 0) return
      this.readyState = 1
      this.onopen?.({ type: 'open' })
    }, 0)
  }

  get bufferedAmount(): number { return this.ws.bufferedAmount }
  get binaryType(): BinaryType { return 'arraybuffer' }
  set binaryType(_value: BinaryType) { /* SOCKFS 只用 arraybuffer */ }

  send(data: ArrayBuffer | ArrayBufferView): void {
    this.ws.send(data as ArrayBuffer)
  }

  close(): void {
    if (this.readyState >= 2) return
    this.readyState = 2
    this.ws.close()
  }
}

/** DNS 节点:53 的中继地址形如 …/udp/<dns-ip>/53/<socketId>/<instanceId> */
export function isDnsRelayUrl(url: string, path: string, server: string): boolean {
  try {
    const parsed = new URL(url)
    return parsed.pathname.startsWith(path) && new RegExp(`/udp/${server.replace(/\./g, '\\.')}/53/`).test(parsed.pathname)
  } catch {
    return false
  }
}

type WfcWindow = { WebSocket: WebSocketCtor & { __8bitgoWfcDns?: { table: NdsWfcDnsTable; path: string } } }

/**
 * 给核心所在窗口换上带 DNS 本地应答的 WebSocket 构造器。只拦 DNS 节点:53 的中继地址，
 * 其余（TCP、NATNEG、EmulatorJS 自己的 netplay）一律原样构造真 WebSocket。重复调用只更新表。
 */
export function installNdsWfcDnsShim(win: WfcWindow, table: NdsWfcDnsTable, path: string, poolUrl?: string): boolean {
  const current = win.WebSocket
  if (typeof current !== 'function') return false
  if (current.__8bitgoWfcDns) {
    current.__8bitgoWfcDns.table = table
    current.__8bitgoWfcDns.path = path
    return true
  }
  const Real = current
  const state = { table, path }
  /*
    开局就预热，不等客体第一次查 DNS：生产实测直连 WSS 握手 1.5～4.9 秒，而 conntest 紧跟在
    第一次 DNS 之后、DS 只等约 2 秒 —— 等 DNS 时才开池，第一条 TCP 一定赶不上（报 52200）。
  */
  let pool: RelayPool | null = poolUrl ? new RelayPool(poolUrl, Real, 4) : null
  /** 走中继的 socket：池里有现成连接就直接绑定，否则新开一条带重试的 WSS */
  const relaySocket = (url: string, protocols?: string | string[]): WebSocket => {
    const target = parseRelayUrl(url, state.path)
    if (target?.poolUrl && !pool) pool = new RelayPool(target.poolUrl, Real, 4)
    const ws = target && pool ? pool.take() : null
    if (target && ws) return new PooledSocket(url, ws, target) as unknown as WebSocket
    return new RetryingWebSocket(url, protocols, Real) as unknown as WebSocket
  }
  const Retrying = function (this: unknown, url: string, protocols?: string | string[]) {
    return relaySocket(url, protocols)
  } as unknown as WebSocketCtor
  const isRelay = (url: string) => {
    try { return new URL(url).pathname.startsWith(state.path) } catch { return false }
  }
  const Shim = function (this: unknown, url: string, protocols?: string | string[]) {
    if (isDnsRelayUrl(url, state.path, state.table.server)) {
      // 客体开始联网的第一个信号：顺手把连接池预热起来，NAS / GP 的 TCP 到时就不必再等握手
      const target = parseRelayUrl(url, state.path)
      if (target?.poolUrl && !pool) pool = new RelayPool(target.poolUrl, Real, 4)
      return new LocalDnsSocket(url, protocols, state.table, Retrying)
    }
    // 只给本站 WFC 中继套重试 / 连接池；EmulatorJS 自己的 netplay 等其它 WebSocket 原样构造
    if (isRelay(url)) return relaySocket(url, protocols)
    return new Real(url, protocols)
  } as unknown as WebSocketCtor & { __8bitgoWfcDns?: typeof state }
  Object.assign(Shim, { CONNECTING: 0, OPEN: 1, CLOSING: 2, CLOSED: 3 })
  Shim.prototype = Real.prototype
  Shim.__8bitgoWfcDns = state
  win.WebSocket = Shim
  return true
}
