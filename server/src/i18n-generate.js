/**
 * 「把一段文本变成某个语言的版本」的**唯一出处**。
 *
 * 两个调用方共用这里：
 *   - 路由（玩家点「翻译」按钮）：`routes/games.js`、`routes/posts.js`
 *   - 批量预生成（`server/scripts/pretranslate.mjs`、文章发布钩子）
 *
 * 为什么要抽出来：繁体走 OpenCC、其余走火山，这个**分支**如果在两处各写一遍，
 * 迟早会漂 —— 比如脚本改成了 OpenCC、路由还在拿英文版翻 zh，同一个字段两条路
 * 生成出两种东西，而且谁都不会报错。分支只有一处，是这个文件存在的全部理由。
 *
 * 回归：`npm run test:translate`
 */
import { translateText, translateMarkdown } from './translate.js'
import { toTraditional } from './zh-convert.js'

/**
 * 单段短文本（游戏简介、文章摘要、标题）。
 *
 * @param {string} text 源文
 * @param {{ convert?: boolean, source?: string, target?: string }} plan `translatePlan()` 的结果
 * @returns {Promise<string>} 目标语言的文本
 */
export async function renderField(text, plan) {
  const src = String(text ?? '').trim()
  if (!src) return ''
  if (plan?.convert) return toTraditional(src)
  return translateText(src, plan.source, plan.target)
}

/**
 * Markdown 正文。
 *
 * 繁体那一路**不分段**：OpenCC 是纯本地的字词替换，没有「单条太长」的限制，
 * 也不存在 QPS —— 整篇一次转完，比切段再拼回去更不容易破坏 Markdown 结构。
 * 火山那一路仍然按段落切（见 translateMarkdown 的注释）。
 *
 * @param {string} text
 * @param {{ convert?: boolean, source?: string, target?: string }} plan
 * @returns {Promise<string>}
 */
export async function renderMarkdownField(text, plan) {
  const src = String(text ?? '')
  if (!src.trim()) return ''
  if (plan?.convert) return toTraditional(src)
  return translateMarkdown(src, plan.source, plan.target)
}

/**
 * 一款游戏的简介源文**是什么语言、内容是什么**。
 *
 * 这两件事必须一起算出来，不能分开 —— 分开就会出现「拿的是中文那份、告诉火山是英文」
 * 这个 2026-09-07 修掉的 bug。顺序和前端 `gameDescription()` 的回退链一致：
 * 英文版优先（它是给非中文读者写的），没有再退到中文基准。
 *
 * @param {{ descriptionEn?: string, description?: string }} game
 * @returns {{ text: string, lang: 'en'|'zh-Hans' }|null} 没有任何简介时返回 null
 */
export function gameDescriptionSource(game) {
  const en = String(game?.descriptionEn ?? '').trim()
  if (en) return { text: en, lang: 'en' }
  const zh = String(game?.description ?? '').trim()
  if (zh) return { text: zh, lang: 'zh-Hans' }
  return null
}
