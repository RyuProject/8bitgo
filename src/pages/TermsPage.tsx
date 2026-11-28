import { LegalDoc } from './LegalDoc'
import { getLoadedLegalLocale } from '@/locales'
import { getLang } from '@/services/lang'

/** 服务条款。内容全在 src/locales/legal/ 里，这里只挑语言。 */
export function TermsPage() {
  const copy = getLoadedLegalLocale(getLang())?.termsPage
  if (!copy) throw new Error('服务条款文案未预载')
  return <LegalDoc copy={copy} path="/terms" />
}
