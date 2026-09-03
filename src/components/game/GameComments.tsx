import { useCallback, useEffect, useRef, useState } from 'react'
import type { GameComment } from '@/types'
import { useCurrentUser } from '@/services/auth'
import { openAuthModal } from '@/services/authModal'
import { fmt, useT } from '@/services/i18n'
import {
  COMMENT_EDIT_WINDOW_MS,
  COMMENT_MAX_LENGTH,
  canStillEdit,
  commentsAvailable,
  countryFlag,
  countryName,
  deleteComment,
  editComment,
  fetchComments,
  postComment,
  timeAgo,
} from '@/services/comments'
import { cx } from '@/lib/format'
import { Button } from '@/components/ui/Button'
import { SkeletonBlock } from '@/components/ui/PageSkeleton'

/**
 * 详情页侧栏的评论区。
 *
 * 三个定下来的取舍：
 *
 * 1. **平铺 + 引用卡片**，不做嵌套树。侧栏只有四分之一宽，嵌套两层之后每行放不下
 *    几个字；引用卡片把「回复谁、说了什么」摊在自己这条上面，宽度不会越缩越窄。
 * 2. **客户端取数**，不进 SSR。评论随时在变，而 SSR 出去的 HTML 在 Cloudflare
 *    边缘要缓存几分钟（见 server/src/cache.js 的 CACHE.page）——
 *    烘进 HTML 的评论会是几分钟前的，用户发完刷新反而看不到自己那条。
 *    代价是评论内容不参与 SEO；要拿这块内容做收录得先解决边缘缓存那一层。
 * 3. **未登录不隐藏评论区**，只把输入框换成一句提示加登录按钮。
 *    整块藏起来的话，没登录的人根本不知道这里有讨论。
 */
export function GameComments({ gameSlug }: { gameSlug: string }) {
  const t = useT()
  const c = t.comments
  const user = useCurrentUser()

  const [items, setItems] = useState<GameComment[]>([])
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(1)
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading')
  const [loadError, setLoadError] = useState('')
  const [more, setMore] = useState(false)

  const [text, setText] = useState('')
  const [replyTo, setReplyTo] = useState<GameComment | null>(null)
  const [sending, setSending] = useState(false)
  const [formError, setFormError] = useState('')
  const boxRef = useRef<HTMLTextAreaElement>(null)

  const load = useCallback(
    async (nextPage: number, append: boolean) => {
      if (append) setMore(true)
      else setStatus('loading')
      try {
        const r = await fetchComments(gameSlug, nextPage)
        setTotal(r.total)
        setPage(r.page)
        // 追加时按 id 去重：翻页期间有人发了新评论，第 2 页的第一条可能已经在第 1 页里了
        setItems((prev) => {
          if (!append) return r.items
          const seen = new Set(prev.map((x) => x.id))
          return [...prev, ...r.items.filter((x) => !seen.has(x.id))]
        })
        setStatus('ready')
      } catch (e) {
        if (append) {
          // 加载更多失败不该把已经看到的评论清掉
          setFormError(e instanceof Error ? e.message : c.loadFailed)
        } else {
          setLoadError(e instanceof Error ? e.message : c.loadFailed)
          setStatus('error')
        }
      } finally {
        setMore(false)
      }
    },
    [gameSlug, c.loadFailed],
  )

  // 换游戏时整块重置：上一款的评论和「正在回复」不能带过来
  useEffect(() => {
    if (!commentsAvailable()) {
      setStatus('ready')
      return
    }
    setItems([])
    setTotal(0)
    setReplyTo(null)
    setText('')
    setFormError('')
    void load(1, false)
  }, [gameSlug, load])

  const submit = async () => {
    const content = text.trim()
    if (!content || sending) return
    if (content.length > COMMENT_MAX_LENGTH) {
      setFormError(fmt(c.tooLong, { n: COMMENT_MAX_LENGTH }))
      return
    }
    setSending(true)
    setFormError('')
    try {
      const created = await postComment(gameSlug, content, replyTo?.id)
      // 列表是最新在前，所以新评论插在最前面
      setItems((prev) => [created, ...prev])
      setTotal((n) => n + 1)
      setText('')
      setReplyTo(null)
    } catch (e) {
      setFormError(e instanceof Error ? e.message : c.loadFailed)
    } finally {
      setSending(false)
    }
  }

  const startReply = (target: GameComment) => {
    setReplyTo(target)
    setFormError('')
    boxRef.current?.focus()
  }

  const onDeleted = (id: string) => {
    setItems((prev) => prev.filter((x) => x.id !== id))
    setTotal((n) => Math.max(0, n - 1))
  }

  const onEdited = (next: GameComment) => {
    setItems((prev) => prev.map((x) => (x.id === next.id ? next : x)))
  }

  const remaining = COMMENT_MAX_LENGTH - text.length
  const hasMore = items.length < total

  return (
    <section className="rounded-2xl border border-line bg-surface p-5" aria-label={c.title}>
      <header className="flex items-baseline justify-between">
        <h2 className="text-sm font-bold">💬 {c.title}</h2>
        {total > 0 && <span className="text-xs text-muted">{fmt(c.count, { n: total })}</span>}
      </header>

      {!commentsAvailable() ? (
        <p className="mt-3 text-xs text-dim">{c.unavailable}</p>
      ) : (
        <>
          {/* ---- 发表 ---- */}
          {user ? (
            <div className="mt-4">
              {replyTo && (
                <div className="mb-2 flex items-center justify-between gap-2 rounded-lg bg-surface-2 px-2.5 py-1.5 text-xs">
                  <span className="truncate text-muted">{fmt(c.replyingTo, { name: replyTo.author.nickname })}</span>
                  <button
                    type="button"
                    onClick={() => setReplyTo(null)}
                    className="shrink-0 text-dim transition hover:text-fg"
                  >
                    {c.cancel}
                  </button>
                </div>
              )}
              <textarea
                ref={boxRef}
                value={text}
                onChange={(e) => setText(e.target.value)}
                rows={3}
                maxLength={COMMENT_MAX_LENGTH}
                placeholder={replyTo ? fmt(c.replyPlaceholder, { name: replyTo.author.nickname }) : c.placeholder}
                className="w-full resize-y rounded-xl border border-line bg-surface-2 px-3 py-2 text-sm text-fg placeholder:text-dim focus:border-brand focus:outline-none focus:ring-2 focus:ring-brand/30"
              />
              <div className="mt-2 flex items-center justify-between gap-2">
                <span className={cx('text-[11px]', remaining < 50 ? 'text-live' : 'text-dim')}>
                  {remaining < 200 ? fmt(c.remaining, { n: remaining }) : ''}
                </span>
                <Button size="sm" onClick={() => void submit()} disabled={!text.trim() || sending}>
                  {sending ? c.submitting : c.submit}
                </Button>
              </div>
            </div>
          ) : (
            <div className="mt-4 rounded-xl border border-line bg-surface-2 px-3 py-3">
              <p className="text-xs text-muted">{c.loginHint}</p>
              <Button variant="secondary" size="sm" className="mt-2" onClick={openAuthModal}>
                {c.loginCta}
              </Button>
            </div>
          )}

          {formError && (
            <p className="mt-2 text-xs text-live" role="alert">
              {formError}
            </p>
          )}

          {/* ---- 列表 ---- */}
          <div className="mt-5">
            {status === 'loading' && (
              <div className="space-y-4" aria-busy="true">
                {[0, 1, 2].map((i) => (
                  <div key={i} className="flex gap-2">
                    <SkeletonBlock className="h-8 w-8 shrink-0 rounded-lg" />
                    <div className="flex-1">
                      <SkeletonBlock className="h-3 w-24" />
                      <SkeletonBlock className="mt-2 h-3 w-full" />
                      <SkeletonBlock className="mt-1.5 h-3 w-4/5" />
                    </div>
                  </div>
                ))}
              </div>
            )}

            {status === 'error' && (
              <div className="text-xs" role="alert">
                <p className="text-muted">{loadError || c.loadFailed}</p>
                <button
                  type="button"
                  onClick={() => void load(1, false)}
                  className="mt-2 font-semibold text-brand-hover underline-offset-4 hover:underline"
                >
                  {c.retry}
                </button>
              </div>
            )}

            {status === 'ready' && items.length === 0 && <p className="text-xs text-dim">{c.empty}</p>}

            {status === 'ready' && items.length > 0 && (
              <ul className="divide-y divide-line">
                {items.map((item) => (
                  <CommentItem
                    key={item.id}
                    comment={item}
                    mine={Boolean(user && user.id === item.author.id)}
                    onReply={user ? startReply : () => openAuthModal()}
                    onDeleted={onDeleted}
                    onEdited={onEdited}
                  />
                ))}
              </ul>
            )}

            {status === 'ready' && hasMore && (
              <button
                type="button"
                onClick={() => void load(page + 1, true)}
                disabled={more}
                className="mt-3 w-full rounded-lg border border-line py-2 text-xs text-muted transition hover:border-brand hover:text-fg disabled:opacity-60"
              >
                {more ? c.loading : c.loadMore}
              </button>
            )}
          </div>
        </>
      )}
    </section>
  )
}

/** 一条评论。编辑态就地展开，不弹窗 —— 侧栏这么窄，弹窗盖住的正是上下文。 */
function CommentItem({
  comment,
  mine,
  onReply,
  onDeleted,
  onEdited,
}: {
  comment: GameComment
  mine: boolean
  onReply: (c: GameComment) => void
  onDeleted: (id: string) => void
  onEdited: (c: GameComment) => void
}) {
  const t = useT()
  const c = t.comments
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(comment.content)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  /**
   * 「还能编辑吗」是随时间失效的。只在打开操作栏那一刻算一次就行 ——
   * 为了让按钮在第 5 分 01 秒自己消失而挂一个每秒的定时器，不值得。
   * 真的过期了，服务端会拒，下面的 catch 会把原因显示出来。
   */
  const editable = mine && canStillEdit(comment)

  const save = async () => {
    const content = draft.trim()
    if (!content || busy) return
    setBusy(true)
    setError('')
    try {
      onEdited(await editComment(comment.id, content))
      setEditing(false)
    } catch (e) {
      setError(e instanceof Error ? e.message : c.loadFailed)
    } finally {
      setBusy(false)
    }
  }

  const remove = async () => {
    if (!window.confirm(c.removeConfirm)) return
    setBusy(true)
    setError('')
    try {
      await deleteComment(comment.id)
      onDeleted(comment.id)
    } catch (e) {
      setError(e instanceof Error ? e.message : c.loadFailed)
      setBusy(false)
    }
  }

  return (
    <li className="py-3 first:pt-0">
      <div className="flex gap-2">
        <span className="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-brand-soft text-base" aria-hidden>
          {comment.author.avatar}
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-[11px]">
            <span className="max-w-[8rem] truncate text-xs font-semibold">{comment.author.nickname}</span>
            {/* 国旗是 emoji 组合出来的，不需要图片资源；title 给出国家名，读屏也读得到 */}
            <span title={countryName(comment.country)} aria-label={countryName(comment.country)}>
              {countryFlag(comment.country)}
            </span>
            <span className="text-dim">·</span>
            <time className="text-dim" dateTime={comment.createdAt}>
              {timeAgo(comment.createdAt)}
            </time>
            {comment.editedAt && <span className="text-dim">({c.edited})</span>}
          </div>

          {/* 引用卡片：回复谁、说了什么 */}
          {comment.quote && (
            <div className="mt-1.5 rounded-lg border-l-2 border-brand/50 bg-surface-2 px-2.5 py-1.5 text-[11px]">
              <p className="truncate text-muted">
                <span aria-hidden>{comment.quote.avatar} </span>
                <span className="font-semibold">{comment.quote.nickname}</span>
              </p>
              <p className={cx('mt-0.5 line-clamp-2 break-words', comment.quote.deleted ? 'italic text-dim' : 'text-muted')}>
                {comment.quote.deleted ? c.quoteDeleted : comment.quote.content}
              </p>
            </div>
          )}

          {editing ? (
            <div className="mt-1.5">
              <textarea
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                rows={3}
                maxLength={COMMENT_MAX_LENGTH}
                className="w-full resize-y rounded-lg border border-line bg-surface-2 px-2.5 py-1.5 text-sm text-fg focus:border-brand focus:outline-none focus:ring-2 focus:ring-brand/30"
              />
              <div className="mt-1.5 flex gap-2 text-[11px]">
                <button
                  type="button"
                  onClick={() => void save()}
                  disabled={busy || !draft.trim()}
                  className="font-semibold text-brand-hover disabled:opacity-50"
                >
                  {busy ? c.saving : c.save}
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setEditing(false)
                    setDraft(comment.content)
                    setError('')
                  }}
                  className="text-dim transition hover:text-fg"
                >
                  {c.cancel}
                </button>
              </div>
            </div>
          ) : (
            // whitespace-pre-wrap 保留用户打的换行；内容是纯文本渲染，不解析 Markdown / HTML
            <p className="mt-1 whitespace-pre-wrap break-words text-sm leading-relaxed">{comment.content}</p>
          )}

          {!editing && (
            <div className="mt-1.5 flex gap-3 text-[11px] text-dim">
              <button type="button" onClick={() => onReply(comment)} className="transition hover:text-fg">
                {c.reply}
              </button>
              {editable && (
                <button
                  type="button"
                  onClick={() => {
                    setDraft(comment.content)
                    setEditing(true)
                  }}
                  className="transition hover:text-fg"
                >
                  {c.edit}
                </button>
              )}
              {mine && (
                <button
                  type="button"
                  onClick={() => void remove()}
                  disabled={busy}
                  className="transition hover:text-live disabled:opacity-50"
                >
                  {c.remove}
                </button>
              )}
              {mine && !editable && (
                <span title={fmt(c.editExpired, { n: Math.round(COMMENT_EDIT_WINDOW_MS / 60000) })} className="cursor-help">
                  🔒
                </span>
              )}
            </div>
          )}

          {error && (
            <p className="mt-1.5 text-[11px] text-live" role="alert">
              {error}
            </p>
          )}
        </div>
      </div>
    </li>
  )
}
