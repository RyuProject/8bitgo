/**
 * 数据类文案（类型 / 平台）的翻译查表。
 *
 * 游戏的类型与平台在 src/data/*.ts 里是带中文名的静态数据，
 * 这里按 id 去各语言文案里取名字/描述；找不到就回退到数据文件里的原值，
 * 所以新增一个类型/平台而忘了加翻译时，界面只会显示中文，不会崩。
 */
import type { Translation } from '@/locales'
import type { Lang } from '@/config/languages'

type GenreKey = keyof Translation['genres']
type PlatformKey = keyof Translation['platforms']

export function genreLabel(t: Translation, id: string, fallback = ''): string {
  return t.genres[id as GenreKey]?.name ?? fallback ?? id
}

export function genreDesc(t: Translation, id: string, fallback = ''): string {
  return t.genres[id as GenreKey]?.desc ?? fallback
}

export function platformLabel(t: Translation, id: string, fallback = ''): string {
  return t.platforms[id as PlatformKey]?.name ?? fallback ?? id
}

export function platformDesc(t: Translation, id: string, fallback = ''): string {
  return t.platforms[id as PlatformKey]?.desc ?? fallback
}

/* ---------------- 游戏显示名 ---------------- */

/**
 * 按当前语言选游戏名。
 * titleZh 是中文译名，只在中文界面下使用；其它语言用原名（通常是英文/日文原题），
 * 否则英文页面会出现「Play 超级马力欧兄弟 Online」这种中英夹杂的标题。
 *
 * titleZh 收 null 和空串：静态数据里它是 undefined，而搜索接口回来的
 * SuggestItem 是 null，后台也可能存进一个空串 —— 三种「没有译名」都得落回原名，
 * 所以这里用 || 而不是 ??。
 */
export function gameTitle(game: { title: string; titleZh?: string | null }, lang: Lang): string {
  const zh = lang === 'zh-Hans' || lang === 'zh-Hant'
  return (zh ? game.titleZh : '') || game.title
}

/**
 * 按当前语言选游戏简介。
 *
 * 三层回退（每层都是「有就用、没有就走下一层」）：
 *
 *   zh-Hans → description（基准就是中文）
 *   zh-Hant → descriptionI18n?.['zh-Hant']   ← 玩家点过翻译的话就有
 *            → description                    ← 没点过就退回到中文（繁体用户看简体中文）
 *   en      → descriptionEn
 *   es/fr/it/de/ja
 *           → descriptionI18n?.[lang]
 *           → descriptionEn                  ← 没点过翻译就看英文
 *           → description                    ← 没英文就再退到中文（中文用户帮缺英文版的兜底）
 *
 * 优先级里 i18n 永远最高 —— 玩家点过翻译的版本就是他看过的版本，哪怕是后台后来又改了也没关系。
 * 后台改 description / description_en 时后端会把整张 descriptionI18n 清空，所以「改了基准后旧的点过
 * 的译文」这种漂移根本不会发生。
 */
export function gameDescription(
  game: { description?: string; descriptionEn?: string; descriptionI18n?: Record<string, string> },
  lang: Lang,
): string {
  // 中文界面没有「翻译」按钮（基准就是中文，没什么好翻的），没用过 descriptionI18n
  if (lang === 'zh-Hans') return game.description ?? ''
  // 繁体：点过翻译就是首选；繁体界面也支持「翻译」按钮，所以可能存在 i18n['zh-Hant']
  if (lang === 'zh-Hant') {
    return game.descriptionI18n?.['zh-Hant'] || game.description || ''
  }
  // 其它：i18n[lang] → 英文 → 中文（依此回退，每一步的注释见上方）
  return game.descriptionI18n?.[lang] || game.descriptionEn || game.description || ''
}

/**
 * 这个语种要不要在游戏简介旁显示「翻译」按钮。
 *
 * 规则：
 *   zh-Hans / en —— passthrough，没有「翻译」目标，点了一次也是空操作；
 *   其它 6 种 —— i18n 里已经有了就别再让人点（按钮变成无意义），没有就给按钮
 *
 * 状态用「需要翻译」描述，符合按钮的语义；前端别去反推 disable / hidden。
 */
export function needsTranslation(game: { descriptionI18n?: Record<string, string> }, lang: Lang): boolean {
  if (lang === 'zh-Hans' || lang === 'en') return false
  return !game.descriptionI18n?.[lang]
}

/* ---------------- 文章按需翻译 ---------------- */

/**
 * 文章摘要按当前语言选段。
 *
 * 和 game 的不同：post 没有英文基准列（不像 game 有 description_en），所以 en 界面看到的也是
 * 中文原文，需要翻译按钮把中文翻成英文。因此回退链只有两层：
 *   zh-Hans → excerpt（中文基准）
 *   其它语言 → excerptI18n?.[lang] → excerpt（没翻过就看中文原文）
 *
 * 优先级里 i18n 永远最高：玩家点过翻译的版本就是他看过的版本，哪怕后台后来改了也没关系
 * （后台改 excerpt 时后端会把整张 excerptI18n 清空，见 routes/posts.js 的 PUT handler）。
 */
export function postExcerpt(
  post: { excerpt?: string; excerptI18n?: Record<string, string> },
  lang: Lang,
): string {
  if (lang === 'zh-Hans') return post.excerpt ?? ''
  return post.excerptI18n?.[lang] || post.excerpt || ''
}

/**
 * 文章正文（Markdown）按当前语言选段。逻辑和 postExcerpt 完全一致，只是字段换成 content。
 * 详见 postExcerpt 的回退链说明。
 */
export function postContent(
  post: { content?: string; contentI18n?: Record<string, string> },
  lang: Lang,
): string {
  if (lang === 'zh-Hans') return post.content ?? ''
  return post.contentI18n?.[lang] || post.content || ''
}

/**
 * 文章详情页要不要在标题旁显示「翻译」按钮。
 *
 * 规则（和 game 不同，因为 post 没有英文基准列）：
 *   zh-Hans     —— passthrough，原文就是中文，没东西好翻，不显示；
 *   其它 7 种    —— excerpt / content 两个字段都翻译过了才隐藏按钮，否则就显示。
 *                 只要有一个字段没翻过（包括「partial 翻译」那种只翻了 excerpt 的情况），
 *                 按钮依然在，玩家再点一次能补上缺的那个字段。
 */
export function needsPostTranslation(
  post: { excerptI18n?: Record<string, string>; contentI18n?: Record<string, string> },
  lang: Lang,
): boolean {
  if (lang === 'zh-Hans') return false
  return !(post.excerptI18n?.[lang] && post.contentI18n?.[lang])
}
