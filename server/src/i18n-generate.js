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
 * 这个 2026-09-07 修掉的 bug。默认顺序和前端 `gameDescription()` 的回退链一致：
 * 英文版优先（它是给非中文读者写的），没有再退到中文基准。
 *
 * ── 繁体是例外：中文原文优先 ─────────────────────────────────
 * 目标是 `zh-Hant` 时，**有中文基准就一定用中文基准**，哪怕这款游戏也填了英文简介。
 * 三个理由，每一个单独都够：
 *   1. 中文 → 繁体走本地 OpenCC，**零成本、不需要 VOLC_AK/SK**；
 *      英文 → 繁体必须上游翻，按字符计费。
 *   2. 中文基准就是**原文**，英文那份本身已经是转写/意译，从它再翻一道是二手信息。
 *   3. 实际后果不是「贵一点」而是「一条都没有」：2026-09-08 线上实测，
 *      /zh-Hant/games/1942 的简介仍是简体 —— 因为 1942 两份简介都有，源文挑了英文，
 *      于是繁体落进 NOT_CONFIGURED（缺火山密钥）被跳过。填了英文简介的游戏
 *      **全都**卡在这一条上，而这类游戏正是站上占比最大的一批。
 *
 * 别把这个例外推广到 zh-Hans：它是基准语言，`translatePlan` 会判成 passthrough，
 * 本来就不生成译文。
 *
 * @param {{ descriptionEn?: string, description?: string }} game
 * @param {string} [targetLang] 要生成哪个语言的译文。不传就是老行为（英文优先）
 * @returns {{ text: string, lang: 'en'|'zh-Hans' }|null} 没有任何简介时返回 null
 */
export function gameDescriptionSource(game, targetLang) {
  const en = String(game?.descriptionEn ?? '').trim()
  const zh = String(game?.description ?? '').trim()
  if (targetLang === 'zh-Hant' && zh) return { text: zh, lang: 'zh-Hans' }
  if (en) return { text: en, lang: 'en' }
  if (zh) return { text: zh, lang: 'zh-Hans' }
  return null
}
