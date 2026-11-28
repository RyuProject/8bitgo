import { LegalDoc } from './LegalDoc'
import { PageSkeleton } from '@/components/ui/PageSkeleton'
import { useLegalPageCopy } from '@/services/legalPageCopy'

/** 服务条款。内容全在 src/locales/legal/ 里，这里只挑语言。 */
export function TermsPage() {
  const copy = useLegalPageCopy('terms')
  return copy ? <LegalDoc copy={copy} path="/terms" /> : <PageSkeleton />
}
