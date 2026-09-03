/**
 * 开发商资料（后台专用）。
 *
 * 前台不走这里 —— 开发商列表页要的作品数、代表作和自定义 logo 都在 facets 里，
 * 跟着 /api/page?path=/developers 一次拿全（见 pageData.ts 的 Facets.developers）。
 * 这个模块只服务 /admin/developers 那一页的读写。
 */
import { api, apiEnabled } from './api'
import type { DeveloperProfile, DeveloperTopGame } from './pageData'

/**
 * 后台列表里的一行。
 *
 * 与前台 facets 的差别：这里的资料字段一律是字符串（没填就是空串），不是 undefined ——
 * 表单要直接绑上去，undefined 会让 <input> 在受控与非受控之间来回切。
 */
export interface AdminDeveloper {
  name: string
  /** 名下有多少款（未下架的）游戏。0 表示这行资料已经没有对应的游戏了 */
  count: number
  logo: string
  description: string
  descriptionEn: string
  homepage: string
  topGame?: DeveloperTopGame
}

/** 后台：开发商全名单（含作品数、代表作、已填资料） */
export async function fetchAdminDevelopers(): Promise<AdminDeveloper[]> {
  if (!apiEnabled()) return []
  const list = await api.get<AdminDeveloper[]>('/api/developers', true)
  return Array.isArray(list) ? list : []
}

/** 写入 / 覆盖一家的资料。name 是主键，不能改 —— 要改名去改游戏里的开发商字段 */
export async function saveDeveloper(name: string, profile: DeveloperProfile): Promise<void> {
  await api.put(`/api/developers/${encodeURIComponent(name)}`, profile, true)
}

/** 删掉资料，该开发商回到「用代表作封面」 */
export async function deleteDeveloper(name: string): Promise<void> {
  await api.del(`/api/developers/${encodeURIComponent(name)}`, true)
}
