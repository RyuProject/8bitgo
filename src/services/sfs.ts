import { apiBase, apiEnabled } from './api'

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

let cached: Promise<Record<string, unknown>> | null = null

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
export function prepareSfsRuffleConfig(): Promise<Record<string, unknown>> {
  if (!apiEnabled()) return Promise.resolve({})
  if (cached) return cached

  cached = (async () => {
    const aborter = new AbortController()
    const timer = window.setTimeout(() => aborter.abort(), 1500)
    try {
      const response = await fetch(`${apiBase()}/api/sfs/config`, {
        cache: 'no-store',
        headers: { Accept: 'application/json' },
        signal: aborter.signal,
      })
      if (!response.ok) return {}
      return normalize(await response.json() as SfsClientConfig)
    } catch (error) {
      console.warn('[sfs] 未取得联机配置，Flash 单机模式继续：', error)
      return {}
    } finally {
      window.clearTimeout(timer)
    }
  })()
  return cached
}

