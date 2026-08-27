/** 站点支持的语言。界面文字暂未翻译（后续分批做），但语言状态已用于「按语言选 ROM」。 */
export type Lang = 'zh-Hans' | 'zh-Hant' | 'en' | 'es' | 'fr' | 'it' | 'de' | 'ja'

export interface LanguageDef {
  code: Lang
  /** 该语言的自称 */
  label: string
  /** 英文名（辅助显示） */
  english: string
}

export const LANGUAGES: LanguageDef[] = [
  { code: 'zh-Hans', label: '简体中文', english: 'Simplified Chinese' },
  { code: 'zh-Hant', label: '繁體中文', english: 'Traditional Chinese' },
  { code: 'en', label: 'English', english: 'English' },
  { code: 'es', label: 'Español', english: 'Spanish' },
  { code: 'fr', label: 'Français', english: 'French' },
  { code: 'it', label: 'Italiano', english: 'Italian' },
  { code: 'de', label: 'Deutsch', english: 'German' },
  { code: 'ja', label: '日本語', english: 'Japanese' },
]

export const DEFAULT_LANG: Lang = 'zh-Hans'

/**
 * ROM 语言槽：游戏可为这几种语言分别上传 ROM。
 * 站点支持的八种语言现在都有专属槽 —— 某款游戏没上传某个语言的 ROM 时，
 * 按语言选 ROM 会回退到英语（见 effectiveRomKey），所以「有槽」不等于「必须填」。
 *
 * 用 Extract 而不是直接写字面量联合：这样打错一个语言代码会在编译期就报错，
 * 而不是悄悄多出一个站点根本不支持的 ROM 槽。
 *
 * ⚠️ 加语言只改这里就够了 —— game_roms.lang 是 VARCHAR(10) 不是 ENUM，
 * 后端 romsOf() 也不对键做白名单，所以不需要改库、不需要迁移；
 * 已有游戏的 roms 里没有新语言的键，effectiveRomKey 会照常回退到英语。
 */
export type RomLang = Extract<Lang, 'zh-Hans' | 'zh-Hant' | 'en' | 'ja' | 'fr' | 'de' | 'es' | 'it'>
export const ROM_LANGS: RomLang[] = ['zh-Hans', 'zh-Hant', 'en', 'ja', 'fr', 'de', 'es', 'it']

/**
 * 槽位显示名直接取 LANGUAGES 里的自称，不再手抄一份 ——
 * 以前是两处各写一遍，改了一处忘了另一处就会对不上。
 */
export const ROM_LANG_LABEL: Record<RomLang, string> = ROM_LANGS.reduce(
  (acc, code) => {
    acc[code] = LANGUAGES.find((l) => l.code === code)?.label ?? code
    return acc
  },
  {} as Record<RomLang, string>,
)

/** 站点语言 → ROM 语言槽；没有专属槽的语言回退到英语 */
export function romLangFor(lang: Lang): RomLang {
  return (ROM_LANGS as string[]).includes(lang) ? (lang as RomLang) : 'en'
}

/* ---------------- URL 里的语言前缀 ---------------- */

/**
 * 语言体现在路径前缀上：
 *   默认语言（简体中文）不带前缀： /games
 *   其它语言带前缀：              /en/games、/ja/games
 *
 * 默认语言不加前缀是刻意的——站点已有的链接和收录不会失效，也不用做全站 301。
 */
export const LANG_CODES: Lang[] = LANGUAGES.map((l) => l.code)

export function isLang(x: string): x is Lang {
  return (LANG_CODES as string[]).includes(x)
}

/** 该语言的路径前缀：默认语言是 ''，其它是 '/en' 这样 */
export function langPrefix(lang: Lang): string {
  return lang === DEFAULT_LANG ? '' : '/' + lang
}

/** 从 pathname 解析语言；没有已知前缀就是默认语言 */
export function langFromPath(pathname: string): Lang {
  const seg = pathname.split('/').filter(Boolean)[0]
  return seg && isLang(seg) ? seg : DEFAULT_LANG
}

/** 去掉语言前缀，得到「与语言无关」的路径，始终以 / 开头 */
export function stripLang(pathname: string): string {
  const parts = pathname.split('/').filter(Boolean)
  if (parts[0] && isLang(parts[0])) parts.shift()
  return '/' + parts.join('/')
}

/** 把与语言无关的路径拼成某个语言下的完整路径 */
export function localizedPath(pathname: string, lang: Lang): string {
  const bare = stripLang(pathname)
  const prefix = langPrefix(lang)
  if (bare === '/') return prefix || '/'
  return prefix + bare
}

/** hreflang 用的标准语言标记（zh-Hans / zh-Hant 保留脚本写法，其余用两字母） */
export const HREFLANG: Record<Lang, string> = {
  'zh-Hans': 'zh-Hans',
  'zh-Hant': 'zh-Hant',
  en: 'en',
  es: 'es',
  fr: 'fr',
  it: 'it',
  de: 'de',
  ja: 'ja',
}
