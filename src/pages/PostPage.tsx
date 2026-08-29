import { Link, useParams } from 'react-router-dom'
import { readMinutes, usePublishedPosts } from '@/services/posts'
import { renderMarkdown } from '@/lib/markdown'
import { gradientFor } from '@/lib/gradients'
import { useSeo, articleSchema, breadcrumbSchema } from '@/services/seo'
import { useT, fmt } from '@/services/i18n'
import { NotFoundPage } from './NotFoundPage'
import { SkeletonBlock } from '@/components/ui/PageSkeleton'

export function PostPage() {
  const { slug = '' } = useParams<{ slug: string }>()
  const t = useT()
  // 文章总量不大，/blog 一次就把已发布的全给了，单篇直接在里面找 ——
  // 没必要为一篇文章再单独打一次请求
  const { posts, loading } = usePublishedPosts()
  const post = posts.find((p) => p.slug === slug)
  // 还在加载时不能当成「文章不存在」—— 否则每次进详情页都会先闪一下 404
  const missing = !loading && !post
  // SEO：hook 要在下面的 early return 之前调用，文章不存在时走 noindex 分支
  const excerpt = post ? plainText(post.excerpt) : ''
  useSeo(
    post
      ? {
          title: post.title,
          description: excerpt,
          type: 'article',
          jsonLd: [
            articleSchema({
              title: post.title,
              slug: post.slug,
              excerpt,
              date: post.date,
              author: post.author,
            }),
            breadcrumbSchema([
              { name: t.common.home, path: '/' },
              { name: t.common.blog, path: '/blog' },
              { name: post.title, path: `/blog/${post.slug}` },
            ]),
          ],
        }
      : { title: t.blog.notFoundTitle, noindex: true },
  )

  if (missing) return <NotFoundPage message={t.blog.notFoundMsg} />
  // 还在取数：按文章真实排版占位，别渲染 404，也别留一大块没有反馈的空白。
  if (!post) return <PostSkeleton />

  const more = posts
    .filter((p) => p.slug !== post.slug)
    .slice(0, 3)

  return (
    <div className="container-x py-8 sm:py-10">
      <nav className="text-xs text-muted" aria-label={t.common.breadcrumb}>
        <Link to="/" className="hover:text-fg">
          {t.common.home}
        </Link>
        <span className="mx-1.5">/</span>
        <Link to="/blog" className="hover:text-fg">
          {t.common.blog}
        </Link>
        <span className="mx-1.5">/</span>
        <span className="text-fg">{post.title}</span>
      </nav>

      <article className="mx-auto mt-6 max-w-3xl">
        <div className="relative grid h-40 place-items-center overflow-hidden rounded-card text-7xl sm:h-52" style={{ background: gradientFor(post.slug) }} aria-hidden>
          <span className="pixel-grid absolute inset-0 opacity-60" />
          <span className="relative drop-shadow">{post.icon}</span>
        </div>

        <header className="mt-6">
          <div className="flex flex-wrap gap-1.5">
            {post.tags.map((t) => (
              <Link key={t} to={`/blog?tag=${encodeURIComponent(t)}`} className="rounded bg-brand-soft px-1.5 py-0.5 text-[11px] font-semibold text-brand-hover hover:underline">
                {t}
              </Link>
            ))}
          </div>
          <h1 className="mt-3 text-3xl font-extrabold leading-tight tracking-tight sm:text-4xl">{post.title}</h1>
          <p className="mt-3 text-sm text-muted">
            {post.author} · {post.date} · {fmt(t.blog.readMinutes, { n: readMinutes(post.content) })}
          </p>
        </header>

        <div className="prose-pixel mt-8">{renderMarkdown(post.content)}</div>
      </article>

      {more.length > 0 && (
        <section className="mx-auto mt-14 max-w-3xl border-t border-line pt-8">
          <h2 className="text-lg font-bold">{t.blog.morePosts}</h2>
          <ul className="mt-4 divide-y divide-line">
            {more.map((p) => (
              <li key={p.slug}>
                <Link to={`/blog/${p.slug}`} className="group flex items-center gap-3 py-3">
                  <span className="text-2xl" aria-hidden>
                    {p.icon}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-semibold group-hover:text-brand-hover">{p.title}</span>
                    <span className="block truncate text-xs text-muted">{p.excerpt}</span>
                  </span>
                  <span className="shrink-0 text-xs text-dim">{p.date}</span>
                </Link>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  )
}

function PostSkeleton() {
  return (
    <div className="container-x py-8 sm:py-10" aria-busy="true">
      <SkeletonBlock className="h-3 w-56 max-w-[70vw]" />
      <article className="mx-auto mt-6 max-w-3xl" aria-hidden>
        <SkeletonBlock className="h-40 rounded-card sm:h-52" />
        <div className="mt-6 flex gap-2">
          <SkeletonBlock className="h-5 w-16" />
          <SkeletonBlock className="h-5 w-20" />
        </div>
        <SkeletonBlock className="mt-4 h-9 w-5/6" />
        <SkeletonBlock className="mt-3 h-3 w-48" />
        <div className="mt-8 space-y-3">
          {[0, 1, 2, 3, 4, 5].map((i) => (
            <SkeletonBlock key={i} className={i % 3 === 2 ? 'h-3 w-3/4' : 'h-3 w-full'} />
          ))}
        </div>
      </article>
    </div>
  )
}

/** meta description 必须是单行纯文本：去掉 Markdown 与 HTML 标记 */
function plainText(source: string): string {
  return source
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/<[^>]*>/g, '')
    .replace(/[*_`>#]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}
