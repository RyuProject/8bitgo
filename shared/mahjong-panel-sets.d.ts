export declare const MAME_MAHJONG_PANEL_SETS: readonly string[]
export declare const MAME_MAHJONG_PANEL_DIP_DEFAULTS: Readonly<Record<string, 'Mahjong' | 'Joystick'>>

export function romsetFromKey(key: string | null | undefined): string

export function isMahjongPanelRomset(romset: string | null | undefined): boolean
export function isMahjongPanelDipRomset(romset: string | null | undefined): boolean
export function mahjongPanelDipDefault(romset: string | null | undefined): 'Mahjong' | 'Joystick' | null
