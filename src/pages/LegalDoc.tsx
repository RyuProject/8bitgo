import { Link } from 'react-router-dom'
import type { LegalDocCopy } from '@/locales/legal/types'
import { renderMarkdown } from '@/lib/markdown'
import { useSeo, breadcrumbSchema } from '@/services/seo'
import { useT } from '@/services/i18n'

/**
 * 服务条款 / 隐私政策共用的排版外壳。
 *
 * 两页的差别只有文案，所以壳只写一份 —— 否则改一次目录样式要改两个文件，
 * 迟早只改一边（这个仓库里 seo 那几处重复就是这么来的）。
 *
 * 三个选型说明：
 *
 * 1. **正文走 renderMarkdown，节标题由组件渲染。**
 *    renderMarkdown 不给标题挂 id（见 src/lib/markdown.tsx），而法律文本必须能被
 *    「条款第 X 条」这种外部引用直接锚过去，所以 h2 从 section.title 渲染并挂上
 *    section.id，body 里的小标题从 ### 起。
 *
 * 2. **不用 noindex。** 这两页必须能被收录：应用商店和第三方登录的审核会去抓它，
 *    抓不到等于没有。useSeo 只要不传 noindex，canonical 和八种语言的 hreflang
 *    就都是自动的（见 services/seo.ts）。
 *
 * 3. **目录用原生 #锚点，不做 scrollIntoView。** 服务端渲染出来就是可点的普通链接，
 *    JS 没加载完也能用；scroll-mt-20 是为了不被吸顶导航盖住（照抄 AboutPage 的 #story）。
 */
export function LegalDoc({ copy, path }: { copy: LegalDocCopy; path: '/terms' | '/privacy' }) {
  const t = useT()

  useSeo({
    title: copy.seoTitle,
    description: copy.seoDescription,
    canonicalPath: path,
    updatedTime: copy.updated,
    jsonLd: [
      {
        '@context': 'https://schema.org',
        '@type': 'WebPage',
        name: copy.seoTitle,
        description: copy.seoDescription,
        // dateModified 用文案里的 updated —— 法律文本的「最后更新」是内容属性，
        // 不能拿构建时间或部署时间冒充
        dateModified: copy.updated,
        publisher: { '@type': 'Organization', name: '8BitGo', url: 'https://8bitgo.com' },
      },
      breadcrumbSchema([
        { name: t.common.home, path: '/' },
        { name: copy.h1, path },
      ]),
    ],
  })

  return (
    <div className="container-x py-8 sm:py-10">
      <nav className="text-xs text-muted" aria-label={t.common.breadcrumb}>
        <Link to="/" className="hover:text-fg">
          {t.common.home}
        </Link>
        <span className="mx-1.5">/</span>
        <span className="text-fg">{copy.h1}</span>
      </nav>

      <article className="mx-auto mt-6 max-w-3xl">
        <h1 className="text-3xl font-extrabold tracking-tight sm:text-4xl">{copy.h1}</h1>
        <p className="mt-3 text-sm text-muted">
          {copy.updatedLabel}
          <span className="mx-1.5">·</span>
          {/* dateTime 用 ISO 原值，展示值也用它 —— 法律文本的日期不做本地化格式，
              免得同一份条款在不同语言下看起来是两个日期 */}
          <time dateTime={copy.updated}>{copy.updated}</time>
        </p>

        <div className="prose-pixel mt-6">{renderMarkdown(copy.intro)}</div>

        {/* 目录 */}
        <nav
          aria-label={copy.tocLabel}
          className="mt-8 rounded-2xl border-2 border-line bg-surface p-5 shadow-[0_4px_0_0_var(--color-line)]"
        >
          <h2 className="text-pixel text-[11px] tracking-wider text-brand-hover">{copy.tocLabel}</h2>
          <ol className="mt-3 grid gap-x-6 gap-y-1.5 text-sm sm:grid-cols-2">
            {copy.sections.map((s, i) => (
              <li key={s.id} className="flex gap-2">
                <span className="shrink-0 tabular-nums text-muted">{i + 1}.</span>
                <a
                  href={`#${s.id}`}
                  className="text-muted underline-offset-4 hover:text-fg hover:underline"
                >
                  {s.title}
                </a>
              </li>
            ))}
          </ol>
        </nav>

        {copy.sections.map((s, i) => (
          <section key={s.id} id={s.id} className="mt-10 scroll-mt-20">
            <h2 className="text-xl font-extrabold tracking-tight sm:text-2xl">
              <span className="mr-2 tabular-nums text-muted">{i + 1}.</span>
              {s.title}
            </h2>
            <div className="prose-pixel mt-3">{renderMarkdown(s.body)}</div>
          </section>
        ))}
      </article>
    </div>
  )
}
