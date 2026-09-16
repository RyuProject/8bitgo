import { Link } from 'react-router-dom'
import { SITE_NAME } from './Logo'
import { footerLinksFor } from './nav'
import { useT } from '@/services/i18n'

/**
 * 精简页脚：一行链接 + 一行版权信息。版权只写归属声明（游戏内容归各自所有者），
 * 不堆免责长句——之前那句「仅供个人学习研究 / 非盈利 / 联系我们下架」已经拿掉了。
 *
 * 2026-09-16：归属声明后面跟一个「版权声明」入口。锚到服务条款里「游戏文件与知识产权」
 * 那一节（#game-files）——那正是这句话的展开版：写明游戏权利不属于本站、作品分几类、
 * 以及「通知即下架」的做法。站内没有独立的版权声明页，别去新建一个内容重复的。
 * hash 滚动由 Layout.tsx 的 RouteEffects 接管，不用在这里自己 scrollIntoView。
 */
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
          © {year} {SITE_NAME} · {t.footer.copyright}{' '}
          <Link to="/terms#game-files" className="transition hover:text-fg">
            {t.footer.copyrightNotice}
          </Link>
        </p>
      </div>
    </footer>
  )
}
