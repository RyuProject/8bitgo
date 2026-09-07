import { LegalDoc } from './LegalDoc'
import { useT } from '@/services/i18n'

/** 服务条款。内容全在 src/locales/legal/ 里，这里只挑语言。 */
export function TermsPage() {
  return <LegalDoc copy={useT().termsPage} path="/terms" />
}
