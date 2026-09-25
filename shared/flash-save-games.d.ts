/** shared/flash-save-games.js 的类型声明（前端从 TS 里 import 它） */
export type FlashSaveProtocol = 'agi1' | 'agi2'

export interface FlashSaveGameEntry {
  protocol: FlashSaveProtocol
  /** 桥接 SWF 的站内绝对路径（相对站点根） */
  bridge: string
  /** AGI1 游戏传给 init 的兼容标识；AGI2 不需要 */
  agiGameKey?: string
}

export const FLASH_SAVE_GAMES: Readonly<Record<string, FlashSaveGameEntry>>

/** 这一款接没接在线存档；没接返回空串 */
export function flashSaveBridgeOf(gameSlug?: string | null): string

/** 这一款按哪套方言说话；表外一律退回 agi1 */
export function flashSaveProtocolOf(gameSlug?: string | null): FlashSaveProtocol

/** AGI1 的 init gameKey；非 AGI1 或表外游戏返回空串 */
export function flashSaveGameKeyOf(gameSlug?: string | null): string

/** 已接入的游戏 slug */
export function flashSaveKnownSlugs(): string[]
export const FLASH_SAVE_BRIDGE_RELEASE: string
