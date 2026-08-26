import { useEffect } from 'react'
import { useT, fmt } from '@/services/i18n'

const SITE = import.meta.env.VITE_SITE_NAME ?? '8BitGo'

export function useDocumentTitle(title?: string) {
  const t = useT()
  useEffect(() => {
    const fallback = fmt(t.site.defaultTitle, { site: SITE })
    document.title = title ? fmt(t.site.titleTemplate, { title, site: SITE }) : fallback
    return () => {
      document.title = fallback
    }
  }, [title, t])
}
