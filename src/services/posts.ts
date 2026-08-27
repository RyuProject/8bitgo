import { posts as builtinPosts } from '@/data/posts'
import type { Post } from '@/types'
import { createLocalStore } from './localStore'
import { api, apiEnabled } from './api'

export const POSTS_KEY = '8bitgo.admin.posts'

function isPost(x: unknown): x is Post {
  const p = x as Post
  return (
    typeof p === 'object' &&
    p !== null &&
    typeof p.slug === 'string' &&
    typeof p.title === 'string' &&
    typeof p.content === 'string' &&
    typeof p.date === 'string'
  )
}

export const postsStore = createLocalStore<Post>({
  key: POSTS_KEY,
  initial: builtinPosts,
  getId: (p) => p.slug,
  validate: isPost,
  // 与游戏一致：配了后端就以数据库为准
  remote: apiEnabled,
})

const byDateDesc = (a: Post, b: Post) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0)

/** 前台可见的文章（已发布），按日期倒序 */
export function getPublishedPosts(): Post[] {
  return postsStore
    .load()
    .filter((p) => p.published)
    .sort(byDateDesc)
}

export function getPost(slug: string): Post | undefined {
  const p = postsStore.find(slug)
  return p && p.published ? p : undefined
}

export function getPostTags(): Array<{ tag: string; count: number }> {
  const map = new Map<string, number>()
  for (const p of getPublishedPosts()) for (const t of p.tags) map.set(t, (map.get(t) ?? 0) + 1)
  return [...map.entries()].map(([tag, count]) => ({ tag, count })).sort((a, b) => b.count - a.count)
}

/** 粗略阅读时长（分钟） */
export function readMinutes(content: string): number {
  return Math.max(1, Math.round(content.replace(/\s+/g, '').length / 400))
}

export function useAllPosts(): Post[] {
  return postsStore.useAll()
}

/**
 * 从后端拉取文章。未配置后端时不做任何事。
 *
 * @param all true = 连草稿一起要（后台用，需要管理员口令）。前台不要传。
 */
export async function hydratePosts(all = false): Promise<void> {
  if (!apiEnabled()) return
  const list = await api.get<Post[]>(all ? '/api/posts?all=1' : '/api/posts', all)
  if (Array.isArray(list)) postsStore.save(list)
}

/** 新增 / 覆盖文章：配置后端时写库，同时更新本地缓存 */
export async function savePost(post: Post): Promise<void> {
  if (apiEnabled()) await api.put(`/api/posts/${encodeURIComponent(post.slug)}`, post, true)
  postsStore.upsert(post)
}

export async function deletePost(slug: string): Promise<void> {
  if (apiEnabled()) await api.del(`/api/posts/${encodeURIComponent(slug)}`, true)
  postsStore.remove(slug)
}

/** 切换发布状态 */
export async function setPostPublished(slug: string, published: boolean): Promise<void> {
  const current = postsStore.find(slug)
  if (apiEnabled() && current) await api.put(`/api/posts/${encodeURIComponent(slug)}`, { ...current, published }, true)
  postsStore.update(slug, { published })
}
