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
 * 和 gameTitle 的方向正好相反，因为两个字段的「基准语言」不一样：
 *   - 标题的基准是原名（多半是英文），titleZh 才是译文
 *   - 简介是后台自己写的，基准就是站点母语（中文），descriptionEn 才是译文
 *
 * 所以这里是：中文界面用基准简介，**其余所有语言**优先英文。
 * 不是只给英文页用 —— 西班牙语访客看英文，也远好过看中文。
 * 没写英文版时统一回落到基准简介，宁可语言不对也不要留白。
 */
export function gameDescription(game: { description?: string; descriptionEn?: string }, lang: Lang): string {
  const zh = lang === 'zh-Hans' || lang === 'zh-Hant'
  if (zh) return game.description ?? ''
  return game.descriptionEn || game.description || ''
}
