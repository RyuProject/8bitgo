/**
 * Flash 在线存档接入表：**唯一一份**「游戏 → 方言 → 桥文件名」的映射。
 *
 * 前端（src/services/flashOnlineSave.ts）和服务端（server/src/flash-save-contract.js）
 * 都读这里。以前这三样东西分散在三处（前端 BRIDGES / 后端 GAME_PROTOCOLS / env 白名单），
 * 漏改一处的症状是「桥能加载、游戏也能连上，但永远读不到档」——不报错、没有日志，
 * 只有玩家发现自己存档没了。
 *
 * 方言说明：
 *   agi1  方法式（Infectonator 2）：游戏连调两次 submitUserData，profile + data 拼成一槽
 *   agi2  对象式（Kingdom Rush Frontiers）：user / storage / content / quests，
 *         按 key→value 存取，key 固定 slot1~3
 *
 * ⚠️ 新增一款游戏时改这里 + 跑一遍脚本把桥产物构建出来（`npm run flashbridge`）。
 * 不在表里的 slug 拿不到桥地址，前端根本不会启动在线存档；服务端即使被 env 放行，
 * 也只会按 agi1 处理。这条约束由 scripts/test-flash-save-consistency.mjs 守着。
 */
export const FLASH_SAVE_GAMES = Object.freeze({
  'infectonator-2': { protocol: 'agi1', bridge: '/flash-api/armor-games/AGI.swf' },
  'kingdom-rush-frontiers': { protocol: 'agi2', bridge: '/flash-api/armor-games/AGI2.swf' },
})

/** 这一款接没接在线存档；没接返回 '' */
export function flashSaveBridgeOf(gameSlug) {
  return FLASH_SAVE_GAMES[String(gameSlug || '')]?.bridge || ''
}

/**
 * 这一款按哪套方言说话。**表外的 slug 一律退回 agi1**：
 * 老游戏的历史行为不能被新方言悄悄改掉，退回 agi1 至少还是原来那套。
 */
export function flashSaveProtocolOf(gameSlug) {
  return FLASH_SAVE_GAMES[String(gameSlug || '')]?.protocol || 'agi1'
}

/** 已接入的游戏 slug。用于把 env 白名单的默认值钉在同一份表上 */
export function flashSaveKnownSlugs() {
  return Object.keys(FLASH_SAVE_GAMES)
}
