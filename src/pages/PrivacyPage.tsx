import { LegalDoc } from './LegalDoc'
import { PageSkeleton } from '@/components/ui/PageSkeleton'
import { useLegalPageCopy } from '@/services/legalPageCopy'

/** 隐私政策。内容全在 src/locales/legal/ 里，这里只挑语言。 */
export function PrivacyPage() {
  const copy = useLegalPageCopy('privacy')
  return copy ? <LegalDoc copy={copy} path="/privacy" /> : <PageSkeleton />
}
