import { Button } from '@/components/ui/Button'
import { markSsrNotFound, useSeo } from '@/services/seo'
import { useT } from '@/services/i18n'

export function NotFoundPage({ message }: { message?: string }) {
  const t = useT()
  // 渲染期间打个标记，让服务端把 HTTP 状态码改成 404 而不是 200。
  // 在 render 里直接调是安全的：renderToString 同步执行，一次只处理一个请求。
  if (import.meta.env.SSR) markSsrNotFound()
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
