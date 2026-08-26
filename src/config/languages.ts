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
 * 其它站点语言（西/法/意/德）没有专属 ROM，按语言选 ROM 时统一回退到英语。
 */
export type RomLang = 'zh-Hans' | 'zh-Hant' | 'en' | 'ja'
export const ROM_LANGS: RomLang[] = ['zh-Hans', 'zh-Hant', 'en', 'ja']

export const ROM_LANG_LABEL: Record<RomLang, string> = {
  'zh-Hans': '简体中文',
  'zh-Hant': '繁體中文',
  en: 'English',
  ja: '日本語',
}

/** 站点语言 → ROM 语言槽；没有专属槽的语言回退到英语 */
export function romLangFor(lang: Lang): RomLang {
  return (ROM_LANGS as string[]).includes(lang) ? (lang as RomLang) : 'en'
}
