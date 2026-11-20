/**
 * SRS 直播间观众的「不开长连接」通道（服务端见 server/src/live.js「不走 socket.io 的 SRS 观众」）。
 *
 * ── 为什么 ──────────────────────────────────────────────────
 * 以前观众进房要先连上 socket.io（新开一条 WebSocket、握手、再 watch），大陆线路上首连 4～8 秒，
 * 而 SRS 房的观众根本用不上双向信令：画面走 WHEP，服务器只需要把弹幕 / 人数 / 主播状态推下来。
 * 同类网站（ggemu）的观众页就是「拿播放票 → WHEP 拉流 → SSE 收弹幕」，没有长连接。
 *
 * 现在进房是一条 POST，**响应体就是这位观众的事件流**：第一帧 `welcome` 带房间快照、播放票和
 * 会话令牌，复用页面已经建好的 HTTP/2 连接，一个往返就能开始 WHEP。换票、催主播、发弹幕各一个小 POST，
 * 会话令牌放在请求体里。
 *
 * ── 为什么不用 EventSource ─────────────────────────────────
 * EventSource 只能 GET、不能带请求头：登录观众的 JWT（成人房年龄门、弹幕署名）只能塞进 URL，
 * 而 URL 会落进访问日志、浏览历史和 Referer（AGENTS.md §2.23 明令禁止）。fetch + ReadableStream
 * 读同一种 text/event-stream，令牌走 Authorization 头。
 *
 * ── 什么时候退回 socket.io ────────────────────────────────
 * 由调用方（emulator/adapters/liveview.ts）决定，这里只把原因分清楚：
 *   · 老的点对点房（409 p2p-room）、老服务端（没有这个接口）、事件流名额满（503）、
 *     浏览器读不了流式响应 —— 退回 socket 照旧能看；
 *   · 房间不存在 / 满员 / 成人房年龄门 —— 换成 socket 结果一样，直接报错。
 */
import { CHAT_ACK_TIMEOUT_MS, chatSendOutcome, sanitizeChatText } from '../../shared/live-chat.js'
import { apiBase, getToken } from './api'

/* ---------------- 纯文本层：SSE 解析（node 测试直接跑它） ---------------- */

/** 单个事件最多攒这么多字节还没收尾，就当对端坏了。正常最大的是 welcome（30 条弹幕 + 名单），远小于它 */
export const SSE_MAX_PENDING_CHARS = 512 * 1024

export interface SseParser {
  /** 喂一段文本（任意切分）；凑出完整事件就回调。超限抛错 */
  push: (chunk: string) => void
}

/**
 * 增量 SSE 解析器，只实现我们用到的那部分规范：`event:`、`data:`（多行拼接）、注释行、
 * 空行收尾；`id:` / `retry:` 忽略。`\r\n` 与 `\n` 都认（Node 只发 `\n`，但沿途代理可能改写）。
 */
export function createSseParser(onEvent: (event: string, data: string) => void): SseParser {
  let buffer = ''
  let eventName = ''
  let dataLines: string[] = []
  let pendingChars = 0
  const dispatch = () => {
    if (dataLines.length || eventName) onEvent(eventName || 'message', dataLines.join('\n'))
    eventName = ''
    dataLines = []
    pendingChars = 0
  }
  return {
    push(chunk: string) {
      buffer += chunk
      let index: number
      while ((index = buffer.indexOf('\n')) >= 0) {
        let line = buffer.slice(0, index)
        buffer = buffer.slice(index + 1)
        if (line.endsWith('\r')) line = line.slice(0, -1)
        if (line === '') {
          dispatch()
          continue
        }
        pendingChars += line.length
        if (pendingChars > SSE_MAX_PENDING_CHARS) throw new Error('event stream frame too large')
        if (line.startsWith(':')) continue
        const colon = line.indexOf(':')
        const field = colon < 0 ? line : line.slice(0, colon)
        let value = colon < 0 ? '' : line.slice(colon + 1)
        if (value.startsWith(' ')) value = value.slice(1)
        if (field === 'event') eventName = value
        else if (field === 'data') dataLines.push(value)
      }
      if (buffer.length + pendingChars > SSE_MAX_PENDING_CHARS) throw new Error('event stream frame too large')
    },
  }
}

/* ---------------- 进房：事件流 ---------------- */

/**
 * 进房失败的原因。`fallback` 为 true 的几种换成 socket.io 还有机会，其余换了也一样，直接报错。
 */
export type LiveStreamFailure =
  | 'room-not-found'
  | 'full'
  | 'adult'
  | 'p2p-room'
  | 'unsupported'
  | 'busy'
  | 'network'
  | 'timeout'

export class LiveStreamRefused extends Error {
  readonly code: LiveStreamFailure
  readonly status: number
  constructor(code: LiveStreamFailure, message: string, status = 0) {
    super(message)
    this.name = 'LiveStreamRefused'
    this.code = code
    this.status = status
  }
  /** 换成 socket.io 还值得一试吗 */
  get fallback(): boolean {
    return this.code === 'p2p-room' || this.code === 'unsupported' || this.code === 'busy' || this.code === 'network' || this.code === 'timeout'
  }
}

/** 按状态码 + 服务端的 code 字段归类（纯函数，测试直接跑） */
export function classifyStreamRefusal(status: number, body: { error?: unknown; code?: unknown } | null): LiveStreamFailure {
  const code = typeof body?.code === 'string' ? body.code : ''
  if (code === 'room-not-found') return 'room-not-found'
  if (code === 'full') return 'full'
  if (code === 'adult') return 'adult'
  if (code === 'p2p-room') return 'p2p-room'
  // 503：事件流总量 / 单 IP 名额满了（sseGuard 的 admitSse），socket 那条路不占这份名额
  if (status === 503 || status === 429) return 'busy'
  // 没有 code 的 404：老服务端没有这个接口（房间不存在时新服务端一定带 room-not-found）
  return 'unsupported'
}

export interface LiveStreamWelcome {
  roomId?: string
  title: string
  hostName: string
  gameName: string
  viewers: number
  transport?: 'p2p' | 'srs'
  srsReady?: boolean
  srsGrant?: string
  hostAway?: boolean
  hostFrozen?: boolean
  netplayRoomId?: string | null
  coopOpen?: boolean
  chat?: unknown[]
  list?: unknown[]
  /** 这次进房顶替了同一把 key 的上一条连接（事件流重连） */
  rebound?: boolean
  session: string
}

export interface LiveStreamConnection {
  readonly welcome: LiveStreamWelcome
  /** 主动关掉；之后不会再回调 onEnd */
  close: () => void
}

export interface LiveStreamHandlers {
  /**
   * welcome 到了。**同步**回调，早于同一个数据块里紧跟着的后续事件 ——
   * 调用方在这里把房间快照应用掉，后面的增量事件才不会被一份更早的快照覆盖。
   */
  onWelcome?: (welcome: LiveStreamWelcome, connection: LiveStreamConnection) => void
  /** welcome 之后的每一个事件（ping 也会来，调用方可以忽略） */
  onEvent: (event: string, data: unknown) => void
  /**
   * 流自己断了（服务端到寿命收尾 / 网络断 / 静默超时）。主动 close() 不会走这里。
   * `replaced`：断之前最后一帧是 replaced —— 同一把 key 的新连接接手了，不该再重连。
   */
  onEnd: (reason: 'closed' | 'error' | 'silent', replaced: boolean) => void
}

/** 等 welcome 的上限。超过就退回 socket（它有自己的预算），别让观众在这里白等 */
export const STREAM_WELCOME_TIMEOUT_MS = 10_000
/** 服务端每 10 秒一帧 ping；这么久一个字节都没有，连接多半被中间设备静默丢了 */
export const STREAM_SILENCE_MS = 25_000

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

function authHeaders(): Record<string, string> {
  const token = getToken()
  return token ? { Authorization: `Bearer ${token}` } : {}
}

function roomPath(roomId: string, action: string): string {
  return `${apiBase()}/api/live/rooms/${encodeURIComponent(roomId)}/${action}`
}

/**
 * 进房并打开事件流。welcome 到了才兑现；失败一律抛 LiveStreamRefused。
 */
export function openLiveStream(
  roomId: string,
  key: string,
  handlers: LiveStreamHandlers,
  opts: { welcomeTimeoutMs?: number; silenceMs?: number; fetchImpl?: typeof fetch } = {},
): Promise<LiveStreamConnection> {
  const fetchImpl = opts.fetchImpl ?? fetch
  const welcomeTimeoutMs = opts.welcomeTimeoutMs ?? STREAM_WELCOME_TIMEOUT_MS
  const silenceMs = opts.silenceMs ?? STREAM_SILENCE_MS
  const controller = new AbortController()

  return new Promise<LiveStreamConnection>((resolve, reject) => {
    /** 0 = 等 welcome，1 = 在流，2 = 已结束（主动关 / 断 / 失败） */
    // 断言成联合类型：phase 在各个回调里被改，别让 TS 按初值把它收窄成 0
    let phase = 0 as 0 | 1 | 2
    let lastByteAt = Date.now()
    let silenceTimer: ReturnType<typeof setInterval> | 0 = 0
    let replaced = false
    let timedOut = false

    const stop = () => {
      if (silenceTimer) clearInterval(silenceTimer)
      silenceTimer = 0
      try {
        controller.abort()
      } catch {
        /* ignore */
      }
    }
    const refuse = (error: LiveStreamRefused) => {
      if (phase !== 0) return
      phase = 2
      clearTimeout(welcomeTimer)
      stop()
      reject(error)
    }
    const end = (reason: 'closed' | 'error' | 'silent') => {
      if (phase !== 1) return
      phase = 2
      stop()
      handlers.onEnd(reason, replaced)
    }

    const welcomeTimer = setTimeout(() => {
      timedOut = true
      refuse(new LiveStreamRefused('timeout', 'live stream welcome timeout'))
    }, welcomeTimeoutMs)

    const connection: LiveStreamConnection = {
      welcome: { title: '', hostName: '', gameName: '', viewers: 0, session: '' },
      close() {
        if (phase === 2) return
        phase = 2
        clearTimeout(welcomeTimer)
        stop()
      },
    }

    const parser = createSseParser((event, raw) => {
      if (phase === 2) return
      const data = parseJson(raw)
      if (phase === 0) {
        const welcome = data as LiveStreamWelcome | null
        if (event !== 'welcome' || !welcome || typeof welcome.session !== 'string' || !welcome.session) {
          refuse(new LiveStreamRefused('unsupported', `unexpected first event: ${event}`))
          return
        }
        phase = 1
        clearTimeout(welcomeTimer)
        ;(connection as { welcome: LiveStreamWelcome }).welcome = welcome
        try {
          handlers.onWelcome?.(welcome, connection)
        } catch (e) {
          console.warn('[live] 处理 welcome 出错：', e)
        }
        // 回调里可能已经主动 close() 了（调用方发现这条已经过时）
        if (phase !== 1) {
          resolve(connection)
          return
        }
        silenceTimer = setInterval(() => {
          // 后台标签页的定时器会被节流，晚到也没关系：比的是「最后一个字节」到现在多久
          if (phase === 1 && Date.now() - lastByteAt > silenceMs) end('silent')
        }, Math.max(1_000, Math.round(silenceMs / 5)))
        resolve(connection)
        return
      }
      if (event === 'replaced') replaced = true
      try {
        handlers.onEvent(event, data)
      } catch (e) {
        // 一个事件处理出错不能把整条流判死（下面的 catch 会当成断线去重连）
        console.warn(`[live] 处理事件 ${event} 出错：`, e)
      }
    })

    void (async () => {
      let response: Response
      try {
        response = await fetchImpl(roomPath(roomId, 'watch'), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream', ...authHeaders() },
          body: JSON.stringify({ key }),
          cache: 'no-store',
          signal: controller.signal,
        })
      } catch (e) {
        if (!timedOut) refuse(new LiveStreamRefused('network', e instanceof Error ? e.message : String(e)))
        return
      }
      const type = response.headers.get('content-type') || ''
      if (!response.ok || !/text\/event-stream/i.test(type)) {
        const body = (await response.json().catch(() => null)) as { error?: unknown; code?: unknown } | null
        // 204（被当成爬虫）/ 200 却不是事件流（某层代理改写了）：都当这条路走不通
        const code = response.ok ? 'unsupported' : classifyStreamRefusal(response.status, body)
        const message = typeof body?.error === 'string' ? body.error : `HTTP ${response.status}`
        refuse(new LiveStreamRefused(code, message, response.status))
        return
      }
      const reader = response.body?.getReader?.()
      if (!reader) {
        // 浏览器读不了流式响应体（很老的 Firefox / WebView）：退回 socket
        refuse(new LiveStreamRefused('unsupported', 'streaming response body not supported', response.status))
        return
      }
      const decoder = new TextDecoder()
      try {
        for (;;) {
          const { done, value } = await reader.read()
          if (phase === 2) return
          if (done) break
          lastByteAt = Date.now()
          parser.push(decoder.decode(value, { stream: true }))
        }
        parser.push(decoder.decode())
      } catch (e) {
        if (phase === 0) refuse(new LiveStreamRefused(timedOut ? 'timeout' : 'network', e instanceof Error ? e.message : String(e)))
        else end('error')
        return
      }
      if (phase === 0) refuse(new LiveStreamRefused('network', 'event stream ended before welcome'))
      else end('closed')
    })()
  })
}

/* ---------------- 进房之后的几个小请求 ---------------- */

/** 小请求失败。status 0 = 网络 / 超时；404 = 会话不认了（流断了、被当成离房），要重新进房 */
export class LiveStreamCallError extends Error {
  readonly status: number
  constructor(message: string, status: number) {
    super(message)
    this.name = 'LiveStreamCallError'
    this.status = status
  }
}

async function postSession(
  roomId: string,
  action: 'grant' | 'nudge' | 'chat',
  body: Record<string, unknown>,
  timeoutMs: number,
  fetchImpl: typeof fetch,
): Promise<{ status: number; data: Record<string, unknown> | null }> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetchImpl(roomPath(roomId, action), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json', ...(action === 'chat' ? authHeaders() : {}) },
      body: JSON.stringify(body),
      cache: 'no-store',
      signal: controller.signal,
    })
    const data = response.status === 204 ? null : ((await response.json().catch(() => null)) as Record<string, unknown> | null)
    return { status: response.status, data }
  } catch (e) {
    throw new LiveStreamCallError(e instanceof Error ? e.message : String(e), 0)
  } finally {
    clearTimeout(timer)
  }
}

/** 续一张 SRS 播放票（拉流断了要重拉时用，不惊动主播） */
export async function liveStreamGrant(
  roomId: string,
  session: string,
  fetchImpl: typeof fetch = fetch,
): Promise<{ srsGrant: string; srsReady: boolean }> {
  const { status, data } = await postSession(roomId, 'grant', { session }, 5_000, fetchImpl)
  if (status !== 200 || typeof data?.srsGrant !== 'string') {
    throw new LiveStreamCallError(typeof data?.error === 'string' ? data.error : `HTTP ${status}`, status)
  }
  return { srsGrant: data.srsGrant, srsReady: Boolean(data.srsReady) }
}

/** 催主播检查一下自己的上行（等同 socket 观众「重新 watch 一次」，但不让主播重建任何连接）。返回状态码 */
export async function liveStreamNudge(roomId: string, session: string, fetchImpl: typeof fetch = fetch): Promise<number> {
  const { status } = await postSession(roomId, 'nudge', { session }, 5_000, fetchImpl)
  return status
}

/**
 * 发一条弹幕。和 sendChatWithAck 同一套结果：null 发出去了、'too-fast' 被限流、'dropped' 没发出去。
 * **永不抛异常**（调用方是个输入框）。署名跟着这一次请求的登录令牌走，中途登录 / 退出立刻生效。
 */
export async function liveStreamChat(
  roomId: string,
  session: string,
  text: string,
  fetchImpl: typeof fetch = fetch,
): Promise<'too-fast' | 'dropped' | null> {
  const clean = sanitizeChatText(text)
  if (!clean || !session) return 'dropped'
  try {
    const { status, data } = await postSession(roomId, 'chat', { session, text: clean }, CHAT_ACK_TIMEOUT_MS, fetchImpl)
    if (status !== 200) return 'dropped'
    if (typeof data?.id === 'string') return null
    return chatSendOutcome(data?.error ?? 'failed')
  } catch {
    return 'dropped'
  }
}
