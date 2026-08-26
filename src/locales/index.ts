/**
 * 多语言文案注册表。
 *
 * zh-Hans 是基准语言，`Translation` 类型由它推导：
 * 其它语言文件写成 `const xx: Translation = {...}`，
 * 少一个键、多一个键或结构不符，都会在编译期报错。
 *
 * 新增一种语言：
 *   1. 在 src/config/languages.ts 的 Lang 与 LANGUAGES 里加上它
 *   2. 复制 zh-Hans.ts 改名，翻译内容
 *   3. 在下面 import 并加进 LOCALES
 */
import type { Lang } from '@/config/languages'
import zhHans from './zh-Hans'
import zhHant from './zh-Hant'
import en from './en'
import es from './es'
import fr from './fr'
import it from './it'
import de from './de'
import ja from './ja'

/** 全站文案的结构（由简体中文推导） */
export type Translation = typeof zhHans

export const LOCALES: Record<Lang, Translation> = {
  'zh-Hans': zhHans,
  'zh-Hant': zhHant,
  en,
  es,
  fr,
  it,
  de,
  ja,
}

export { zhHans }
