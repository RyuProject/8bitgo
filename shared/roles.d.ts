export type UserRole = 'user' | 'volunteer' | 'admin'

export type Ability = 'content:edit' | 'comments:review' | 'users:manage' | 'users:role' | 'site:manage'

export const ROLES: readonly UserRole[]
export const ROLE_LABELS: Readonly<Record<UserRole, string>>
export const ABILITIES: readonly Ability[]
export const ROLE_ABILITIES: Readonly<Record<UserRole, readonly Ability[]>>

export function can(role: string | null | undefined, ability: Ability): boolean
export function isStaff(role: string | null | undefined): boolean
export function isRole(value: unknown): value is UserRole
