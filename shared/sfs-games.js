/**
 * 只有这些 Flash 会连接 SmartFoxServer；普通游戏不该为旁路配置多等一次网络请求。
 * `sas3` 是旧的短别名，生产库已使用完整 slug；两者都保留，避免存量链接或导入数据失去联机配置。
 */
export const SFS_GAME_SLUGS = Object.freeze(['sas3', 'sas-zombie-assault-3'])

export function isSfsGame(slug) {
  return typeof slug === 'string' && SFS_GAME_SLUGS.includes(slug.trim().toLowerCase())
}
