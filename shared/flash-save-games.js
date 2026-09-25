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
 * agiGameKey 是 AGI1 的兼容标识（游戏传给 init 的 gameKey）。它不是密钥，
 * 但能防止一个不相容的 Armor Games SWF 被这套半兼容桥静默接管。
 * AGI2 和给新游戏用的 eightbitgo 简化接口不需要它。
 *
 * ⚠️ 新增一款游戏时改这里 + 跑一遍脚本把桥产物构建出来（`npm run flashbridge`）。
 * 不在表里的 slug 拿不到桥地址，前端根本不会启动在线存档；服务端即使被 env 放行，
 * 也只会按 agi1 处理。这条约束由 scripts/test-flash-save-consistency.mjs 守着。
 */
/*
 * 桥文件使用不可变发布目录，不能永远复用同一个 CDN URL。
 * Cloudflare 会缓存 SWF；只覆盖 /AGI.swf 会出现“源站已修、玩家仍跑旧桥”且持续数小时。
 * 游戏请求的原始文件名仍是 AGI.swf / AGI2.swf，前端只取目标 URL 的末段做匹配，
 * 所以在中间加发布目录既能穿透旧缓存，也不改变旧游戏的加载地址。
 */
export const FLASH_SAVE_BRIDGE_RELEASE = '20260925-r03'

export const FLASH_SAVE_GAMES = Object.freeze({
  'infectonator-2': {
    protocol: 'agi1',
    bridge: `/flash-api/armor-games/${FLASH_SAVE_BRIDGE_RELEASE}/AGI.swf`,
    agiGameKey: 'infect-2',
  },
  // 线上历史 slug 本来就没有第二个连字符；这里必须与 games.slug 完全一致，
  // 否则前端会在请求会话之前就判定为“未接入”，服务端配置再正确也不会生效。
  'kingdom-rushfrontiers': {
    protocol: 'agi2',
    bridge: `/flash-api/armor-games/${FLASH_SAVE_BRIDGE_RELEASE}/AGI2.swf`,
  },
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

/** AGI1 的 init gameKey；非 AGI1 或表外游戏返回空串。 */
export function flashSaveGameKeyOf(gameSlug) {
  return FLASH_SAVE_GAMES[String(gameSlug || '')]?.agiGameKey || ''
}

/** 已接入的游戏 slug。用于把 env 白名单的默认值钉在同一份表上 */
export function flashSaveKnownSlugs() {
  return Object.keys(FLASH_SAVE_GAMES)
}
