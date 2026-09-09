/** 首页「特别鸣谢」友情链接的后台读写。 */
import { api, apiEnabled } from './api'

export interface FriendLink {
  id: number
  name: string
  url: string
  /** 对象存储 key、站内路径或完整 URL；空串表示文字友链 */
  image: string
  sortOrder: number
  enabled: boolean
}

export type FriendLinkInput = Omit<FriendLink, 'id'>

export async function fetchFriendLinks(): Promise<FriendLink[]> {
  if (!apiEnabled()) return []
  const result = await api.get<FriendLink[]>('/api/friend-links', true)
  return Array.isArray(result) ? result : []
}

export async function saveFriendLink(id: number | null, input: FriendLinkInput): Promise<FriendLink> {
  return id === null
    ? api.post<FriendLink>('/api/friend-links', input, true)
    : api.put<FriendLink>(`/api/friend-links/${id}`, input, true)
}

export async function deleteFriendLink(id: number): Promise<void> {
  await api.del(`/api/friend-links/${id}`, true)
}
