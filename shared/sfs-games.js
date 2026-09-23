/** 只有这些 Flash 会连接 SmartFoxServer；普通游戏不该为旁路配置多等一次网络请求。 */
export const SFS_GAME_SLUGS = Object.freeze(['sas3'])

export function isSfsGame(slug) {
  return typeof slug === 'string' && SFS_GAME_SLUGS.includes(slug.trim().toLowerCase())
}
