import { Button } from '@/components/ui/Button'
import { useSeo } from '@/services/seo'
import { useT } from '@/services/i18n'

export function NotFoundPage({ message }: { message?: string }) {
  const t = useT()
  useSeo({ title: t.notFound.title, noindex: true })
  return (
    <div className="container-x flex min-h-[60vh] flex-col items-center justify-center py-20 text-center">
      <p className="text-pixel text-4xl text-brand-hover sm:text-6xl">404</p>
      <p className="mt-6 text-xl font-bold">GAME OVER</p>
      <p className="mt-2 max-w-md text-sm text-muted">{message ?? t.notFound.message}</p>
      <div className="mt-8 flex gap-3">
        <Button to="/">{t.common.backHome}</Button>
        <Button to="/games" variant="secondary">
          {t.common.browseGames}
        </Button>
      </div>
    </div>
  )
}
