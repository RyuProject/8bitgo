/**
 * 后台「当前生效配置」那一页的数据。**只读** —— 服务端没有对应的写接口，
 * 而且不该有（理由见 server/src/config-manifest.js 的文件头）。
 */
import { api } from './api'

export type ConfigCheckLevel = 'danger' | 'warn' | 'info'

export type ConfigCheck = {
  id: string
  level: ConfigCheckLevel
  title: string
  detail: string
}

export type ConfigItem = {
  name: string
  /** secret 的**值永远不会下发**，只有 length / fingerprint */
  kind: 'secret' | 'config'
  /** 相对 server/src 的读取位置 */
  file: string
  note?: string
  /** env = 这台机器的 .env 里真的写了；default = 没写，走代码内置默认值 */
  source: 'env' | 'default'
  value?: string
  length?: number
  fingerprint?: string
}

export type ConfigReport = {
  groups: Array<{ group: string; items: ConfigItem[] }>
  counts: { total: number; set: number; default: number; secret: number }
  checks: ConfigCheck[]
  digest: string
  uptimeSec: number
  nodeVersion: string
  generatedAt: string
}

export function fetchSiteConfig(): Promise<ConfigReport> {
  return api.get('/api/admin/config', true)
}
