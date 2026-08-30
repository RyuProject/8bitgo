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
 * 兜底语言：浏览器语言不在上面这 8 种里时（俄语、韩语、葡萄牙语……）用它。
 * 也是 hreflang 的 x-default 指向的语言 —— 「其它所有人看这个版本」。
 *
 * 和 DEFAULT_LANG 是两回事，别混：
 *   DEFAULT_LANG  = 裸路径 `/games` 渲染成哪种语言（站点母语，简体中文）
 *   FALLBACK_LANG = 认不出访客语言时把他送到哪（国际通用，英语）
 */
export const FALLBACK_LANG: Lang = 'en'

/**
 * ROM 语言槽：游戏可为这几种语言分别上传 ROM。
 * 站点支持的八种语言现在都有专属槽 —— 某款游戏没上传某个语言的 ROM 时，
 * 按语言选 ROM 会依次回退到英语、日语、中文（见 romCandidates），所以「有槽」不等于「必须填」。
 *
 * 用 Extract 而不是直接写字面量联合：这样打错一个语言代码会在编译期就报错，
 * 而不是悄悄多出一个站点根本不支持的 ROM 槽。
 *
 * ⚠️ 加语言只改这里就够了 —— game_roms.lang 是 VARCHAR(10) 不是 ENUM，
 * 后端 romsOf() 也不对键做白名单，所以不需要改库、不需要迁移；
 * 已有游戏的 roms 里没有新语言的键，romCandidates 会照常走完整回退链。
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

/* ---------------- 浏览器语言匹配 ---------------- */

/**
 * 只按前缀直接对应的语言（中文另有繁简之分，单独处理）。
 * 用 Extract 保证这里写错一个代码会在编译期报错，而不是悄悄永远匹配不上。
 */
const SIMPLE_MATCH: Extract<Lang, 'en' | 'es' | 'fr' | 'it' | 'de' | 'ja'>[] = ['en', 'es', 'fr', 'it', 'de', 'ja']

/**
 * 把浏览器给的语言标记列表（navigator.languages）映射成站点语言。
 *
 * 这是匹配规则的**唯一出处**。index.html 头部那段自动跳转脚本必须内联
 * （要在首屏绘制前跑完，来不及等模块加载），所以那边不可避免地抄了一份 ——
 * scripts/test-lang-detect.mjs 会把两边逐个语言标记对一遍，改了一处忘了另一处会红。
 *
 * 规则：
 *   zh 开头       -> 带 Hans 的算简体；带 Hant / -TW / -HK / -MO 的算繁体；其余（zh、zh-CN、zh-SG）算简体
 *   en/es/fr/it/de/ja 开头 -> 对应语言
 *   一个都对不上  -> null，由调用方决定用 FALLBACK_LANG 还是不动
 *
 * 按顺序取第一个能对上的 —— navigator.languages 本身就是按用户偏好排好序的。
 */
export function matchBrowserLang(tags: readonly string[]): Lang | null {
  for (const raw of tags) {
    const tag = String(raw ?? '').toLowerCase()
    if (!tag) continue

    if (tag.startsWith('zh')) {
      // hans 要先判：zh-Hans-HK 这种既有 hans 又有 hk，简繁标注比地区码更权威
      if (tag.includes('hans')) return 'zh-Hans'
      if (tag.includes('hant') || /-(tw|hk|mo)\b/.test(tag)) return 'zh-Hant'
      return 'zh-Hans'
    }

    const base = tag.split('-')[0]
    const hit = SIMPLE_MATCH.find((code) => code === base)
    if (hit) return hit
  }
  return null
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
