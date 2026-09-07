import { LegalDoc } from './LegalDoc'
import { useT } from '@/services/i18n'

/** 隐私政策。内容全在 src/locales/legal/ 里，这里只挑语言。 */
export function PrivacyPage() {
  return <LegalDoc copy={useT().privacyPage} path="/privacy" />
}
