import { Link } from 'react-router-dom'
import { SITE_NAME } from './Logo'
import { footerLinksFor } from './nav'
import { useT } from '@/services/i18n'

/** 精简页脚：仪表盘布局下只保留一行链接与版权信息 */
export function Footer() {
  const t = useT()
  const year = new Date().getFullYear()
  return (
    <footer className="mt-12">
      <div className="flex flex-col gap-3 px-4 py-5 text-xs text-dim sm:px-6 md:flex-row md:items-center md:justify-between lg:px-8">
        <nav className="flex flex-wrap gap-x-4 gap-y-2" aria-label={t.footer.aria}>
          {footerLinksFor(t).map((l) => (
            <Link key={l.to} to={l.to} className="transition hover:text-fg">
              {l.label}
            </Link>
          ))}
        </nav>
        <p className="leading-relaxed">
          © {year} {SITE_NAME} · {t.footer.copyright} · <span className="text-pixel text-[10px]">v0.9.19</span>
        </p>
      </div>
    </footer>
  )
}
