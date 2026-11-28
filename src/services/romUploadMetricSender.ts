import { api, apiEnabled } from './api'

/** 放在单独动态块里，避免管理端上传统计进入玩家游戏启动的静态依赖图。 */
export function sendRomUploadMetric(payload: unknown): Promise<unknown> | undefined {
  if (!apiEnabled()) return undefined
  return api.post('/api/admin/rom-upload-metrics', payload, true, 8_000)
}
