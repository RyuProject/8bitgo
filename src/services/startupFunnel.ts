import type { PlatformId } from '@/types'
import type { RuntimeId } from '@/emulator/types'
import { apiBase, apiEnabled } from './api'

export type StartupEventName =
  | 'detail_view'
  | 'start_click'
  | 'download_complete'
  | 'iframe_loaded'
  | 'first_frame'
  | 'game_playable'
  | 'first_interaction'
  | 'slow_start'
  | 'failed'
  | 'timeout'

export interface StartupEvent {
  visitId: string
  attemptId?: string
  event: StartupEventName
  runtime?: RuntimeId | ''
  platform?: PlatformId | ''
  elapsedMs?: number
  detail?: string
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

/**
 * 漏斗永远不能卡住游戏本身。客户端只做会话内去重并异步上报；网络失败不弹提示，
 * 服务端还有 (visit, attempt, event) 唯一键挡住浏览器 / 代理的请求重放。
 */
export function recordStartupEvent(slug: string | undefined, payload: StartupEvent): void {
  if (!slug || !apiEnabled()) return
  const key = `${slug}:${payload.visitId}:${payload.attemptId ?? ''}:${payload.event}`
  if (sent.has(key)) return
  sent.add(key)
  void fetch(`${apiBase()}/api/games/${encodeURIComponent(slug)}/startup`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(payload),
    // PSP / Dolphin 会从详情页整页跳到隔离播放器；不用 keepalive 的话，点击事件会在导航时被取消。
    keepalive: true,
  }).then((response) => {
    if (!response.ok) throw new Error(`startup metric ${response.status}`)
  }).catch(() => {
    // 临时断网后允许同一生命周期回调再补报；数据库唯一键保证成功过的不会重复。
    sent.delete(key)
  })
}
