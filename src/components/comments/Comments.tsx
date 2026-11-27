import { useCallback, useEffect, useRef, useState } from 'react'
import type { GameComment } from '@/types'
import { useAuthReady, useCurrentUser } from '@/services/auth'
import { openAuthModal } from '@/services/authModal'
import { fmt, useT } from '@/services/i18n'
import {
  COMMENT_EDIT_WINDOW_MS,
  COMMENT_MAX_LENGTH,
  canStillEdit,
  commentsAvailable,
  countryName,
  deleteComment,
  editComment,
  fetchComments,
  postComment,
  timeAgo,
  type CommentTarget,
} from '@/services/comments'
import { cx } from '@/lib/format'
import { flagOrSvg } from '@/components/Flag'
import { DmAvatar } from '@/components/im/DmButton'
import { UserRoleDot } from '@/components/UserRole'
import { FEATURES } from '@/config/features'
import { Stars } from '@/components/game/StarRating'
import { Button } from '@/components/ui/Button'
import { SkeletonBlock } from '@/components/ui/PageSkeleton'

/** 用随机请求键区分「用户又发了一条」和「上一条成功但响应丢了后的重试」。 */
function newCommentRequestId(): string {
  const bytes = new Uint8Array(16)
  const cryptoApi = globalThis.crypto
  if (cryptoApi?.getRandomValues) cryptoApi.getRandomValues(bytes)
  else for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256)
  bytes[6] = (bytes[6] & 0x0f) | 0x40
  bytes[8] = (bytes[8] & 0x3f) | 0x80
  const hex = [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

/**
 * 评论区。同一个组件服务两个宿主：游戏详情页的侧栏、博客文章页的右侧栏。
 *
 * 三个定下来的取舍：
 *
 * 1. **平铺 + 引用卡片**，不做嵌套树。侧栏只有四分之一宽，嵌套两层之后每行放不下
 *    几个字；引用卡片把「回复谁、说了什么」摊在自己这条上面，宽度不会越缩越窄。
 * 2. **客户端取数**，不进 SSR。评论随时在变，而 SSR 出去的 HTML 在 Cloudflare
 *    边缘要缓存几分钟（见 server/src/cache.js 的 CACHE.page）——
 *    烘进 HTML 的评论会是几分钟前的，用户发完刷新反而看不到自己那条。
 *    代价是评论内容不参与 SEO；要拿这块内容做收录得先解决边缘缓存那一层。
 * 3. **游客可以发言，但不直接公开**。游客评论先进入后台审核队列；登录用户发表后立即显示。
 *    这样既不挡住访客参与，也不会让匿名内容绕过审核出现在公开页面。
 *
 * 宿主（游戏 / 文章）用 target 表达；后端同一张表、同一套路由（见 services/comments.ts）。
 * 文章没有评分，所以文章评论上不会出现星星 —— 那是 score 字段为空时自然的结果，
 * 不需要再传一个 showScore 开关。
 *
 * ⚠️ 依赖不要用 target 对象本身：调用方每次 render 都会新建一个字面量，
 * 拿它进 useCallback 依赖会让 load 每帧都变，重置 effect 跟着无限跑。
 * 所以下面一律拆成 kind / slug 两个原始值。
 */
/**
 * variant="card"：游戏详情页新版设计稿的样子 —— 白卡 + 浅阴影，上半是标题和输入框，
 * 一条分隔线，下半是列表（空时只写一句「暂时空空」）。发言、编辑、审核、分页等行为两版完全相同。
 * 文章页不传，保持原来的样子。
 */
export function GameComments({ gameSlug, variant = 'default' }: { gameSlug: string; variant?: 'default' | 'card' }) {
  return <CommentsPanel target={{ kind: 'game', slug: gameSlug }} variant={variant} />
}

export function PostComments({ postSlug }: { postSlug: string }) {
  return <CommentsPanel target={{ kind: 'post', slug: postSlug }} />
}

function CommentsPanel({ target, variant = 'default' }: { target: CommentTarget; variant?: 'default' | 'card' }) {
  const card = variant === 'card'
  const { kind, slug } = target
  const showScore = kind === 'game'
  const t = useT()
  const c = t.comments
  const user = useCurrentUser()
  const authReady = useAuthReady()
  const draftOwnerKey = user?.id ?? 'guest'
  const draftOwnerRef = useRef(draftOwnerKey)
  draftOwnerRef.current = draftOwnerKey

  const [items, setItems] = useState<GameComment[]>([])
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(1)
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading')
  const [loadError, setLoadError] = useState('')
  const [loadMoreError, setLoadMoreError] = useState('')
  const [more, setMore] = useState(false)

  const [text, setText] = useState('')
  const [replyTo, setReplyTo] = useState<GameComment | null>(null)
  const [sending, setSending] = useState(false)
  const sendingRef = useRef<object | null>(null)
  const [formError, setFormError] = useState('')
  const [formNotice, setFormNotice] = useState('')
  const boxRef = useRef<HTMLTextAreaElement>(null)
  const [storedDraftOwner, setStoredDraftOwner] = useState(draftOwnerKey)
  const ownsDraft = storedDraftOwner === draftOwnerKey
  const draftText = ownsDraft ? text : ''
  const draftReplyTo = ownsDraft ? replyTo : null
  const requestAttempts = useRef(new Map<string, string>())
  /**
   * 当前宿主。面板在 A → B 之间是复用的，A 的请求（翻页、首屏、发表）在跳走之后才返回时，
   * 结果不能落到 B 的列表上 —— 每个 await 之后都拿它比一下，宿主变了就丢掉。
   */
  const hostRef = useRef(`${kind}:${slug}`)
  const hostEpoch = useRef(0)
  /** 首屏 / 翻页请求的序号：同一宿主里后发的请求优先，慢的旧响应不能盖掉新列表 */
  const loadSeq = useRef(0)

  const load = useCallback(
    async (nextPage: number, append: boolean) => {
      const host = `${kind}:${slug}`
      const seq = ++loadSeq.current
      const stale = () => hostRef.current !== host || loadSeq.current !== seq
      if (append) {
        setMore(true)
        setLoadMoreError('')
      } else {
        setStatus('loading')
        setLoadError('')
      }
      try {
        const r = await fetchComments({ kind, slug }, nextPage)
        if (stale()) return
        setTotal(r.total)
        setPage(r.page)
        // 追加时按 id 去重：翻页期间有人发了新评论，第 2 页的第一条可能已经在第 1 页里了
        setItems((prev) => {
          if (!append) return r.items
          const seen = new Set(prev.map((x) => x.id))
          return [...prev, ...r.items.filter((x) => !seen.has(x.id))]
        })
        setStatus('ready')
      } catch {
        if (stale()) return
        if (append) {
          // 加载更多失败不该伪装成「发言失败」；列表保留原样，并在分页按钮旁给出重试。
          // 代理 / 预览层的错误正文可能含内部诊断信息，面向玩家只给可操作的通用提示。
          setLoadMoreError(c.loadFailed)
        } else {
          setLoadError(c.loadFailed)
          setStatus('error')
        }
      } finally {
        if (!stale()) setMore(false)
      }
    },
    // kind / slug 是原始值，见文件头关于「不要依赖 target 对象」的说明
    [kind, slug, c.loadFailed],
  )

  // 换宿主（换游戏 / 换文章）时整块重置：上一个宿主的评论和「正在回复」不能带过来
  useEffect(() => {
    if (!commentsAvailable()) {
      setStatus('ready')
      return
    }
    hostRef.current = `${kind}:${slug}`
    hostEpoch.current += 1
    setItems([])
    setTotal(0)
    setPage(1)
    setMore(false)
    setLoadMoreError('')
    setReplyTo(null)
    setText('')
    setFormError('')
    setFormNotice('')
    sendingRef.current = null
    setSending(false)
    void load(1, false)
  }, [kind, slug, load])

  // 草稿和引用对象属于当前账号；切换账号后首帧就隐藏，随后清除，避免把未发表内容带给下一个人。
  useEffect(() => {
    if (ownsDraft) return
    setStoredDraftOwner(draftOwnerKey)
    setText('')
    setReplyTo(null)
    setFormError('')
    setFormNotice('')
    sendingRef.current = null
    setSending(false)
  }, [draftOwnerKey, ownsDraft])

  const submit = async () => {
    const content = draftText.trim()
    if (!ownsDraft || !content || sending || sendingRef.current || !authReady) return
    if (content.length > COMMENT_MAX_LENGTH) {
      setFormError(fmt(c.tooLong, { n: COMMENT_MAX_LENGTH }))
      return
    }
    const host = `${kind}:${slug}`
    const epoch = hostEpoch.current
    const signature = JSON.stringify([host, draftOwnerKey, content, draftReplyTo?.id ?? null])
    let clientRequestId = requestAttempts.current.get(signature)
    if (!clientRequestId) {
      clientRequestId = newCommentRequestId()
      requestAttempts.current.set(signature, clientRequestId)
      // 用户连续改稿时保留少量未确认请求，返回旧草稿重试仍能命中原请求。
      if (requestAttempts.current.size > 8) {
        const oldest = requestAttempts.current.keys().next().value
        if (oldest) requestAttempts.current.delete(oldest)
      }
    }
    const sendAttempt = {}
    sendingRef.current = sendAttempt
    setSending(true)
    setFormError('')
    setFormNotice('')
    try {
      const created = await postComment({ kind, slug }, content, draftReplyTo?.id, clientRequestId)
      if (requestAttempts.current.get(signature) === clientRequestId) requestAttempts.current.delete(signature)
      // 发表期间已经换到别的游戏 / 文章：评论已经存上了，但不能插进新宿主的列表
      if (draftOwnerRef.current !== draftOwnerKey || hostRef.current !== host || hostEpoch.current !== epoch) return
      if (created.pendingReview) {
        // 待审核内容不能乐观插入公开列表，也不能计入公开评论数。
        setFormNotice(c.pendingNotice)
      } else {
        // 列表是最新在前，所以新评论插在最前面
        setItems((prev) => [created, ...prev])
        setTotal((n) => n + 1)
      }
      setText('')
      setReplyTo(null)
    } catch (e) {
      if (draftOwnerRef.current === draftOwnerKey && hostRef.current === host && hostEpoch.current === epoch) {
        setFormError(e instanceof Error ? e.message : c.loadFailed)
      }
    } finally {
      if (sendingRef.current === sendAttempt) {
        sendingRef.current = null
        setSending(false)
      }
    }
  }

  const startReply = (target: GameComment) => {
    setReplyTo(target)
    setFormError('')
    setFormNotice('')
    boxRef.current?.focus()
  }

  const onDeleted = (id: string) => {
    setItems((prev) => prev.filter((x) => x.id !== id))
    setTotal((n) => Math.max(0, n - 1))
  }

  const onEdited = (next: GameComment) => {
    setItems((prev) => prev.map((x) => (x.id === next.id ? next : x)))
  }

  const remaining = COMMENT_MAX_LENGTH - draftText.length
  const hasMore = items.length < total

  // id 给详情页「反馈问题」用：出错的玩家一键滚到这里留言
  return (
    <section
      id="comments"
      className={cx(
        card
          ? 'overflow-hidden rounded-2xl border border-[#dce3e8] bg-white shadow-[0_4px_5px_rgba(0,0,0,0.05)]'
          : 'rounded-2xl border border-line bg-surface p-5',
      )}
      aria-label={c.title}
    >
      <div className={card ? 'px-[18px] pb-4 pt-[19px]' : undefined}>
      <header className="flex items-baseline justify-between">
        <h2 className={card ? 'text-base font-semibold leading-[21px] tracking-[-0.31px] text-[#40485b]' : 'text-sm font-bold'}>
          {card ? c.title : `💬 ${c.title}`}
        </h2>
        {total > 0 && <span className="text-xs text-muted">{fmt(c.count, { n: total })}</span>}
      </header>

      {!commentsAvailable() ? (
        <p className="mt-3 text-xs text-dim">{c.unavailable}</p>
      ) : (
        <>
          {/* ---- 发表 ---- */}
          <div className={card ? 'mt-3' : 'mt-4'}>
              {draftReplyTo && (
                <div className="mb-2 flex items-center justify-between gap-2 rounded-lg bg-surface-2 px-2.5 py-1.5 text-xs">
                  <span className="truncate text-muted">{fmt(c.replyingTo, { name: draftReplyTo.author.nickname || c.guestAuthor })}</span>
                  <button
                    type="button"
                    onClick={() => setReplyTo(null)}
                    className="inline-flex min-h-10 shrink-0 items-center px-2 text-dim transition hover:text-fg"
                  >
                    {c.cancel}
                  </button>
                </div>
              )}
              <textarea
                ref={boxRef}
                value={draftText}
                onChange={(e) => {
                  if (!ownsDraft) {
                    setStoredDraftOwner(draftOwnerKey)
                    setReplyTo(null)
                  }
                  setText(e.target.value)
                  if (formError) setFormError('')
                  if (formNotice) setFormNotice('')
                }}
                rows={3}
                maxLength={COMMENT_MAX_LENGTH}
                aria-label={draftReplyTo ? fmt(c.replyPlaceholder, { name: draftReplyTo.author.nickname || c.guestAuthor }) : card ? c.placeholderCard : c.placeholder}
                placeholder={draftReplyTo ? fmt(c.replyPlaceholder, { name: draftReplyTo.author.nickname || c.guestAuthor }) : card ? c.placeholderCard : c.placeholder}
                className={
                  card
                    ? // 设计稿：105px 高的白底输入框、7px 圆角、#dfe4ea 描边、#bcc1cb 占位字
                      'block h-[105px] min-h-[105px] w-full resize-y rounded-[7px] border border-[#dfe4ea] bg-white px-[11px] py-2 text-sm font-medium leading-[21px] tracking-[-0.31px] text-fg placeholder:text-[#bcc1cb] focus:border-brand focus:outline-none focus:ring-2 focus:ring-brand/30'
                    : 'w-full resize-y rounded-xl border border-line bg-surface-2 px-3 py-2 text-sm text-fg placeholder:text-dim focus:border-brand focus:outline-none focus:ring-2 focus:ring-brand/30'
                }
              />
              {!authReady && <p className="mt-1.5 text-[11px] text-dim">{c.authChecking}</p>}
              {authReady && !user && <p className="mt-1.5 text-[11px] text-dim">{c.guestHint}</p>}
              {/*
                游戏评论这里**没有**打分控件，是有意的：全站给一款游戏打分只有一个入口 ——
                侧栏那张评分卡（GameRating）。理由是打分和评论是两件事：分是给游戏的、
                一人一票、随时可改；评论是一条一条的发言。两个入口摆在一起，
                「发表」这一下到底改没改我的分就说不清了。
                作者打过的分会显示在他每条评论的气泡上（见下面 comment.score 那一段）。
              */}
              <div className={cx('flex items-center justify-between gap-2', card ? 'mt-[11px]' : 'mt-2')}>
                <span className={cx('text-[11px]', remaining < 50 ? 'text-live' : 'text-dim')}>
                  {remaining < 200 ? fmt(c.remaining, { n: remaining }) : ''}
                </span>
                {card ? (
                  /* 设计稿的「发表评论」：32px 高、2px #dfe4ea 描边、底部 4px 同色实心阴影 */
                  <button
                    type="button"
                    onClick={() => void submit()}
                    disabled={!draftText.trim() || sending || !authReady}
                    className="inline-flex h-8 shrink-0 items-center gap-2 rounded-2xl border-2 border-[#dfe4ea] bg-white px-3 text-xs font-bold text-[#263329] shadow-[0_4px_0_0_#dfe4ea] transition-[transform,box-shadow,background-color] duration-100 hover:bg-surface-2 active:translate-y-[3px] active:shadow-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50"
                  >
                    <span aria-hidden>💬</span>
                    {sending ? c.submitting : c.submitCard}
                  </button>
                ) : (
                  <Button size="md" onClick={() => void submit()} disabled={!draftText.trim() || sending || !authReady}>
                    {sending ? c.submitting : c.submit}
                  </Button>
                )}
              </div>
              {authReady && !user && (
                <div className="mt-2 flex justify-end">
                  <Button variant="secondary" size="sm" onClick={openAuthModal}>{c.loginCta}</Button>
                </div>
              )}
          </div>

          {ownsDraft && formError && (
            <p className="mt-2 text-xs text-live" role="alert">
              {formError}
            </p>
          )}
          {ownsDraft && formNotice && <p className="mt-2 text-xs text-online" role="status">{formNotice}</p>}
        </>
      )}
      </div>

      {commentsAvailable() && (
        <>
          {/* ---- 列表 ---- 卡片版用一条分隔线把输入区和列表分开（设计稿上下两块） */}
          <div className={card ? 'border-t border-[#dce3e8] px-[18px] py-4' : 'mt-5'}>
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

            {status === 'ready' && items.length === 0 && (
              card ? (
                <p className="py-4 text-center text-sm leading-[18px] tracking-[-0.15px] text-[#8c92a4]">{c.emptyShort}</p>
              ) : (
                <p className="text-xs text-dim">{c.empty}</p>
              )
            )}

            {status === 'ready' && items.length > 0 && (
              <ul className="divide-y divide-line">
                {items.map((item) => (
                  <CommentItem
                    key={item.id}
                    comment={item}
                    mine={Boolean(user && user.id === item.author.id)}
                    showScore={showScore}
                    onReply={startReply}
                    onDeleted={onDeleted}
                    onEdited={onEdited}
                  />
                ))}
              </ul>
            )}

            {status === 'ready' && hasMore && (
              <>
                {loadMoreError && (
                  <p className="mt-3 text-xs text-live" role="alert">{loadMoreError}</p>
                )}
                <button
                  type="button"
                  onClick={() => void load(page + 1, true)}
                  disabled={more}
                  className="mt-3 min-h-10 w-full rounded-lg border border-line py-2 text-xs text-muted transition hover:border-brand hover:text-fg disabled:opacity-60"
                >
                  {more ? c.loading : loadMoreError ? c.retry : c.loadMore}
                </button>
              </>
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
  showScore,
  onReply,
  onDeleted,
  onEdited,
}: {
  comment: GameComment
  mine: boolean
  showScore: boolean
  onReply: (c: GameComment) => void
  onDeleted: (id: string) => void
  onEdited: (c: GameComment) => void
}) {
  const t = useT()
  const c = t.comments
  const authorName = comment.author.nickname || c.guestAuthor
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
    } finally {
      /*
        成功路径**也要**复位 busy，和 save() 一样走 finally。
        原来只在 catch 里复位，靠的是「父组件会把这条从列表里删掉 → 本组件卸载」
        把问题盖住；一旦 onDeleted 的 id 和实际列表项对不上（并发删除、服务端
        早已删掉），删除按钮就永久卡在 busy —— 用户只能刷新页面。
      */
      setBusy(false)
    }
  }

  return (
    <li className="py-3 first:pt-0">
      <div className="flex gap-2">
        {/* 头像同时是私信入口（见 components/im/DmButton.tsx）。
            没登录、或者点的是自己时，它会退回成一个和原来一模一样的 span。 */}
        <DmAvatar
          peerId={comment.author.id || ''}
          nick={authorName}
          avatar={comment.author.avatar}
          role={comment.author.role}
          className="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-brand-soft text-base"
        />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-[11px]">
            <span className="inline-flex max-w-[8rem] items-center gap-1 truncate text-xs font-semibold">
              {authorName}
              <UserRoleDot
                role={comment.author.role}
                title={comment.author.role === 'admin' ? t.common.roleAdmin : comment.author.role === 'volunteer' ? t.common.roleVolunteer : undefined}
              />
            </span>
            {/* 国旗是 emoji 组合出来的（HK / MO 等系统字体不收的会兜底成内联 SVG）；title 给出国家名，读屏也读得到 */}
            <span title={countryName(comment.country)} aria-label={countryName(comment.country)}>
              {flagOrSvg(comment.country)}
            </span>
            <span className="text-dim">·</span>
            <time className="text-dim" dateTime={comment.createdAt}>
              {timeAgo(comment.createdAt)}
            </time>
            {comment.editedAt && <span className="text-dim">({c.edited})</span>}
            {/* 作者给这款游戏打的分。是 join 出来的当前值，他改分这里会跟着变。
                文章评论没有评分，score 为空，这块自然不画（见 CommentsPanel 的 showScore）。 */}
            {showScore && FEATURES.ratings && comment.score != null && (
              <Stars value={comment.score} size="sm" />
            )}
          </div>

          {/* 引用卡片：回复谁、说了什么 */}
          {comment.quote && (
            <div className="mt-1.5 rounded-lg border-l-2 border-brand/50 bg-surface-2 px-2.5 py-1.5 text-[11px]">
              <p className="truncate text-muted">
                <span aria-hidden>{comment.quote.avatar} </span>
                <span className="inline-flex items-center gap-1 font-semibold">
                  {comment.quote.nickname || c.guestAuthor}
                  <UserRoleDot
                    role={comment.quote.role}
                    title={comment.quote.role === 'admin' ? t.common.roleAdmin : comment.quote.role === 'volunteer' ? t.common.roleVolunteer : undefined}
                  />
                </span>
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
                aria-label={c.edit}
                className="w-full resize-y rounded-lg border border-line bg-surface-2 px-2.5 py-1.5 text-sm text-fg focus:border-brand focus:outline-none focus:ring-2 focus:ring-brand/30"
              />
              <div className="mt-1.5 flex gap-2 text-[11px]">
                <button
                  type="button"
                  onClick={() => void save()}
                  disabled={busy || !draft.trim()}
                  className="inline-flex min-h-10 items-center px-2 font-semibold text-brand-hover disabled:opacity-50"
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
                  className="inline-flex min-h-10 items-center px-2 text-dim transition hover:text-fg"
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
            // 操作命中区保持 40px：窄侧栏里文字虽小，手机拇指也能稳定点中回复 / 编辑 / 删除。
            <div className="mt-0.5 flex flex-wrap items-center gap-x-1.5 text-[11px] text-dim">
              <button type="button" onClick={() => onReply(comment)} className="inline-flex min-h-10 items-center px-2 first:-ml-2 transition hover:text-fg">
                {c.reply}
              </button>
              {editable && (
                <button
                  type="button"
                  onClick={() => {
                    setDraft(comment.content)
                    setEditing(true)
                  }}
                  className="inline-flex min-h-10 items-center px-2 first:-ml-2 transition hover:text-fg"
                >
                  {c.edit}
                </button>
              )}
              {mine && (
                <button
                  type="button"
                  onClick={() => void remove()}
                  disabled={busy}
                  className="inline-flex min-h-10 items-center px-2 first:-ml-2 transition hover:text-live disabled:opacity-50"
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
