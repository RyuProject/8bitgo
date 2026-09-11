export type UserRole = 'user' | 'volunteer' | 'admin'

/**
 * ⚠️ 这个联合类型必须和 roles.js 的 ABILITIES **逐项一致**。
 * 手写的 .d.ts 会漂：2026-09-11 发现它少了 `collections:review`（早就加进 roles.js 了），
 * 症状是前端想引用那个权限点时 TS 报「不可赋值」，于是有人会顺手改成字符串断言 ——
 * 那一刀下去，整张权限表在前端就不再受类型保护了。
 * server/scripts/test-roles.mjs 里有一条断言守着这件事。
 */
export type Ability =
  | 'content:edit'
  | 'comments:review'
  | 'users:manage'
  | 'users:role'
  | 'site:manage'
  | 'collections:review'
  | 'apps:review'

export const ROLES: readonly UserRole[]
export const ROLE_LABELS: Readonly<Record<UserRole, string>>
export const ABILITIES: readonly Ability[]
export const ROLE_ABILITIES: Readonly<Record<UserRole, readonly Ability[]>>

export function can(role: string | null | undefined, ability: Ability): boolean
export function isStaff(role: string | null | undefined): boolean
export function isRole(value: unknown): value is UserRole
