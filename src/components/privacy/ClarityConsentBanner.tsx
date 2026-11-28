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
 * SSR 与水合首帧都画同一份横幅；已有选择的浏览器由 head 脚本先标记，再用 CSS 隐藏，避免晚到横幅拖慢 LCP。
 */
export function ClarityConsentBanner() {
  const t = useT()
  // SSR 与客户端首帧都先画出来；已选过的访客由 index.html 的早期脚本加属性隐藏，避免水合后才出现并拖慢 LCP。
  const [open, setOpen] = useState(true)
  const [choice, setChoice] = useState<ClarityConsent | null>(null)

  const markConsent = (consent: ClarityConsent | null) => {
    if (typeof document === 'undefined') return
    if (consent) document.documentElement.dataset.clarityConsent = consent
    else delete document.documentElement.dataset.clarityConsent
  }

  useEffect(() => {
    if (!clarityConfigured()) return

    const sync = () => {
      const stored = readClarityConsent()
      setChoice(stored)
      markConsent(stored)
    }
    const show = () => {
      sync()
      markConsent(null)
      setOpen(true)
    }

    const stored = readClarityConsent()
    setChoice(stored)
    setOpen(stored === null)
    markConsent(stored)

    const offChanged = onClarityConsentChanged(sync)
    const offOpen = onOpenClarityPreferences(show)
    return () => {
      offChanged()
      offOpen()
    }
  }, [])

  if (!open || !clarityConfigured()) return null

  const choose = (next: ClarityConsent) => {
    setClarityConsent(next)
    setChoice(next)
    markConsent(next)
    setOpen(false)
  }

  /*
    z-[45]：高于正文、顶栏（30）和抽屉遮罩（40），但低于移动抽屉本体（50）、站内信抽屉（60/61）、
    移动端游玩舞台（60）和所有弹窗（80）。以前和弹窗同为 z-[80] 且挂得更晚，会盖住登录表单底部、
    抽屉底部的「登录 / 注册」，以及手机游玩时舞台底部的触屏手柄。
  */
  return (
    <section
      role="region"
      aria-label={t.clarityConsent.title}
      /* PSI 曾命中横幅里的说明文字；不透明底色已足够清晰，避免 backdrop-filter 额外采样和合成首屏内容。 */
      className="clarity-consent-banner fixed inset-x-3 bottom-3 z-[45] mx-auto max-w-3xl rounded-3xl border-2 border-line-strong bg-surface p-4 shadow-2xl sm:bottom-5 sm:p-5"
    >
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0">
          <h2 className="text-sm font-black text-fg">{t.clarityConsent.title}</h2>
          <p className="mt-1 text-xs leading-relaxed text-muted">
            {t.clarityConsent.body}{' '}
            <Link to="/privacy#third-parties" className="font-bold text-brand-hover hover:underline">
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
