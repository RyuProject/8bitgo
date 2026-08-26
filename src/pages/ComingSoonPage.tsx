import { useLocation } from 'react-router-dom'
import type { Translation } from '@/locales'
import { Button } from '@/components/ui/Button'
import { useSeo } from '@/services/seo'
import { useT } from '@/services/i18n'

function featuresFor(t: Translation): Record<string, { icon: string; title: string; desc: string }> {
  return {
    '/apps': {
      icon: '🧩',
      title: t.soon.appsTitle,
      desc: t.soon.appsDesc,
    },
    '/about': { icon: '🕹️', title: t.soon.aboutTitle, desc: t.soon.aboutDesc },
    '/terms': { icon: '📄', title: t.soon.termsTitle, desc: t.soon.termsDesc },
    '/privacy': { icon: '🔒', title: t.soon.privacyTitle, desc: t.soon.privacyDesc },
    '/tv': { icon: '📺', title: '8BitGo TV', desc: t.soon.tvDesc },
  }
}

export function ComingSoonPage() {
  const { pathname } = useLocation()
  const t = useT()
  const feature = featuresFor(t)[pathname] ?? { icon: '🚧', title: t.soon.fallbackTitle, desc: t.soon.fallbackDesc }
  // 占位页内容太薄，先不收录，等正式上线再放开
  useSeo({ title: feature.title, description: feature.desc, noindex: true })

  return (
    <div className="container-x flex min-h-[60vh] flex-col items-center justify-center py-20 text-center">
      <span className="grid h-20 w-20 place-items-center rounded-3xl bg-brand-soft text-4xl" aria-hidden>
        {feature.icon}
      </span>
      <span className="text-pixel mt-6 text-[11px] text-coin">COMING SOON</span>
      <h1 className="mt-3 text-3xl font-extrabold tracking-tight">{feature.title}</h1>
      <p className="mt-3 max-w-md leading-relaxed text-muted">{feature.desc}</p>
      <div className="mt-8 flex gap-3">
        <Button to="/games">{t.soon.goPlay}</Button>
        <Button to="/" variant="secondary">
          {t.common.backHome}
        </Button>
      </div>
    </div>
  )
}
