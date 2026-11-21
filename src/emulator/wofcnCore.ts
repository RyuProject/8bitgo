/** WOF CN 使用的独立 FBNeo 构建；不更改其它街机 ROM 的核心选择。 */
export const FBNEO_WOFCN_CORE = 'fbneo-wofcn'
const SAVE_SUFFIX = ':fbneo-wofcn'

/** 独立核心构建的即时存档 ABI 单独分档，避免与普通 FBNeo 的快照交叉覆盖。 */
export function fbneoWofcnSaveSlug(slug: string): string {
  return slug.endsWith(SAVE_SUFFIX) ? slug : `${slug}${SAVE_SUFFIX}`
}

/** 云存档列表展示游戏本身，不向玩家暴露内部核心后缀。 */
export function parseFbneoWofcnSaveSlug(value: string): string {
  return value.endsWith(SAVE_SUFFIX) ? value.slice(0, -SAVE_SUFFIX.length) : value
}
