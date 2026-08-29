import type { ReactNode } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import type { Post } from '@/types'
import { getPostTags, readMinutes, usePublishedPosts } from '@/services/posts'
import { gradientFor } from '@/lib/gradients'
import { cx } from '@/lib/format'
import { useSeo } from '@/services/seo'
import { useT, fmt } from '@/services/i18n'
import { SkeletonBlock } from '@/components/ui/PageSkeleton'

export function BlogPage() {
  const t = useT()
  useSeo({ title: t.blog.title, description: t.seo.blog })
  const [params, setParams] = useSearchParams()
  const tag = params.get('tag')
  // 文章数量级小，后端一次给全已发布的；按标签筛在前端做就够了
  const { posts: all, loading } = usePublishedPosts()
  const list = tag ? all.filter((p) => p.tags.includes(tag)) : all
  const tags = getPostTags(all)
  const [featured, ...rest] = list
  // 文章还没拉回来时先给一句提示，别让页面看起来像「一篇都没有」
  const empty = !loading && list.length === 0

  return (
    <div className="container-x py-8 sm:py-10">
      {empty && (
        <p className="mb-6 rounded-card border border-line bg-surface px-4 py-3 text-sm text-muted">
          {t.blog.empty}
        </p>
      )}
      <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div className="max-w-2xl">
          <span className="text-pixel text-[11px] text-brand-hover">BLOG</span>
          <h1 className="mt-2 text-3xl font-extrabold tracking-tight">{t.blog.title}</h1>
          <p className="mt-2 text-muted">{t.blog.subtitle}</p>
        </div>
        <div className="flex flex-wrap gap-2">
          {loading ? (
            Array.from({ length: 5 }, (_, i) => (
              <SkeletonBlock key={i} className={i === 0 ? 'h-7 w-16' : 'h-7 w-20'} />
            ))
          ) : (
            <>
              <TagChip active={!tag} onClick={() => setParams({})}>
                {fmt(t.blog.allTag, { n: all.length })}
              </TagChip>
              {tags.map((t) => (
                <TagChip key={t.tag} active={tag === t.tag} onClick={() => setParams({ tag: t.tag })}>
                  {t.tag} {t.count}
                </TagChip>
              ))}
            </>
          )}
        </div>
      </div>

      {loading ? (
        <BlogSkeleton />
      ) : list.length === 0 ? (
        <p className="mt-10 rounded-2xl border border-dashed border-line py-16 text-center text-muted">{t.blog.empty}</p>
      ) : (
        <>
          {featured && <FeaturedCard post={featured} />}
          <div className="mt-6 grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
            {rest.map((p) => (
              <PostCard key={p.slug} post={p} />
            ))}
          </div>
        </>
      )}
    </div>
  )
}

/** 博客首屏按“主推文章 + 三列文章卡”占位，避免取数时先闪出空状态。 */
function BlogSkeleton() {
  return (
    <div aria-busy="true">
      <div className="mt-6 grid overflow-hidden rounded-card border border-line bg-surface md:grid-cols-[2fr_3fr]" aria-hidden>
        <SkeletonBlock className="min-h-[200px] rounded-none" />
        <div className="flex flex-col justify-center p-6">
          <div className="flex gap-2">
            <SkeletonBlock className="h-5 w-14" />
            <SkeletonBlock className="h-5 w-20" />
          </div>
          <SkeletonBlock className="mt-4 h-7 w-4/5" />
          <SkeletonBlock className="mt-4 h-3.5 w-full" />
          <SkeletonBlock className="mt-2 h-3.5 w-3/4" />
          <SkeletonBlock className="mt-5 h-3 w-40" />
        </div>
      </div>
      <div className="mt-6 grid gap-4 sm:grid-cols-2 xl:grid-cols-3" aria-hidden>
        {Array.from({ length: 3 }, (_, i) => (
          <div key={i} className="overflow-hidden rounded-card border border-line bg-surface">
            <SkeletonBlock className="aspect-[16/7] rounded-none" />
            <div className="p-4">
              <SkeletonBlock className="h-4 w-3/4" />
              <SkeletonBlock className="mt-3 h-3 w-full" />
              <SkeletonBlock className="mt-2 h-3 w-2/3" />
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

function TagChip({ active, onClick, children }: { active: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={cx(
        'rounded-lg border px-2.5 py-1 text-xs transition',
        active ? 'border-brand bg-brand text-white' : 'border-line bg-surface text-muted hover:text-fg',
      )}
    >
      {children}
    </button>
  )
}

function Meta({ post }: { post: Post }) {
  const t = useT()
  return (
    <p className="text-xs text-muted">
      {post.author} · {post.date} · {fmt(t.blog.minutes, { n: readMinutes(post.content) })}
    </p>
  )
}

function FeaturedCard({ post }: { post: Post }) {
  return (
    <Link
      to={`/blog/${post.slug}`}
      className="group mt-6 grid overflow-hidden rounded-card border border-line bg-surface transition hover:border-brand/60 md:grid-cols-[2fr_3fr]"
    >
      <div className="relative grid min-h-[200px] place-items-center text-7xl" style={{ background: gradientFor(post.slug) }} aria-hidden>
        <span className="pixel-grid absolute inset-0 opacity-60" />
        <span className="relative drop-shadow transition group-hover:scale-110">{post.icon}</span>
      </div>
      <div className="flex flex-col justify-center p-6">
        <div className="flex flex-wrap gap-1.5">
          {post.tags.map((t) => (
            <span key={t} className="rounded bg-brand-soft px-1.5 py-0.5 text-[11px] font-semibold text-brand-hover">
              {t}
            </span>
          ))}
        </div>
        <h2 className="mt-3 text-2xl font-bold leading-snug group-hover:text-brand-hover">{post.title}</h2>
        <p className="mt-2 leading-relaxed text-muted">{post.excerpt}</p>
        <div className="mt-4">
          <Meta post={post} />
        </div>
      </div>
    </Link>
  )
}

function PostCard({ post }: { post: Post }) {
  return (
    <Link to={`/blog/${post.slug}`} className="group card-hover flex flex-col overflow-hidden rounded-card border border-line bg-surface hover:border-brand/60">
      <div className="relative grid aspect-[16/7] place-items-center text-5xl" style={{ background: gradientFor(post.slug) }} aria-hidden>
        <span className="pixel-grid absolute inset-0 opacity-60" />
        <span className="relative drop-shadow transition group-hover:scale-110">{post.icon}</span>
      </div>
      <div className="flex flex-1 flex-col p-4">
        <div className="flex flex-wrap gap-1.5">
          {post.tags.map((t) => (
            <span key={t} className="rounded bg-white/5 px-1.5 py-0.5 text-[11px] text-muted">
              {t}
            </span>
          ))}
        </div>
        <h2 className="mt-2 text-base font-bold leading-snug group-hover:text-brand-hover">{post.title}</h2>
        <p className="mt-1.5 line-clamp-2 text-sm leading-relaxed text-muted">{post.excerpt}</p>
        <div className="mt-auto pt-3">
          <Meta post={post} />
        </div>
      </div>
    </Link>
  )
}
