import { Link } from 'react-router-dom'
import { LANGUAGES } from '@/config/languages'
import { romLanguageLabel } from '@/data/rom-language-labels'
import { useT } from '@/services/i18n'
import { useLang } from '@/services/lang'
import { chipClasses } from '@/components/ui/Button'
import { cx } from '@/lib/format'

interface RomLanguageLinksProps {
  languages?: Array<{ id: string; count: number }>
  className?: string
}

/** 给搜索爬虫和玩家都提供普通链接；空语言不生成没有内容的目录入口。 */
export function RomLanguageLinks({ languages, className }: RomLanguageLinksProps) {
  const t = useT()
  const uiLanguage = useLang()
  const items = (languages ?? []).filter(({ id, count }) => count > 0 && LANGUAGES.some(({ code }) => code === id))
  if (!items.length) return null

  return (
    <nav className={cx('flex flex-wrap items-center gap-2', className)} aria-label={t.games.filterRomLanguage}>
      <span className="mr-1 text-xs font-semibold text-muted">{t.games.filterRomLanguage}</span>
      {items.map(({ id, count }) => (
        <Link key={id} to={`/rom-language/${encodeURIComponent(id)}`} className={chipClasses(false)}>
          {romLanguageLabel(uiLanguage, id)} <span className="opacity-60">{count}</span>
        </Link>
      ))}
    </nav>
  )
}
