import type { PlatformId } from '@/types'
import type { RuntimeId } from '@/emulator/types'
import { apiBase, apiEnabled } from './api'
import { collectStartupDiagnostics, noteStartupEvent, type StartupDiagnostics } from './startupDiagnostics'

export type StartupEventName =
  | 'detail_view'
  | 'start_click'
  | 'download_complete'
  | 'rom_load_start'
  | 'rom_load_complete'
  | 'core_warm_start'
  | 'core_warm_complete'
  | 'core_cache_hit'
  | 'fallback_started'
  | 'fallback_first_frame'
  | 'fallback_playable'
  /** 旧版事件曾在首帧触发；保留接收能力，但新版不再发送。 */
  | 'fallback_succeeded'
  | 'fallback_failed'
  | 'runtime_ready'
  | 'iframe_loaded'
  | 'first_frame'
  | 'game_playable'
  | 'first_interaction'
  | 'slow_start'
  | 'readiness_unobservable'
  | 'failed'
  | 'timeout'
  /** 详情页崩溃、自动刷新后好了（services/pageRecovery.ts）：漏斗不算失败，诊断页单独一组 */
  | 'recovered'

export interface StartupEvent {
  visitId: string
  attemptId?: string
  event: StartupEventName
  /** `page`：详情页还没到模拟器就渲染崩溃了（AppErrorBoundary 上报） */
  runtime?: RuntimeId | 'page' | ''
  platform?: PlatformId | ''
  elapsedMs?: number
  detail?: string
  /** 只在失败 / 超时 / 慢启动时附带，见 startupDiagnostics.ts */
  diagnostics?: StartupDiagnostics
}

/**
 * ID 只用于把同一页 / 同一次启动的阶段串起来，不写 cookie，也不跨页面持久化。
 * fallback 保留 128 bit 随机量；旧浏览器没有 randomUUID 时也不会退化成时间戳指纹。
 */
export function newStartupId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID()
  const bytes = new Uint8Array(16)
  if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') crypto.getRandomValues(bytes)
  else for (let i = 0; i < bytes.length; i += 1) bytes[i] = Math.floor(Math.random() * 256)
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')
}

const sent = new Set<string>()
/** 出问题的这几种才附诊断包；正常开局不多发任何东西 */
const DIAGNOSTIC_EVENTS = new Set<StartupEventName>(['failed', 'timeout', 'slow_start', 'recovered'])
/** 高频阶段可以等到首帧一起上报；异常和超时仍走原来的单事件诊断路径。 */
const BATCHABLE_EVENTS = new Set<StartupEventName>([
  'download_complete', 'rom_load_start', 'rom_load_complete', 'core_warm_start', 'core_warm_complete',
  'core_cache_hit', 'runtime_ready', 'first_frame', 'fallback_first_frame', 'fallback_playable', 'game_playable',
])

/**
 * 漏斗永远不能卡住游戏本身。客户端只做会话内去重并异步上报；网络失败不弹提示，
 * 服务端还有 (visit, attempt, event) 唯一键挡住浏览器 / 代理的请求重放。
 */
export function recordStartupEvent(slug: string | undefined, payload: StartupEvent): void {
  if (!slug || !apiEnabled()) return
  const key = `${slug}:${payload.visitId}:${payload.attemptId ?? ''}:${payload.event}`
  if (sent.has(key)) return
  sent.add(key)
  noteStartupEvent(payload.visitId, payload.attemptId, payload.event)
  if (DIAGNOSTIC_EVENTS.has(payload.event) && !payload.diagnostics) {
    const diagnostics = collectStartupDiagnostics(payload.attemptId, payload.detail, {
      resourcesSincePageStart: payload.runtime === 'page',
    })
    if (diagnostics) payload = { ...payload, diagnostics }
  }
  void fetch(`${apiBase()}/api/games/${encodeURIComponent(slug)}/startup`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(payload),
    // PS2 / Dolphin 会从详情页整页跳到隔离播放器；不用 keepalive 的话，点击事件会在导航时被取消。
    keepalive: true,
  }).then((response) => {
    if (!response.ok) throw new Error(`startup metric ${response.status}`)
  }).catch(() => {
    // 临时断网后允许同一生命周期回调再补报；数据库唯一键保证成功过的不会重复。
    sent.delete(key)
  })
}

/** 同一次开局的阶段与首帧合并成一条请求，避免观测本身增加多次同域往返。 */
export function recordStartupEvents(slug: string | undefined, payloads: readonly StartupEvent[]): void {
  if (!slug || !apiEnabled() || payloads.length < 2) {
    for (const payload of payloads) recordStartupEvent(slug, payload)
    return
  }

  const batch: StartupEvent[] = []
  const keys: string[] = []
  const withinBatch = new Set<string>()
  for (const payload of payloads) {
    if (!BATCHABLE_EVENTS.has(payload.event) || DIAGNOSTIC_EVENTS.has(payload.event) || payload.diagnostics) {
      recordStartupEvent(slug, payload)
      continue
    }
    const key = `${slug}:${payload.visitId}:${payload.attemptId ?? ''}:${payload.event}`
    if (sent.has(key) || withinBatch.has(key)) continue
    withinBatch.add(key)
    batch.push(payload)
    keys.push(key)
  }
  if (batch.length < 2) {
    for (const payload of batch) recordStartupEvent(slug, payload)
    return
  }
  for (const payload of batch) {
    const key = `${slug}:${payload.visitId}:${payload.attemptId ?? ''}:${payload.event}`
    sent.add(key)
    noteStartupEvent(payload.visitId, payload.attemptId, payload.event)
  }
  void fetch(`${apiBase()}/api/games/${encodeURIComponent(slug)}/startup`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ events: batch }),
    keepalive: true,
  }).then((response) => {
    if (!response.ok) throw new Error(`startup metric batch ${response.status}`)
  }).catch(() => {
    // 批次网络失败时允许后续同阶段回调重投；服务端 INSERT IGNORE 按事件去重。
    for (const key of keys) sent.delete(key)
  })
}
