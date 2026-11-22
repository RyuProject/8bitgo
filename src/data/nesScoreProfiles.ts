import type { NesScoreProfile } from '@/emulator/nesScore'

/**
 * 经实机 / 游戏内画面核实的 NES 分数布局。
 *
 * 新增行必须同时确认游戏 slug、ROM 裸数据 SHA-256、RAM 偏移和编码；同一游戏的不同 ROM
 * 修订版各写一行。未知 ROM 不继承相邻版本，也不猜地址，以免把玩家 RAM 误报成分数。
 */
export const NES_SCORE_PROFILES: readonly NesScoreProfile[] = Object.freeze([])
