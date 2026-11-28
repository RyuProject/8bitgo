import { LegalDoc } from './LegalDoc'
import { getLoadedLegalLocale } from '@/locales'
import { getLang } from '@/services/lang'

/** 隐私政策。内容全在 src/locales/legal/ 里，这里只挑语言。 */
export function PrivacyPage() {
  const copy = getLoadedLegalLocale(getLang())?.privacyPage
  if (!copy) throw new Error('隐私政策文案未预载')
  return <LegalDoc copy={copy} path="/privacy" />
}
