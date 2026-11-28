import type { Lang } from '@/config/languages'
import type { LegalDocCopy } from './types'

export interface LegalPages {
  terms: LegalDocCopy
  privacy: LegalDocCopy
}

const loadEnglish = async (): Promise<LegalPages> => {
  const pages = await import('./en')
  return { terms: pages.termsEnglish, privacy: pages.privacyEnglish }
}

const LOADERS: Record<Lang, () => Promise<LegalPages>> = {
  'zh-Hans': async () => {
    const pages = await import('./zh-Hans')
    return { terms: pages.termsZhHans, privacy: pages.privacyZhHans }
  },
  'zh-Hant': async () => {
    const pages = await import('./zh-Hant')
    return { terms: pages.termsZhHant, privacy: pages.privacyZhHant }
  },
  en: loadEnglish,
  es: loadEnglish,
  fr: loadEnglish,
  it: loadEnglish,
  de: loadEnglish,
  ja: loadEnglish,
}

const loaded = new Map<Lang, LegalPages>()
const pending = new Map<Lang, Promise<LegalPages>>()

export function getLoadedLegalPages(lang: Lang): LegalPages | undefined {
  return loaded.get(lang)
}

/** 法律正文只在对应路由需要时加载；未加载完成的 Promise 按语言合并，避免重复取同一块。 */
export function loadLegalPages(lang: Lang): Promise<LegalPages> {
  const hit = loaded.get(lang)
  if (hit) return Promise.resolve(hit)
  const inFlight = pending.get(lang)
  if (inFlight) return inFlight

  const request = LOADERS[lang]().then((pages) => {
    loaded.set(lang, pages)
    return pages
  }).finally(() => {
    pending.delete(lang)
  })
  pending.set(lang, request)
  return request
}
