import { Link, useParams } from 'react-router-dom'
import { useState } from 'react'
import { readMinutes, usePublishedPosts } from '@/services/posts'
import { renderMarkdown } from '@/lib/markdown'
import { gradientFor } from '@/lib/gradients'
import { useSeo, articleSchema, breadcrumbSchema } from '@/services/seo'
import { useT, fmt } from '@/services/i18n'
import { useLang } from '@/services/lang'
import { postContent, postExcerpt, postTitle, needsPostTranslation } from '@/services/i18nData'
import { TranslateButton } from '@/components/game/TranslateButton'
import { NotFoundPage } from './NotFoundPage'
import { SkeletonBlock } from '@/components/ui/PageSkeleton'

export function PostPage() {
  const { slug = '' } = useParams<{ slug: string }>()
  const t = useT()
  const lang = useLang()
  // 文章总量不大，/blog 一次就把已发布的全给了，单篇直接在里面找 ——
  // 没必要为一篇文章再单独打一次请求
  const { posts, loading } = usePublishedPosts()
  const post = posts.find((p) => p.slug === slug)
  // 玩家点过翻译按钮之后，覆盖在正文上的译文（摘要同理）。
  // - null = 还没翻，按 postContent() 回退到原文
  // - string = 翻译后的正文（已经写进 content_i18n，但前端 state 也留一份，
  //   避免「后台改了正文但用户看不到」的隐性 bug，反正刷新一次会重新走 needsPostTranslation）
  const [translatedContent, setTranslatedContent] = useState<string | null>(null)
  // 标题同理。以前按钮只回填正文，标题一直是中文 —— 点完翻译，页面上最大的那行字没变。
  const [translatedTitle, setTranslatedTitle] = useState<string | null>(null)
  // 还在加载时不能当成「文章不存在」—— 否则每次进详情页都会先闪一下 404
  const missing = !loading && !post
  // SEO：hook 要在下面的 early return 之前调用，文章不存在时走 noindex 分支
  /**
   * ⚠️ 标题和摘要一律过 postTitle / postExcerpt，**包括 SEO 和结构化数据**。
   *
   * 这不只是显示问题：`<title>` / `description` / articleSchema 里的 headline
   * 是搜索引擎判「这两个 URL 是不是同一个页面」的主要依据。八种语言共用同一个
   * 中文标题，等于主动告诉 Google「/fr/blog/x 和 /blog/x 是一份东西」。
   *
   * `translatedTitle` 优先：玩家刚点完翻译按钮，看到的就该是他刚拿到的那份。
   */
  const heading = post ? translatedTitle || postTitle(post, lang) : ''
  const excerpt = post ? plainText(postExcerpt(post, lang)) : ''
  useSeo(
    post
      ? {
          title: heading,
          description: excerpt,
          type: 'article',
          publishedTime: post.date,
          updatedTime: post.updatedAt || post.date,
          jsonLd: [
            articleSchema({
              title: heading,
              slug: post.slug,
              excerpt,
              date: post.date,
              updated: post.updatedAt || post.date,
              author: post.author,
            }),
            breadcrumbSchema([
              { name: t.common.home, path: '/' },
              { name: t.common.blog, path: '/blog' },
              { name: heading, path: `/blog/${post.slug}` },
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
        <span className="text-fg">{heading}</span>
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
          <div className="mt-3 flex items-start justify-between gap-4">
            <h1 className="flex-1 text-3xl font-extrabold leading-tight tracking-tight sm:text-4xl">{heading}</h1>
            {/* 「翻译」按钮：非中文界面且该语言还没翻译过时挂一个。
                needsPostTranslation() 在两种 i18n 都写过后返回 false，按钮就不再出现 */}
            {needsPostTranslation(post, lang) && (
              <TranslateButton<{ title: string; excerpt: string; content: string }>
                endpoint={`/api/posts/${encodeURIComponent(post.slug)}/translate`}
                lang={lang}
                onTranslated={(r) => {
                  // 两个字段各自可能失败（partial），所以分别判空回填，别一起判
                  setTranslatedTitle(r.title || null)
                  setTranslatedContent(r.content || null)
                }}
              />
            )}
          </div>
          <p className="mt-3 text-sm text-muted">
            {post.author} · {post.date} · {fmt(t.blog.readMinutes, { n: readMinutes(post.content) })}
          </p>
        </header>

        <div className="prose-pixel mt-8">{renderMarkdown(translatedContent ?? postContent(post, lang))}</div>
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
                    <span className="block truncate font-semibold group-hover:text-brand-hover">{postTitle(p, lang)}</span>
                    <span className="block truncate text-xs text-muted">{postExcerpt(p, lang)}</span>
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
