export declare const NETPLAY_MAX_PLAYERS: 4
export declare function normalizeGamePlayers(value: unknown): number
export type NetplayMode = 'auto' | 'on' | 'off'
export declare const NETPLAY_MODES: NetplayMode[]
export declare function normalizeNetplayMode(value: unknown): NetplayMode
export declare function netplayModeFromInput(game: unknown): NetplayMode | undefined
