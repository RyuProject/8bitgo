/**
 * 数据类文案（类型 / 平台）的翻译查表。
 *
 * 游戏的类型与平台在 src/data/*.ts 里是带中文名的静态数据，
 * 这里按 id 去各语言文案里取名字/描述；找不到就回退到数据文件里的原值，
 * 所以新增一个类型/平台而忘了加翻译时，界面只会显示中文，不会崩。
 */
import type { Translation } from '@/locales'

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
