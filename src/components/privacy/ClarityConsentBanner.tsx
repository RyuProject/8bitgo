import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { Button } from '@/components/ui/Button'
import {
  clarityConfigured,
  onClarityConsentChanged,
  onOpenClarityPreferences,
  readClarityConsent,
  setClarityConsent,
  type ClarityConsent,
} from '@/services/clarity'
import { useT } from '@/services/i18n'

/**
 * Clarity 会生成会话回放与热图，因此必须在访客明确同意之后才加载远端脚本。
 * 首次客户端 effect 之前保持空白，避免 SSR 与 hydration 因 localStorage 状态不同而重建。
 */
export function ClarityConsentBanner() {
  const t = useT()
  const [ready, setReady] = useState(false)
  const [open, setOpen] = useState(false)
  const [choice, setChoice] = useState<ClarityConsent | null>(null)

  useEffect(() => {
    if (!clarityConfigured()) return

    const sync = () => setChoice(readClarityConsent())
    const show = () => {
      sync()
      setOpen(true)
    }

    const stored = readClarityConsent()
    setChoice(stored)
    setOpen(stored === null)
    setReady(true)

    const offChanged = onClarityConsentChanged(sync)
    const offOpen = onOpenClarityPreferences(show)
    return () => {
      offChanged()
      offOpen()
    }
  }, [])

  if (!ready || !open || !clarityConfigured()) return null

  const choose = (next: ClarityConsent) => {
    setClarityConsent(next)
    setChoice(next)
    setOpen(false)
  }

  return (
    <section
      role="region"
      aria-label={t.clarityConsent.title}
      className="fixed inset-x-3 bottom-3 z-[80] mx-auto max-w-3xl rounded-3xl border-2 border-line-strong bg-surface/95 p-4 shadow-2xl backdrop-blur sm:bottom-5 sm:p-5"
    >
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0">
          <h2 className="text-sm font-black text-fg">{t.clarityConsent.title}</h2>
          <p className="mt-1 text-xs leading-relaxed text-muted">
            {t.clarityConsent.body}{' '}
            <Link to="/privacy#third-parties" className="font-bold text-brand hover:underline">
              {t.clarityConsent.learnMore}
            </Link>
          </p>
          {choice !== null && <p className="mt-1 text-[11px] text-dim">{t.clarityConsent.currentChoice}</p>}
        </div>
        <div className="flex shrink-0 flex-wrap gap-2 sm:justify-end">
          <Button size="sm" variant="secondary" onClick={() => choose('denied')}>
            {t.clarityConsent.decline}
          </Button>
          <Button size="sm" onClick={() => choose('granted')}>
            {t.clarityConsent.accept}
          </Button>
        </div>
      </div>
    </section>
  )
}
