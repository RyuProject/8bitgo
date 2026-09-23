import { apiBase, apiEnabled } from './api'
import { isSfsGame } from '../../shared/sfs-games.js'

interface SocketProxyEntry {
  host: string
  port: number
  proxyUrl: string
}

interface SfsClientConfig {
  enabled?: boolean
  ruffle?: {
    socketProxy?: SocketProxyEntry[]
    urlRewriteRules?: [string, string][]
  }
}

/**
 * 成功配置可以多用一会儿；「没开」和「请求失败」必须很快重试。
 *
 * 这里以前把第一次请求的 Promise 永久缓存：迁机后 sidecar 晚几秒启动、Cloudflare 短暂 502，
 * 甚至只是 1.5 秒超时，都会让这个标签页之后打开的所有 SAS3 都永远没有联机，只有整页刷新能救。
 */
const SUCCESS_TTL_MS = 5 * 60_000
const DISABLED_TTL_MS = 30_000
const FAILURE_TTL_MS = 5_000

let cached: { value: Record<string, unknown>; expiresAt: number } | null = null
let inFlight: Promise<Record<string, unknown>> | null = null
let generation = 0

function validProxy(entry: unknown): entry is SocketProxyEntry {
  if (!entry || typeof entry !== 'object') return false
  const item = entry as Partial<SocketProxyEntry>
  if (typeof item.host !== 'string' || !item.host || !Number.isInteger(item.port)) return false
  if (typeof item.proxyUrl !== 'string') return false
  try {
    const url = new URL(item.proxyUrl)
    return (url.protocol === 'ws:' || url.protocol === 'wss:') && item.port! > 0 && item.port! <= 65535
  } catch {
    return false
  }
}

function normalize(input: SfsClientConfig): Record<string, unknown> {
  if (!input.enabled || !input.ruffle) return {}
  const socketProxy = Array.isArray(input.ruffle.socketProxy)
    ? input.ruffle.socketProxy.filter(validProxy).slice(0, 8)
    : []
  if (!socketProxy.length) return {}

  const result: Record<string, unknown> = { socketProxy }
  const rules = Array.isArray(input.ruffle.urlRewriteRules)
    ? input.ruffle.urlRewriteRules.filter(
      (rule): rule is [string, string] => Array.isArray(rule) && rule.length === 2 && rule.every((part) => typeof part === 'string'),
    ).slice(0, 8)
    : []
  if (rules.length) result.urlRewriteRules = rules
  return result
}

/**
 * 配置从后端现取而不是写进 Vite 产物：运维可以单独开关 Java sidecar，不必重新构建前端。
 * 请求失败只返回空配置，Ruffle 仍照常启动单机内容；1.5 秒上限避免旁路故障拖住游戏加载。
 */
export function prepareSfsRuffleConfig(gameSlug?: string): Promise<Record<string, unknown>> {
  // 这份配置只服务 SmartFoxServer 游戏。让其它 Flash 也请求它，旁路故障时会把全站
  // 每款游戏的冷启动都拖住 1.5 秒，而且得到的 socketProxy 对它们没有任何用途。
  if (!isSfsGame(gameSlug)) return Promise.resolve({})
  if (!apiEnabled()) return Promise.resolve({})
  const now = Date.now()
  if (cached && now < cached.expiresAt) return Promise.resolve(cached.value)
  if (inFlight) return inFlight

  const currentGeneration = generation
  let request: Promise<Record<string, unknown>> | null = null
  request = (async () => {
    const aborter = new AbortController()
    const timer = window.setTimeout(() => aborter.abort(), 1500)
    try {
      /*
        no-store 是主防线；时间桶再防一层迁机时遗留的 Cloudflare Cache Everything 规则。
        桶只在缓存过期后变化，不会把每一次挂载都变成新 URL。
      */
      const bucket = Math.floor(Date.now() / DISABLED_TTL_MS)
      const response = await fetch(`${apiBase()}/api/sfs/config?_=${bucket}`, {
        cache: 'no-store',
        headers: { Accept: 'application/json' },
        signal: aborter.signal,
      })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      const value = normalize(await response.json() as SfsClientConfig)
      if (currentGeneration === generation) {
        cached = {
          value,
          expiresAt: Date.now() + (Object.keys(value).length ? SUCCESS_TTL_MS : DISABLED_TTL_MS),
        }
      }
      return value
    } catch (error) {
      console.warn('[sfs] 未取得联机配置，Flash 单机模式继续：', error)
      if (currentGeneration === generation) cached = { value: {}, expiresAt: Date.now() + FAILURE_TTL_MS }
      return {}
    } finally {
      window.clearTimeout(timer)
      // invalidate 之后可能已经起了新请求，迟到的旧请求不能把新请求的去重句柄清掉。
      if (request && inFlight === request) inFlight = null
    }
  })()
  inFlight = request
  return request
}

/** 运维切换 sidecar 或测试故障恢复时可以立即作废；下一款 Flash 会重新读取运行时配置。 */
export function invalidateSfsRuffleConfig(): void {
  generation++
  cached = null
  inFlight = null
}
