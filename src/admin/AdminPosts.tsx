import { useEffect, useMemo, useState, type FormEvent } from 'react'
import { Link } from 'react-router-dom'
import type { Post } from '@/types'
import { deletePost, savePost, setPostPublished, useAllPosts } from '@/services/posts'
import { renderMarkdown } from '@/lib/markdown'
import { cx } from '@/lib/format'
import { slugify } from './GameForm'
import { Field, btnClass, inputClass } from './ui'

type Editing = { mode: 'add' } | { mode: 'edit'; post: Post } | null

export function AdminPosts() {
  const posts = useAllPosts()
  const [q, setQ] = useState('')
  const [editing, setEditing] = useState<Editing>(null)
  const [toast, setToast] = useState<string | null>(null)

  useEffect(() => {
    if (!toast) return
    const t = window.setTimeout(() => setToast(null), 2500)
    return () => window.clearTimeout(t)
  }, [toast])

  const list = useMemo(() => {
    const needle = q.trim().toLowerCase()
    return posts
      .filter((p) => !needle || p.title.toLowerCase().includes(needle) || p.tags.some((t) => t.toLowerCase().includes(needle)))
      .sort((a, b) => (a.date < b.date ? 1 : -1))
  }, [posts, q])

  const remove = async (p: Post) => {
    if (!window.confirm(`确定删除文章「${p.title}」？`)) return
    try {
      await deletePost(p.slug)
      setToast('已删除')
    } catch (err) {
      setToast(err instanceof Error ? err.message : '删除失败')
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-bold">文章管理</h1>
          <p className="mt-1 text-sm text-muted">
            共 {posts.length} 篇，{posts.filter((p) => p.published).length} 篇已发布。草稿不会出现在前台。
          </p>
        </div>
        <div className="flex gap-2">
          <input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="搜索标题 / 标签…" className={cx(inputClass, 'w-56')} />
          <button type="button" className={btnClass.primary} onClick={() => setEditing({ mode: 'add' })}>
            ＋ 写文章
          </button>
        </div>
      </div>

      <div className="overflow-x-auto rounded-2xl border border-line bg-surface">
        <table className="w-full min-w-[760px] text-sm">
          <thead className="bg-surface-2 text-left text-xs text-muted">
            <tr>
              <th className="px-3 py-2 font-medium">文章</th>
              <th className="px-3 py-2 font-medium">标签</th>
              <th className="px-3 py-2 font-medium">作者</th>
              <th className="px-3 py-2 font-medium">日期</th>
              <th className="px-3 py-2 font-medium">状态</th>
              <th className="px-3 py-2 text-right font-medium">操作</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {list.map((p) => (
              <tr key={p.slug} className={cx('transition hover:bg-black/[0.03]', !p.published && 'opacity-60')}>
                <td className="px-3 py-2">
                  <div className="flex items-center gap-2">
                    <span className="grid h-8 w-8 shrink-0 place-items-center rounded-md bg-surface-2 text-base" aria-hidden>
                      {p.icon}
                    </span>
                    <div className="min-w-0">
                      <p className="truncate font-medium">{p.title}</p>
                      <p className="truncate text-xs text-dim">
                        <Link to={`/blog/${p.slug}`} target="_blank" className="hover:text-brand-hover">
                          /blog/{p.slug}
                        </Link>
                      </p>
                    </div>
                  </div>
                </td>
                <td className="px-3 py-2 text-muted">{p.tags.join(' / ') || '—'}</td>
                <td className="px-3 py-2 text-muted">{p.author}</td>
                <td className="px-3 py-2 tabular-nums text-muted">{p.date}</td>
                <td className="px-3 py-2">
                  {p.published ? (
                    <span className="rounded bg-online/15 px-1.5 py-0.5 text-xs text-online">已发布</span>
                  ) : (
                    <span className="rounded bg-white/5 px-1.5 py-0.5 text-xs text-dim">草稿</span>
                  )}
                </td>
                <td className="px-3 py-2">
                  <div className="flex justify-end gap-1">
                    <button type="button" className={cx(btnClass.small, 'text-brand-hover hover:bg-brand-soft')} onClick={() => setEditing({ mode: 'edit', post: p })}>
                      编辑
                    </button>
                    <button
                      type="button"
                      className={cx(btnClass.small, 'text-muted hover:bg-black/5 hover:text-fg')}
                      onClick={async () => {
                        try {
                          await setPostPublished(p.slug, !p.published)
                          setToast(p.published ? '已转为草稿' : '已发布')
                        } catch (err) {
                          setToast(err instanceof Error ? err.message : '操作失败')
                        }
                      }}
                    >
                      {p.published ? '转草稿' : '发布'}
                    </button>
                    <button type="button" className={cx(btnClass.small, 'text-red-300 hover:bg-live/15')} onClick={() => remove(p)}>
                      删除
                    </button>
                  </div>
                </td>
              </tr>
            ))}
            {list.length === 0 && (
              <tr>
                <td colSpan={6} className="px-3 py-10 text-center text-sm text-muted">
                  没有文章
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {editing && (
        <div className="fixed inset-0 z-50 grid place-items-center bg-black/70 p-4 backdrop-blur-sm" onClick={() => setEditing(null)}>
          <div
            role="dialog"
            aria-modal="true"
            className="max-h-[92dvh] w-full max-w-4xl overflow-y-auto rounded-2xl border border-line bg-surface p-5"
            onClick={(e) => e.stopPropagation()}
          >
            <h2 className="mb-4 text-lg font-bold">{editing.mode === 'edit' ? `编辑：${editing.post.title}` : '写文章'}</h2>
            <PostForm
              key={editing.mode === 'edit' ? editing.post.slug : 'new'}
              initial={editing.mode === 'edit' ? editing.post : undefined}
              existingSlugs={posts.map((p) => p.slug)}
              onSubmit={async (post) => {
                try {
                  await savePost(post)
                  setEditing(null)
                  setToast(editing.mode === 'edit' ? '已保存' : '已创建')
                } catch (err) {
                  setToast(err instanceof Error ? err.message : '保存失败')
                }
              }}
              onCancel={() => setEditing(null)}
            />
          </div>
        </div>
      )}

      {toast && <div className="fixed bottom-5 left-1/2 z-50 -translate-x-1/2 rounded-lg border border-line bg-surface-3 px-4 py-2 text-sm shadow-xl">{toast}</div>}
    </div>
  )
}

const EMPTY: Post = {
  slug: '',
  title: '',
  excerpt: '',
  content: '',
  icon: '📝',
  tags: [],
  author: '8BitGo 团队',
  date: new Date().toISOString().slice(0, 10),
  published: false,
}

function PostForm({ initial, existingSlugs, onSubmit, onCancel }: { initial?: Post; existingSlugs: string[]; onSubmit: (p: Post) => void; onCancel: () => void }) {
  const [form, setForm] = useState<Post>(initial ?? { ...EMPTY, date: new Date().toISOString().slice(0, 10) })
  const [tagsText, setTagsText] = useState((initial?.tags ?? []).join(', '))
  const [slugTouched, setSlugTouched] = useState(Boolean(initial))
  const [preview, setPreview] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const isEdit = Boolean(initial)

  useEffect(() => {
    if (!isEdit && !slugTouched) setForm((f) => ({ ...f, slug: slugify(f.title) || f.slug }))
  }, [form.title, isEdit, slugTouched])

  const set = <K extends keyof Post>(key: K, value: Post[K]) => setForm((f) => ({ ...f, [key]: value }))

  const submit = (e: FormEvent) => {
    e.preventDefault()
    const slug = slugify(form.slug) || `post-${Date.now().toString(36)}`
    if (!form.title.trim()) return setError('请填写标题')
    if (!form.content.trim()) return setError('正文不能为空')
    if (!isEdit && existingSlugs.includes(slug)) return setError(`slug「${slug}」已存在`)
    onSubmit({
      ...form,
      slug,
      title: form.title.trim(),
      excerpt: form.excerpt.trim() || form.content.replace(/[#>*`\-]/g, '').trim().slice(0, 80),
      tags: tagsText
        .split(/[,，]/)
        .map((t) => t.trim())
        .filter(Boolean),
      author: form.author.trim() || '8BitGo 团队',
    })
  }

  return (
    <form onSubmit={submit} className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-[1fr_1fr]">
        <Field label="标题 *">
          <input className={inputClass} value={form.title} onChange={(e) => set('title', e.target.value)} required />
        </Field>
        <Field label="slug（URL）" hint={isEdit ? '编辑时不可修改' : '中文标题请手动填写英文 slug'}>
          <input
            className={cx(inputClass, isEdit && 'opacity-60')}
            value={form.slug}
            disabled={isEdit}
            onChange={(e) => {
              setSlugTouched(true)
              set('slug', e.target.value)
            }}
            placeholder="my-first-post"
          />
        </Field>
      </div>

      <Field label="摘要" hint="留空则自动截取正文前 80 字">
        <input className={inputClass} value={form.excerpt} onChange={(e) => set('excerpt', e.target.value)} />
      </Field>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Field label="封面 emoji">
          <input className={cx(inputClass, 'text-center text-lg')} value={form.icon} onChange={(e) => set('icon', e.target.value)} maxLength={4} />
        </Field>
        <Field label="作者">
          <input className={inputClass} value={form.author} onChange={(e) => set('author', e.target.value)} />
        </Field>
        <Field label="日期">
          <input type="date" className={inputClass} value={form.date} onChange={(e) => set('date', e.target.value)} />
        </Field>
        <Field label="标签" hint="逗号分隔">
          <input className={inputClass} value={tagsText} onChange={(e) => setTagsText(e.target.value)} placeholder="教程, 站点公告" />
        </Field>
      </div>

      <div>
        <div className="mb-1 flex items-center justify-between">
          <span className="text-xs font-medium text-muted">正文 *（支持：## 标题、- 列表、&gt; 引用、**加粗**、`代码`、[链接](url)）</span>
          <button type="button" className={cx(btnClass.small, 'border border-line text-muted hover:text-fg')} onClick={() => setPreview((v) => !v)}>
            {preview ? '返回编辑' : '预览'}
          </button>
        </div>
        {preview ? (
          <div className="prose-pixel min-h-[16rem] rounded-lg border border-line bg-surface-2 px-4 py-3">{renderMarkdown(form.content)}</div>
        ) : (
          <textarea className={cx(inputClass, 'h-72 resize-y py-2 font-mono text-xs leading-relaxed')} value={form.content} onChange={(e) => set('content', e.target.value)} />
        )}
      </div>

      <label className="inline-flex items-center gap-2 text-sm">
        <input type="checkbox" checked={form.published} onChange={(e) => set('published', e.target.checked)} /> 发布（取消勾选则保存为草稿）
      </label>

      {error && (
        <p role="alert" className="rounded-lg bg-live/15 px-3 py-2 text-sm text-red-300">
          {error}
        </p>
      )}

      <div className="flex justify-end gap-2 border-t border-line pt-4">
        <button type="button" className={btnClass.secondary} onClick={onCancel}>
          取消
        </button>
        <button type="submit" className={btnClass.primary}>
          {isEdit ? '保存' : '创建'}
        </button>
      </div>
    </form>
  )
}
