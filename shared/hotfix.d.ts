/** hotfix.js 的类型声明。改了导出记得同步这里。 */

export type HotfixRisk = 'safe' | 'risky'
export type HotfixActionType =
  | 'runtime_origin'
  | 'rom_host'
  | 'disable_engine_cache'
  | 'memory_rom'
  | 'player_notice'
  | 'set_core'
  | 'set_runtime'
export type HotfixNoticeTemplate = 'unstable' | 'try_other_browser' | 'try_later'

export type HotfixAction =
  | { type: 'runtime_origin' }
  | { type: 'rom_host'; host: 'primary' | 'mirror' }
  | { type: 'disable_engine_cache' }
  | { type: 'memory_rom' }
  | { type: 'player_notice'; template: HotfixNoticeTemplate }
  | { type: 'set_core'; core: string }
  | { type: 'set_runtime'; runtime: string }

export interface HotfixScope {
  games: string[]
  browsers: string[]
  os: string[]
  cnOnly: boolean
}

export interface PublicHotfix {
  id: string
  scope: HotfixScope
  actions: HotfixAction[]
  expiresAt?: string
}

export interface HotfixProposal {
  diagnosis: string
  permanentFix: string
  playerImpact: string
  confidence: number
  ttlHours: number
  scope: HotfixScope
  actions: HotfixAction[]
  dropped: string[]
}

export interface ResolvedHotfixes {
  ids: string[]
  core?: string
  runtime?: string
  runtimeOrigin: boolean
  romHost?: 'primary' | 'mirror'
  disableEngineCache: boolean
  memoryRom: boolean
  notice?: HotfixNoticeTemplate
}

export declare const HOTFIX_MAX_GAMES: number
export declare const HOTFIX_MAX_TTL_HOURS: number
export declare const HOTFIX_DEFAULT_TTL_HOURS: number
export declare const HOTFIX_TEXT_MAX: number
export declare const HOTFIX_CORE_CHOICES: Readonly<Record<string, readonly string[]>>
export declare const HOTFIX_RUNTIME_CHOICES: Readonly<Record<string, readonly string[]>>
export declare const HOTFIX_NOTICE_TEMPLATES: readonly HotfixNoticeTemplate[]
export declare const HOTFIX_ROM_HOSTS: readonly ('primary' | 'mirror')[]
export declare const HOTFIX_OS_FAMILIES: readonly string[]
export declare const HOTFIX_ACTIONS: Readonly<Record<HotfixActionType, { risk: HotfixRisk; label: string; when: string }>>
export declare const HOTFIX_ACTION_TYPES: readonly HotfixActionType[]

export declare function sanitizeHotfixAction(raw: unknown, platforms?: string[]): HotfixAction | { error: string }
export declare function sanitizeHotfixScope(raw: unknown, opts?: { allowedGames?: Iterable<string> }): HotfixScope
export declare function sanitizeHotfixProposal(
  raw: unknown,
  ctx: { allowedGames: Iterable<string>; gamePlatforms: Map<string, string> | Record<string, string>; maxTtlHours?: number },
): HotfixProposal
export declare function hotfixRisk(actions?: HotfixAction[]): HotfixRisk
export declare function hasFunctionalAction(actions?: HotfixAction[]): boolean
export declare function hotfixMatches(
  hotfix: { scope: HotfixScope } | null | undefined,
  ctx: { slug: string; browser?: string; os?: string; cn?: boolean },
): boolean
export declare function resolveHotfixes(
  list: unknown,
  ctx: { slug: string; platform: string; browser?: string; os?: string; cn?: boolean },
): ResolvedHotfixes
