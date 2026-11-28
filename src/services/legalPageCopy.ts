import { useEffect, useState } from 'react'
import type { Lang } from '@/config/languages'
import { getLoadedLegalPages, loadLegalPages } from '@/locales/legal'
import type { LegalDocCopy } from '@/locales/legal/types'
import { useLang } from './lang'

type LegalPage = keyof import('@/locales/legal').LegalPages

/** 直达法律页由 SSR 与客户端入口先预热；站内跳转时再按需取正文。 */
export function useLegalPageCopy(page: LegalPage): LegalDocCopy | null {
  const lang = useLang() as Lang
  const [copy, setCopy] = useState<LegalDocCopy | null>(() => getLoadedLegalPages(lang)?.[page] ?? null)

  useEffect(() => {
    let active = true
    const hit = getLoadedLegalPages(lang)
    if (hit) {
      setCopy(hit[page])
      return () => { active = false }
    }

    setCopy(null)
    void loadLegalPages(lang)
      .then((pages) => { if (active) setCopy(pages[page]) })
      .catch(() => { if (active) setCopy(null) })
    return () => { active = false }
  }, [lang, page])

  return copy
}
