/**
 * 博客文章。
 *
 * v1 把全部文章塞进一个 localStorage store，前台从里面过滤。
 * v2 改成按路由取数：文章数量级小（几十到几百），后端 /api/page?path=/blog
 * 一次给全已发布的，前台在这份列表里找就行，不用再为单篇文章多打一次请求。
 *
 * 后台仍然需要「含草稿的全量列表」，那条路带 library=mine：管理员读主库，
 * 志愿者只读自己的独立库（见 adminPosts）。
 */
import type { Post } from '@/types'
import { api, apiEnabled } from './api'
import { usePageData, type BlogData } from './pageData'

const byDateDesc = (a: Post, b: Post) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0)

/** 前台：已发布的文章（后端已经按日期倒序，这里再排一次保证稳定） */
export function usePublishedPosts(): { posts: Post[]; loading: boolean; error?: string; retry?: () => void } {
  const state = usePageData<BlogData>('/blog', undefined, 'blog')
  return {
    posts: [...(state.data?.posts ?? [])].sort(byDateDesc),
    loading: state.status === 'loading',
    error: state.status === 'error' ? state.error : undefined,
    retry: state.status === 'error' ? state.retry : undefined,
  }
}

export function getPostTags(posts: Post[]): Array<{ tag: string; count: number }> {
  const map = new Map<string, number>()
  for (const p of posts) for (const t of p.tags) map.set(t, (map.get(t) ?? 0) + 1)
  return [...map.entries()].map(([tag, count]) => ({ tag, count })).sort((a, b) => b.count - a.count)
}

/** 粗略阅读时长（分钟） */
export function readMinutes(content: string): number {
  return Math.max(1, Math.round(content.replace(/\s+/g, '').length / 400))
}

/* ---------------- 后台 ---------------- */

/** 后台：管理员拉主库，志愿者拉自己的独立库，二者都含草稿。 */
export async function fetchAllPosts(): Promise<Post[]> {
  if (!apiEnabled()) return []
  const list = await api.get<Post[]>('/api/posts?all=1&library=mine', true)
  return Array.isArray(list) ? list : []
}

/** 后台文章表格不下载长正文与多语言缓存；点“编辑”时再单独取完整文章。 */
export async function fetchAdminPostSummaries(): Promise<Post[]> {
  if (!apiEnabled()) return []
  const list = await api.get<Post[]>('/api/posts?all=1&library=mine&summary=1', true)
  return Array.isArray(list) ? list : []
}

export async function fetchAdminPost(slug: string): Promise<Post> {
  return api.get<Post>(`/api/posts/${encodeURIComponent(slug)}?library=mine`, true)
}

export async function savePost(post: Post, options: { createOnly?: boolean } = {}): Promise<Post> {
  const suffix = options.createOnly ? '?create=1' : ''
  return api.put<Post>(`/api/posts/${encodeURIComponent(post.slug)}${suffix}`, post, true)
}

export async function deletePost(slug: string): Promise<void> {
  await api.del(`/api/posts/${encodeURIComponent(slug)}`, true)
}

/** 切换发布状态只发一个布尔值，避免旧列表快照覆盖另一名管理员刚保存的新正文。 */
export async function setPostPublished(post: Post, published: boolean): Promise<Post> {
  return api.patch<Post>(`/api/posts/${encodeURIComponent(post.slug)}/published`, { published }, true)
}
