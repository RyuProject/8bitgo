import type { Lang } from '@/config/languages'

/** ROM 语言选项使用当前 UI 语言显示，避免语言代码让玩家猜是哪一版。 */
const LABELS: Record<Lang, Record<Lang, string>> = {
  'zh-Hans': {
    'zh-Hans': '简体中文', 'zh-Hant': '繁体中文', en: '英语', es: '西班牙语',
    fr: '法语', it: '意大利语', de: '德语', ja: '日语',
  },
  'zh-Hant': {
    'zh-Hans': '簡體中文', 'zh-Hant': '繁體中文', en: '英文', es: '西班牙文',
    fr: '法文', it: '義大利文', de: '德文', ja: '日文',
  },
  en: {
    'zh-Hans': 'Simplified Chinese', 'zh-Hant': 'Traditional Chinese', en: 'English', es: 'Spanish',
    fr: 'French', it: 'Italian', de: 'German', ja: 'Japanese',
  },
  es: {
    'zh-Hans': 'chino simplificado', 'zh-Hant': 'chino tradicional', en: 'inglés', es: 'español',
    fr: 'francés', it: 'italiano', de: 'alemán', ja: 'japonés',
  },
  fr: {
    'zh-Hans': 'chinois simplifié', 'zh-Hant': 'chinois traditionnel', en: 'anglais', es: 'espagnol',
    fr: 'français', it: 'italien', de: 'allemand', ja: 'japonais',
  },
  it: {
    'zh-Hans': 'cinese semplificato', 'zh-Hant': 'cinese tradizionale', en: 'inglese', es: 'spagnolo',
    fr: 'francese', it: 'italiano', de: 'tedesco', ja: 'giapponese',
  },
  de: {
    'zh-Hans': 'Vereinfachtes Chinesisch', 'zh-Hant': 'Traditionelles Chinesisch', en: 'Englisch', es: 'Spanisch',
    fr: 'Französisch', it: 'Italienisch', de: 'Deutsch', ja: 'Japanisch',
  },
  ja: {
    'zh-Hans': '簡体字中国語', 'zh-Hant': '繁体字中国語', en: '英語', es: 'スペイン語',
    fr: 'フランス語', it: 'イタリア語', de: 'ドイツ語', ja: '日本語',
  },
}

export function romLanguageLabel(uiLanguage: Lang, romLanguage: string): string {
  return LABELS[uiLanguage]?.[romLanguage as Lang] ?? romLanguage
}
