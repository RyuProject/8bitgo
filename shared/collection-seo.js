/**
 * 公开合集是否值得主动提交给搜索引擎。
 *
 * 用户仍可打开任何公开合集；这道门只决定 sitemap 和页面索引信号，避免空清单或
 * 只有一两款游戏、没有编辑说明的清单挤占搜索抓取。游戏数和说明长度必须一起看：
 * 大清单可独立提供选择价值，小清单需要更充分的原创说明。
 */
export function shouldIndexCollection({ gameCount, description } = {}) {
  const count = Math.max(0, Math.floor(Number(gameCount) || 0))
  const normalizedDescription = String(description ?? '').trim().replace(/\s+/gu, ' ')
  const descriptionLength = [...normalizedDescription].length

  return count >= 5 || (count >= 3 && descriptionLength >= 120) || (count >= 1 && descriptionLength >= 300)
}
