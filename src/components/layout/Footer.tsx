import { Link } from 'react-router-dom'
import { CONTACT_EMAIL, SITE_NAME } from './Logo'
import { footerLinksFor } from './nav'
import { useT } from '@/services/i18n'

/**
 * 精简页脚：仪表盘布局下只保留一行链接与版权信息，底下再压一段版权免责声明。
 *
 * 免责声明单独一行、不挤进上面那行：它是长句，放进 flex 行会把链接和版权挤散，
 * 移动端更是直接把页脚撑成一大坨。分成两块之后上面那行的布局一个字都不用改。
 */
export function Footer() {
  const t = useT()
  const year = new Date().getFullYear()
  // 声明里写了「请联系我们处理」，那这句话就得真的能点 —— 把 {contact} 换成 mailto。
  // 拆成两段而不是用 fmt()：fmt 返回字符串，塞不进 <a>。
  const [beforeContact, afterContact] = t.footer.disclaimer.split('{contact}')
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
      <div className="border-t border-line px-4 py-4 sm:px-6 lg:px-8">
        <p className="max-w-4xl text-[11px] leading-6 text-dim">
          {beforeContact}
          {afterContact !== undefined && (
            <>
              <a
                href={`mailto:${CONTACT_EMAIL}`}
                className="underline underline-offset-2 transition hover:text-fg"
              >
                {t.footer.disclaimerContact}
              </a>
              {afterContact}
            </>
          )}
        </p>
      </div>
    </footer>
  )
}
