/**
 * DS 的 WFC 与 EmulatorJS 的“远程手柄联机”无关。浏览器不能直接创建 TCP/UDP socket，
 * melonDS DS 的 SOCKFS 必须在创建每条连接时拿到一个同源 WSS 地址，让本站后端转发。
 */

import { installNdsWfcDnsShim, sanitizeDnsTable, type NdsWfcDnsTable } from './ndsWfcDns'

export interface NdsWfcSession {
  token: string
  path: string
  instanceId: string
  /** 服务端预解析好的 WFC 名字；有它时 DNS 在浏览器本地作答，见 ndsWfcDns.ts */
  dns?: NdsWfcDnsTable | null
}

let pageInstanceId: string | null = null
let browserMacAddress: string | null = null
function wfcPageInstanceId(): string {
  if (pageInstanceId) return pageInstanceId
  const bytes = new Uint8Array(8)
  if (typeof window !== 'undefined' && window.crypto?.getRandomValues) window.crypto.getRandomValues(bytes)
  else for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256)
  // sessionStorage 在“复制标签页”时会被克隆；页内随机 ID 才能隔离两台同时玩的虚拟 DS。
  pageInstanceId = Array.from(bytes, (value) => value.toString(16).padStart(2, '0')).join('')
  return pageInstanceId
}

/** 本地 ROM 没有数据库 slug；只认同款游戏的美版与欧版卡带代码，避免别的游戏误接专用出口。 */
export function isWorldAtWarNdsRomHeader(bytes: Uint8Array): boolean {
  if (bytes.length < 16 || String.fromCharCode(...bytes.subarray(0, 11)) !== 'CALLOFDUTY5') return false
  return ['CALE', 'CALP'].includes(String.fromCharCode(...bytes.subarray(12, 16)))
}

export function ndsWfcSocketUrl(origin: string, session: NdsWfcSession, host: string, port: number, type: number, socketName?: string): string {
  if (!/^[A-Za-z0-9_-]{32}$/.test(session.token)) throw new Error('WFC 会话令牌无效')
  if (session.path !== '/api/nds-wfc/socket/') throw new Error('WFC 转发路径无效')
  if (!/^[a-f0-9]{16}$/.test(session.instanceId)) throw new Error('WFC 页面身份无效')
  if (!/^\d{1,3}(?:\.\d{1,3}){3}$/.test(host) || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('WFC 目标地址无效')
  }
  const protocol = type === 1 ? 'tcp' : type === 2 ? 'udp' : null
  if (!protocol) throw new Error('WFC socket 类型无效')
  // libslirp 会复用同一个 UDP socket 联系多个 NATNEG 目标；给中继带上 Emscripten 的 socket 编号，
  // 否则每条 WebSocket 都分配新公网端口，服务端看到的玩家端口会在握手中途变化。
  const socketId = protocol === 'udp' ? /^socket\[(\d{1,6})\]$/.exec(socketName || '')?.[1] : null
  if (protocol === 'udp' && !socketId) throw new Error('WFC UDP socket 身份无效')
  const base = new URL(origin)
  if (!['http:', 'https:'].includes(base.protocol)) throw new Error('WFC 只支持网页同源连接')
  base.protocol = base.protocol === 'https:' ? 'wss:' : 'ws:'
  base.pathname = `${session.path}${session.token}/${protocol}/${host}/${port}${socketId ? `/${socketId}/${session.instanceId}` : ''}`
  base.search = ''
  base.hash = ''
  return base.href
}

function wfcClientId(): string | null {
  if (typeof window === 'undefined' || !window.crypto?.getRandomValues) return null
  const key = '8bitgo:nds-wfc-client-id'
  try {
    const existing = window.sessionStorage.getItem(key)
    if (existing && /^[a-f0-9]{32}$/.test(existing)) return existing
  } catch { /* 隔离 iframe / 无痕模式可能禁用 sessionStorage，联机仍应尝试 */ }
  const bytes = window.crypto.getRandomValues(new Uint8Array(16))
  const id = Array.from(bytes, (value) => value.toString(16).padStart(2, '0')).join('')
  try { window.sessionStorage.setItem(key, id) } catch { /* 不持久化时退化为本次页面会话 */ }
  return id
}

/**
 * melonDS 内置固件的默认 MAC 对所有访客相同；WFC 只在每个浏览器有稳定独立的地址时才安全启用。
 *
 * OUI 用任天堂的 00:09:BF（和真 DS、melonDS 单机版多开时的做法一致），只随机后三字节。
 * v1 曾用 00:08:BF —— 那不是任天堂的厂商前缀，NAS 登录会把 macadr 原样报给服务器，
 * 不能让站内所有玩家都带着一个“非 DS 网卡”的标记去登录。v1 还没正式上线，直接换代。
 */
export function ndsWfcMacAddress(win: Pick<Window, 'localStorage' | 'crypto'> = window): string | null {
  if (browserMacAddress) return browserMacAddress
  const key = '8bitgo:nds-wfc-mac-v2'
  try {
    const existing = win.localStorage.getItem(key)
    if (existing && /^00:09:bf(?::[a-f0-9]{2}){3}$/i.test(existing) && existing.toLowerCase() !== '00:09:bf:11:22:33') {
      browserMacAddress = existing.toLowerCase()
      return browserMacAddress
    }
  } catch { /* 存储受限时继续生成本次页面地址，不能阻断单机游戏 */ }
  if (!win.crypto?.getRandomValues) return null
  const bytes = win.crypto.getRandomValues(new Uint8Array(3))
  // melonDS 的出厂默认 00:09:BF:11:22:33 是全员共享的那个，抽中了就换一个后缀
  if (bytes[0] === 0x11 && bytes[1] === 0x22 && bytes[2] === 0x33) bytes[2] ^= 0xff
  const suffix = Array.from(bytes, (value) => value.toString(16).padStart(2, '0')).join(':')
  browserMacAddress = `00:09:bf:${suffix}`
  try { win.localStorage.setItem(key, browserMacAddress) } catch { /* 无痕模式可用本页地址，但重新打开后会变 */ }
  return browserMacAddress
}

/**
 * 内置固件的 WFC 设置（WFC 用户 ID、连接档）按“这台虚拟 DS 的网卡地址”存在本浏览器。
 *
 * 真 DS 把它写在固件闪存里，换卡带、关机都不会丢；网页端 system 目录在内存里，不存的话
 * 每次刷新游戏都会以全新的 WFC 用户 ID 去 NAS 建号，而卡带存档里记的是上一次的 GameSpy
 * 档案 —— 两边对不上，好友码每局都变，登录还可能被 GameSpy 拒绝。
 */
const WFC_SETTINGS_KEY = '8bitgo:nds-wfc-settings-v1:'

export function loadNdsWfcSettings(mac: string, size: number, storage: Pick<Storage, 'getItem'> = window.localStorage): Uint8Array | null {
  try {
    const raw = storage.getItem(WFC_SETTINGS_KEY + mac.toLowerCase())
    if (!raw) return null
    const binary = atob(raw)
    if (binary.length !== size) return null
    const bytes = new Uint8Array(size)
    for (let i = 0; i < size; i++) bytes[i] = binary.charCodeAt(i)
    return bytes
  } catch {
    return null
  }
}

export function saveNdsWfcSettings(mac: string, bytes: Uint8Array, size: number, storage: Pick<Storage, 'setItem'> = window.localStorage): boolean {
  if (bytes.length !== size) return false
  // 全 0 / 全 FF 是固件还没初始化的样子，存下来只会把下次的默认值也盖掉
  if (bytes.every((value) => value === 0) || bytes.every((value) => value === 0xff)) return false
  try {
    let binary = ''
    for (const value of bytes) binary += String.fromCharCode(value)
    storage.setItem(WFC_SETTINGS_KEY + mac.toLowerCase(), btoa(binary))
    return true
  } catch {
    return false
  }
}

export async function prepareNdsWfcSession(gameSlug: string, signal?: AbortSignal): Promise<NdsWfcSession | null> {
  if (gameSlug !== 'call-of-duty-world-at-war') return null
  // 某些仍能运行 EmulatorJS 的浏览器没有 AbortSignal.any/timeout；这里用基础 API 避免联机选项拖垮单机。
  const controller = new AbortController()
  const abort = () => controller.abort()
  const timer = setTimeout(abort, 4_000)
  if (signal?.aborted) abort()
  else signal?.addEventListener('abort', abort, { once: true })
  try {
    const response = await fetch('/api/nds-wfc/session', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ gameSlug, clientId: wfcClientId() }),
      signal: controller.signal,
    })
    if (!response.ok) return null
    const body: unknown = await response.json()
    if (!body || typeof body !== 'object') return null
    const session = body as Partial<NdsWfcSession> & { dns?: unknown }
    return typeof session.token === 'string' && typeof session.path === 'string' &&
      /^[A-Za-z0-9_-]{32}$/.test(session.token) && session.path === '/api/nds-wfc/socket/'
      ? { token: session.token, path: session.path, instanceId: wfcPageInstanceId(), dns: sanitizeDnsTable(session.dns) }
      : null
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener('abort', abort)
  }
}

interface RuntimeWindow extends Record<string, unknown> {
  EJS_Runtime?: (config: Record<string, unknown>) => unknown
}

type WfcRuntime = ((config: Record<string, unknown>) => unknown) & {
  __8bitgoWfc?: { session: NdsWfcSession; origin: string }
}

interface SockfsSocket {
  type?: number
  recv_queue?: unknown[]
  sock_ops?: SockfsSocketOps
}

interface SockfsSocketOps {
  poll?: (sock: SockfsSocket, ...rest: unknown[]) => number
  __8bitgoDgramPoll?: boolean
}

interface SockfsModule {
  FS?: { streams?: Array<{ node?: { name?: string; sock?: SockfsSocket } } | null | undefined> }
}

const SOCK_DGRAM = 2
const POLL_READABLE = 0x001 | 0x040 // POLLIN | POLLRDNORM

/**
 * Emscripten SOCKFS 的 poll 对 UDP socket 永远报“可读”（UDP 没有 peer，`!dest` 恒为真）。
 * libslirp 每次 poll 到“可读”就 recvfrom，拿到 EAGAIN 后当成真实错误，给客体回一个
 * ICMP 端口不可达。melonDS 每毫秒左右 poll 一次，DNS / 可用性检查的 UDP socket 一开就是
 * 每秒上千个 ICMP 帧：melonDS 只有 32KB 的接收环形缓冲，满了就丢最早的帧，TCP 的 SYN-ACK
 * 和服务端数据被挤掉 —— NAS(443) 一直等不到握手完成报 20100，GP 的挑战包留在 SOCKFS
 * 队列里没人读、登录超时报 61020。线上实测：修正后 NAS / GP 登录一次通过。
 *
 * 修法：UDP socket 只有队列里真有数据时才报可读。sock_ops 是所有 socket 共用的一个对象，
 * 只需要包一次；已经发布的核心不用重新编译。
 */
export function fixSockfsDgramPoll(sock: SockfsSocket | undefined): boolean {
  const ops = sock?.sock_ops
  if (!ops || typeof ops.poll !== 'function' || ops.__8bitgoDgramPoll) return false
  const poll = ops.poll
  ops.poll = function (this: unknown, target: SockfsSocket, ...rest: unknown[]) {
    const mask = Reflect.apply(poll, this, [target, ...rest]) as number
    return target?.type === SOCK_DGRAM && !target.recv_queue?.length ? mask & ~POLL_READABLE : mask
  }
  ops.__8bitgoDgramPoll = true
  return true
}

function fixModuleSockfsPoll(module: SockfsModule, socketName: string | undefined): boolean {
  if (!socketName) return false
  const streams = module.FS?.streams
  if (!Array.isArray(streams)) return false
  for (const stream of streams) {
    if (stream?.node?.name === socketName && stream.node.sock) return fixSockfsDgramPoll(stream.node.sock) || true
  }
  return false
}

/** 只包一次核心工厂；同一 iframe 重开游戏时更新令牌，不能继续拿已失效的旧会话。 */
export function installNdsWfcRuntime(win: RuntimeWindow, session: NdsWfcSession, origin: string): boolean {
  const original = win.EJS_Runtime as WfcRuntime | undefined
  if (typeof original !== 'function') return false
  const state = original.__8bitgoWfc ?? { session, origin }
  state.session = session
  state.origin = origin
  const poolUrlFor = (value: NdsWfcSession, baseOrigin: string) => {
    const pool = new URL(baseOrigin)
    pool.protocol = pool.protocol === 'https:' ? 'wss:' : 'ws:'
    pool.pathname = `${value.path}${value.token}/pool/${value.instanceId}`
    pool.search = ''
    pool.hash = ''
    return pool.href
  }
  const recoverSession = async () => {
    // WebSocket 握手失败没有可读的 HTTP 状态码；同一 clientId 重取会话可区分普通抖动与服务重启，
    // 后端还活着时续用原令牌，内存会话丢失时则创建新令牌并恢复本地 DNS 快照。
    const renewed = await prepareNdsWfcSession('call-of-duty-world-at-war')
    if (!renewed) return null
    state.session = renewed
    state.origin = origin
    return {
      table: renewed.dns ?? { server: '178.62.43.212', answers: {} },
      poolUrl: poolUrlFor(renewed, origin),
    }
  }
  // 核心和 SOCKFS 跑在这个窗口里：DNS 节点:53 的 socket 换成本地应答，其余仍是真 WebSocket。
  // 没有预解析表时也要装：中继 socket 的握手重试同样走这个构造器，DNS 则全部转发给中继。
  if (typeof win.WebSocket === 'function') {
    installNdsWfcDnsShim(win as unknown as Parameters<typeof installNdsWfcDnsShim>[0],
      session.dns ?? { server: '178.62.43.212', answers: {} }, session.path, poolUrlFor(session, origin), recoverSession)
  }
  if (original.__8bitgoWfc) {
    return true
  }
  let tracedSockets = 0
  const wrapped: WfcRuntime = function (this: unknown, config) {
    // 服务器重启后池会异步换令牌；同一局之后新建的 SOCKFS socket 也必须读到刷新后的会话。
    // MODULARIZE 的核心直接把这个对象当 Module 用，FS 之后会挂到它上面
    let pollFixed = false
    const moduleConfig: Record<string, unknown> & SockfsModule = {
      ...config,
      wfcTrace: Boolean(import.meta.env?.DEV),
      websocket: {
        url: (host: string, port: number, type: number, socketName?: string) => {
          if (import.meta.env?.DEV && tracedSockets++ < 20) console.info('[nds-wfc] socket', type === 1 ? 'tcp' : 'udp', host, port)
          // 第一条 socket 建连时修 SOCKFS 的 UDP poll；早于 libslirp 第一次 poll 这条 socket
          if (!pollFixed) pollFixed = fixModuleSockfsPoll(moduleConfig, socketName)
          return ndsWfcSocketUrl(state.origin, state.session, host, port, type, socketName)
        },
        subprotocol: 'binary',
      },
    }
    return Reflect.apply(original, this, [moduleConfig])
  }
  wrapped.__8bitgoWfc = state
  win.EJS_Runtime = wrapped
  return true
}
