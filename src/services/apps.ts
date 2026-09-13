/**
 * 应用中心的前后台接口客户端。
 * 前台只读（按 kind 分好的三组），后台可增删改，社区提交走邮件。
 */
import { api, apiEnabled } from './api'

export type AppKind = 'sdk' | 'app' | 'community'

export interface AppItem {
  id: number
  kind?: AppKind
  name: string
  /** 适用平台，后台自由填（Linux / ESP32 / Windows …） */
  platform: string
  version: string | null
  description: string | null
  /** 外链 URL，或 R2 key（前端用资源域名拼成可下载地址） */
  downloadUrl: string | null
  icon: string | null
  submitterName: string | null
  updatedAt: string | null
}

export interface AppsGroup {
  sdk: AppItem[]
  app: AppItem[]
  community: AppItem[]
}

export interface AppInput {
  kind: AppKind
  name: string
  platform?: string
  version?: string
  description?: string
  downloadUrl?: string
  icon?: string
  /** 排序号越小越靠前 */
  sortOrder?: number
  /** 是否上架（社区条目审核通过再置 1） */
  published?: boolean
  submitterName?: string
  submitterContact?: string
}

export async function fetchApps(): Promise<AppsGroup> {
  if (!apiEnabled()) return { sdk: [], app: [], community: [] }
  return api.get<AppsGroup>('/api/apps')
}

/* ---------------- 后台管理（需要管理员口令） ---------------- */

export async function fetchAdminApps(): Promise<{ items: AppItem[] }> {
  return api.get('/api/admin/apps', true)
}

export async function saveApp(id: number | null, input: AppInput): Promise<{ app: AppItem }> {
  return id === null
    ? api.post<{ app: AppItem }>('/api/admin/apps', input, true)
    : api.patch<{ app: AppItem }>(`/api/admin/apps/${id}`, input, true)
}

export async function deleteApp(id: number): Promise<void> {
  await api.del(`/api/admin/apps/${id}`, true)
}

/* ---------------- 社区自建 APP 提交（发邮件给站长） ---------------- */

export interface CommunitySubmitInput {
  name: string
  platform?: string
  description: string
  link?: string
  contact?: string
}

export async function submitCommunityApp(input: CommunitySubmitInput): Promise<{ ok: boolean }> {
  return api.post('/api/apps/community-submit', input)
}
