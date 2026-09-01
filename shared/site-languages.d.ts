export interface SiteLanguage {
  readonly code: 'zh-Hans' | 'zh-Hant' | 'en' | 'es' | 'fr' | 'it' | 'de' | 'ja'
  readonly label: string
  readonly english: string
  readonly hreflang: string
}

export const SITE_LANGUAGES: readonly SiteLanguage[]
export const SITE_DEFAULT_LANGUAGE: 'zh-Hans'
export const SITE_FALLBACK_LANGUAGE: 'en'
