const STOP_WORDS = new Set(`
a an the and or but if so because as of at by for from in into on onto to with without through across over under between is are was were be been being have has had do does did can could may might must shall should will would this that these those it its they them their he she we you your our i who which what when where while than then also very more most some any all each other another such both either neither not no nor only own same too just about after before during until game games player players play playing classic version series sequel title release released experience journey story world worlds level levels stage stages
`.trim().split(/\s+/))
const SHORT_KEYWORDS = new Set(['2d', '3d', 'fps', 'rpg', 'jrpg', 'mmorpg', 'vr'])

/**
 * 从英文简介提取稳定、可读的标签：高频的主题词排前，常见英文虚词与泛化游戏文案剔除。
 * 不依赖浏览器 NLP 服务，后台编辑离线可用，重复输入会得到相同结果。
 */
export function extractGameKeywords(description: string, limit = 8): string[] {
  const normalizedLimit = Math.max(0, Math.min(20, Math.floor(limit)))
  if (!normalizedLimit) return []

  const tokens = (description.toLocaleLowerCase('en').match(/[\p{L}\p{N}]+(?:['’.-][\p{L}\p{N}]+)*/gu) ?? [])
    .map((token) => token.replace(/^[-'.]+|[-'.]+$/g, ''))
    .filter((token) => (token.length >= 3 || SHORT_KEYWORDS.has(token)) && !STOP_WORDS.has(token) && !/^\d+$/.test(token))
  const counts = new Map<string, number>()
  const firstSeen = new Map<string, number>()
  tokens.forEach((token, index) => {
    counts.set(token, (counts.get(token) ?? 0) + 1)
    if (!firstSeen.has(token)) firstSeen.set(token, index)
  })

  return [...counts.keys()]
    .sort((a, b) => (counts.get(b)! - counts.get(a)!) || (firstSeen.get(a)! - firstSeen.get(b)!) || a.localeCompare(b))
    .slice(0, normalizedLimit)
}
