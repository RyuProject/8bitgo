/**
 * GrindCraft 的存量 SWF 依赖 Ruffle 尚未实现的 Flex 文本排版接口，初始化会在 enterFrame 超时后黑屏。
 * 详情页改用游戏方公开的 HTML5 版本；只匹配这一个 slug，其他 Flash 游戏仍走原有 Ruffle 链路。
 */
export const GRINDCRAFT_HTML5_URL = 'https://cdn.grindcraft.com/game.html'

export function grindcraftHtml5Entry(gameSlug: string | undefined): string | null {
  return gameSlug?.trim().toLowerCase() === 'grindcraft' ? GRINDCRAFT_HTML5_URL : null
}
