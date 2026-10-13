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
 *   agi2  key→value 存储方言。Kingdom Rush Frontiers 的 AGI2 桥和 SAS3 的 Banana
 *         兼容桥虽然对游戏暴露的接口不同，落到服务端都是 slot1~3 三个 JSON 对象。
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

/**
 * SAS3 使用独立发布号：它与 Armor Games 两代桥没有发布耦合，修 Banana 兼容层时不该让
 * 已稳定的 AGI / AGI2 URL 一起变化。Cloudflare 会缓存 SWF，所以仍然只增不改。
 */
export const SAS3_BANANA_BRIDGE_RELEASE = '20261002-r01'

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
  'sas-zombie-assault-3': {
    // SAS3 只需要一份主进度对象（slot1）；slot2/3 留给旧版 additional-data 扩展。
    protocol: 'agi2',
    bridge: `/flash-api/ninjakiwi/${SAS3_BANANA_BRIDGE_RELEASE}/Banana.swf`,
    /*
      必须写原 SWF 内嵌的 http:// 地址。Ruffle 在 URL 改写之后才做 HTTPS 升级；
      只写控制台最终打印出来的 https:// 会和地图资源犯同一个“看似正确、永远不命中”的错。
    */
    rewriteFrom: [
      // RemoteLoader 把 URLRequest.data 追加成查询串以后才交给 Ruffle，规则必须连查询串一起精确匹配。
      'http://ninjakiwi.com/nklogin/Banana.swf?gamename=SAS3',
      'http://ninjakiwi.com/nklogin/debugBanana.swf?gamename=SAS3',
    ],
    // 主游戏自己的登录按钮直接 navigateToURL，不经过 Banana；播放器用这张表接回站内登录框。
    loginUrls: ['https://ninjakiwi.com/login', 'http://ninjakiwi.com/login'],
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

/** 旧游戏加载远程 SDK 的原地址；空数组表示沿用 Armor Games 的文件名规则。 */
export function flashSaveRewriteSourcesOf(gameSlug) {
  const sources = FLASH_SAVE_GAMES[String(gameSlug || '')]?.rewriteFrom
  return Array.isArray(sources) ? sources.slice() : []
}

/** 游戏里写死、需要由播放器接回本站登录框的网页地址。 */
export function flashSaveLoginUrlsOf(gameSlug) {
  const urls = FLASH_SAVE_GAMES[String(gameSlug || '')]?.loginUrls
  return Array.isArray(urls) ? urls.slice() : []
}

/** 已接入的游戏 slug。用于把 env 白名单的默认值钉在同一份表上 */
export function flashSaveKnownSlugs() {
  return Object.keys(FLASH_SAVE_GAMES)
}
