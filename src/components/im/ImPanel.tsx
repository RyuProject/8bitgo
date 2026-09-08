import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { cx } from '@/lib/format'
import { useT } from '@/services/i18n'
import { timeAgo } from '@/services/comments'
import { useAuthReady, useCurrentUser } from '@/services/auth'
import { useShell } from '@/components/layout/ShellContext'
import {
  convIdFor,
  ImLookupError,
  ImNotConnectedError,
  imReconnect,
  imState,
  imStateDetail,
  imStop,
  listImConversations,
  listImMessages,
  lookupImUserByEmail,
  markImRead,
  onImConversationsChange,
  onImDmRequest,
  onImMessagesChange,
  onImStateChange,
  registerImPanel,
  sendImText,
  startImWhenIdle,
  takePendingImDm,
  type ImConversation,
  type ImLookupCode,
  type ImMessage,
  type ImState,
} from '@/services/imClient'

/**
 * 站内消息的右侧抽屉。
 *
 * ## 结构上的几个选择
 *
 * 1. **一直挂着、用 transform 滑出**，照 layout/Sidebar.tsx 的写法。条件渲染
 *    （像 AuthModal 那样 `if (!open) return null`）省内存但没有收起动画 ——
 *    一个从右边划出来的面板，收起时直接消失很突兀。
 *
 * 2. **`role="dialog"` 只在打开时才挂上。**这不是洁癖，是个真坑：
 *    emulator/scrollGuard.ts 用 `document.querySelector('[role="dialog"]')` 判断
 *    「页面上是不是开着模态框」，开着就整套让位（方向键交还给页面）。这个面板一直在
 *    DOM 里，role 常驻会让那个守卫**永久失效** —— 玩游戏按方向键会滚动页面。
 *
 * 3. **收起时加 `inert`。**只有 `aria-hidden` + `pointer-events-none` 是不够的：
 *    那两个都不影响键盘焦点，于是关着的抽屉里那些按钮和输入框**仍然在 Tab 顺序里**，
 *    而读屏又拒绝念它们（axe 的 aria-hidden-focus 违规，也是「焦点凭空消失」的经典成因）。
 *    inert 一次解决焦点、点击和辅助技术三件事。React 19 支持布尔写法。
 *
 * 4. **不锁 body 滚动。**仓库里已经有两份互相冲突的滚动锁（ShellContext 会无条件把
 *    overflow 写回 ''，AuthModal 那份存旧值再还原），再加第三份只会更糟。遮罩已经挡住
 *    了背后的交互。
 *
 * 5. **不做 React.lazy。**SDK 是在 services/imClient.ts 里动态 import 的，主包里只有
 *    这个组件的 UI 代码（几 KB）。再套一层 lazy 只会让点开抽屉多一次网络往返。
 */
export function ImPanel() {
  const t = useT()
  const user = useCurrentUser()
  const authReady = useAuthReady()
  const { immersive } = useShell()

  const [open, setOpen] = useState(false)
  /**
   * 打开过没有。**只从 false 变 true，不会变回去。**
   *
   * 抽屉一直挂着，如果内容也一直渲染，「正在连接…」这句会被 SSR 进**每一个页面**的
   * HTML —— 爬虫在每个页面正文里都能读到它，纯噪声。所以首次打开前只渲染空壳；
   * 打开过之后一直留着，这样收起时还有内容跟着滑出去。
   */
  const [mounted, setMounted] = useState(false)
  const [state, setState] = useState<ImState>(() => imState())
  /** 和 state 一起取：detail 不是 React state，只订阅 state 会让第二个错误显示第一个的细节 */
  const [detail, setDetail] = useState(() => imStateDetail())
  const [convs, setConvs] = useState<ImConversation[]>([])
  const [convError, setConvError] = useState(false)
  /** 「按邮箱找人」那一行展开了没有。收起是默认态：绝大多数时候用户是来看会话的 */
  const [composeOpen, setComposeOpen] = useState(false)
  const [emailDraft, setEmailDraft] = useState('')
  const [lookupBusy, setLookupBusy] = useState(false)
  /** 已经本地化好的报错文案。存字符串而不是 code —— 切语言不会重渲染这一句，存 code 反而会留着旧语言 */
  const [lookupError, setLookupError] = useState('')
  const emailRef = useRef<HTMLInputElement>(null)
  const [active, setActive] = useState<{ id: string; peerId: string; nick: string; avatar: string } | null>(null)
  /** 打开抽屉前焦点在哪。关闭时还回去 —— 不还的话焦点会留在刚被 inert 掉的子树里 */
  const returnFocus = useRef<HTMLElement | null>(null)
  const panelRef = useRef<HTMLElement>(null)

  /* ---------------- 注册与生命周期 ---------------- */

  const doOpen = useCallback(() => {
    returnFocus.current = (document.activeElement as HTMLElement) ?? null
    setMounted(true)
    setOpen(true)
  }, [])

  const doClose = useCallback(() => {
    setOpen(false)
    // 关掉时把找人那一行复位。留着的话下次打开会看到一个上次输了一半的邮箱和一句旧报错
    setComposeOpen(false)
    setEmailDraft('')
    setLookupError('')
    // 焦点还给打开它的那颗按钮。inert 生效之后焦点会被浏览器丢到 body 上，
    // 用户再按 Tab 会从头开始 —— 对键盘用户来说等于迷路。
    const el = returnFocus.current
    returnFocus.current = null
    requestAnimationFrame(() => el?.focus?.())
  }, [])

  // 把「怎么打开我」交给 imClient；它连上腾讯之后会再转交给顶栏按钮
  useEffect(() => registerImPanel(doOpen), [doOpen])

  useEffect(
    () =>
      onImStateChange(() => {
        setState(imState())
        setDetail(imStateDetail())
      }),
    [],
  )

  // 登录后空闲时把连接建起来（幂等）。同时这一步会装上标题未读数和回到前台的自检
  useEffect(() => {
    if (user) startImWhenIdle()
  }, [user])

  /*
    退出登录：收掉连接、关掉面板。

    ⚠️ 必须等 authReady。useCurrentUser 的 SSR / 首帧快照恒为 null（见 services/auth.ts），
    只判 `!user` 的话每次页面加载都会先当成「已登出」调一次 imStop() ——
    白跑一趟是小事，真正的问题是它会和空闲时那次连接抢，正好落在那个跨账号竞态里。
  */
  useEffect(() => {
    if (!authReady || user) return
    setOpen(false)
    setActive(null)
    setConvs([])
    setComposeOpen(false)
    setEmailDraft('')
    setLookupError('')
    void imStop()
  }, [authReady, user])

  // 进沉浸模式时收起：那时顶栏整条都不在了，留一个关不掉的面板很怪
  useEffect(() => {
    if (immersive) setOpen(false)
  }, [immersive])

  // 打开时把焦点移进面板。不移的话键盘用户得从顶栏一路 Tab 穿过整页正文才够得到它
  useEffect(() => {
    if (!open) return
    const el = panelRef.current
    if (!el) return
    const first = el.querySelector<HTMLElement>('textarea, button, [href]')
    requestAnimationFrame(() => (first ?? el).focus?.())
  }, [open, active])

  // Esc 关闭
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      /*
        输入法组字期间的 Esc 是「取消候选词」，不是「关闭面板」。
        中日文用户每打错一个词都会按它 —— 不判的话 ChatView 会被卸载，
        整条草稿跟着没了（draft 是组件 state，而 key={active.id} 会强制重挂）。
        Enter 那边一开始就判了 isComposing，这里最初漏了。
      */
      if (e.isComposing) return
      /*
        逐层退出，和返回键的直觉一致：
        会话 -> 列表 -> 关面板；找人那一行展开时，先收它。

        ⚠️ 找人行只在列表视图里存在，所以它和 active 天然互斥，
        两个分支的先后顺序其实无所谓 —— 但写成串行的 else if 而不是两个独立 if，
        是为了保证「一次 Esc 只退一层」。
      */
      if (active) setActive(null)
      else if (composeOpen) setComposeOpen(false)
      else doClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, active, composeOpen, doClose])

  /* ---------------- 会话列表 ---------------- */

  const reload = useCallback(async () => {
    try {
      setConvs(await listImConversations())
      setConvError(false)
    } catch (e) {
      // 没连上和「一条会话都没有」在界面上是两件事，不能都渲染成空列表
      if (e instanceof ImNotConnectedError) setConvError(true)
      else console.warn('[im] 会话列表拉取失败：', e)
    }
  }, [])

  useEffect(() => {
    if (state !== 'ready') return
    void reload()
    return onImConversationsChange(() => void reload())
  }, [state, reload])

  /**
   * 从评论区点头像进来的：把寄存的目标取走，直接进那条会话。
   *
   * 三个触发源都要接：抽屉刚打开、连接刚就绪、以及**抽屉本来就开着时**又点了一次头像
   * （那种情况 open 和 state 都没变，只靠依赖数组是不会重跑的）。
   */
  const takeDm = useCallback(() => {
    const p = takePendingImDm()
    if (p) setActive({ id: convIdFor(p.peerId), peerId: p.peerId, nick: p.nick, avatar: p.avatar })
  }, [])
  useEffect(() => {
    if (open && state === 'ready') takeDm()
  }, [open, state, takeDm])
  useEffect(() => onImDmRequest(takeDm), [takeDm])

  /* ---------------- 按邮箱找人 ---------------- */

  /**
   * code -> 本地文案。**一定要有 default** —— 服务端将来多回一个 code，
   * 这里漏掉的话用户会看到一句空白的红字，比看到「查找失败」还糟。
   */
  const lookupText = useCallback(
    (code: ImLookupCode | string): string => {
      switch (code) {
        case 'bad_email':
          return t.im.emailInvalid
        case 'self':
          return t.im.emailSelf
        case 'not_found':
          return t.im.emailNotFound
        case 'unusable':
          return t.im.emailUnusable
        case 'rate_limited':
          return t.im.emailTooOften
        default:
          return t.im.emailFailed
      }
    },
    [t],
  )

  /**
   * 查到人就直接进会话。
   *
   * 这里**不调 requestImDm** —— 那条路是给「面板还没打开」的场景准备的（评论区点头像），
   * 要先寄存目标再开面板再通知去取。而这一行本来就长在打开着的面板里，
   * 多绕那三步只会多出三处能出错的地方。
   *
   * 也**不预先创建会话**：腾讯的 C2C 会话在发出第一条消息时才真正存在，
   * 直接进一个空会话是正确做法（见 imClient.lookupImUserByEmail 的注释）。
   */
  const startByEmail = useCallback(async () => {
    const addr = emailDraft.trim()
    if (!addr || lookupBusy) return
    setLookupBusy(true)
    setLookupError('')
    try {
      const peer = await lookupImUserByEmail(addr)
      setActive({ id: convIdFor(peer.id), peerId: peer.id, nick: peer.nickname, avatar: peer.avatar })
      // 成功才清空。失败时把用户输的地址留着 —— 多半只是打错一个字母，
      // 清掉等于逼他重敲一遍整个邮箱
      setEmailDraft('')
      setComposeOpen(false)
    } catch (e) {
      setLookupError(lookupText(e instanceof ImLookupError ? e.code : 'failed'))
      if (!(e instanceof ImLookupError)) console.warn('[im] 按邮箱找人失败：', e)
    } finally {
      setLookupBusy(false)
    }
  }, [emailDraft, lookupBusy, lookupText])

  /*
    展开时把焦点送进输入框。

    上面那个「打开面板时聚焦第一个可聚焦元素」的 effect 帮不上忙：
    它的依赖是 [open, active]，展开找人行时两个都没变，不会重跑；
    而且它的选择器是 `textarea, button, [href]`，本来也选不到 input。
  */
  useEffect(() => {
    if (!composeOpen) return
    const id = requestAnimationFrame(() => emailRef.current?.focus())
    return () => cancelAnimationFrame(id)
  }, [composeOpen])

  return (
    <>
      {/* 遮罩。收起时 pointer-events-none —— 否则它会一直吃掉整页的点击 */}
      <div
        aria-hidden
        onMouseDown={doClose}
        className={cx(
          'fixed inset-0 z-[60] bg-black/50 backdrop-blur-sm transition-opacity duration-300',
          open ? 'opacity-100' : 'pointer-events-none opacity-0',
        )}
      />

      <aside
        ref={panelRef}
        tabIndex={-1}
        // 见组件注释第 2 条：role 只在打开时挂
        role={open ? 'dialog' : undefined}
        aria-label={t.im.title}
        // 见第 3 条：inert 一次解决焦点、点击和辅助技术三件事
        inert={!open}
        className={cx(
          'fixed inset-y-0 right-0 z-[61] flex w-full flex-col border-l border-line bg-surface shadow-2xl shadow-black/60 outline-none transition-transform duration-300 ease-out sm:w-[380px]',
          open ? 'translate-x-0' : 'translate-x-full',
        )}
      >
        {mounted && (
          <>
            <header className="flex h-14 shrink-0 items-center gap-2 border-b border-line px-3">
              {active ? (
                <>
                  <button
                    type="button"
                    onClick={() => setActive(null)}
                    aria-label={t.im.back}
                    className="grid h-8 w-8 shrink-0 place-items-center rounded-lg text-muted transition hover:bg-surface-2 hover:text-fg"
                  >
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                      <path d="M15 18l-6-6 6-6" />
                    </svg>
                  </button>
                  <Avatar value={active.avatar} />
                  <span className="min-w-0 flex-1 truncate text-sm font-semibold">{active.nick || t.im.unknownUser}</span>
                </>
              ) : (
                <>
                  <span className="min-w-0 flex-1 truncate text-sm font-semibold">{t.im.title}</span>
                  {/*
                    只在 ready 时给这颗按钮。查人本身是一条普通 REST 请求，没连上也能查通 ——
                    但查到之后会一头栽进一个连不上的会话，那比按钮不出现更让人困惑。
                  */}
                  {state === 'ready' && (
                    <button
                      type="button"
                      onClick={() => {
                        setComposeOpen((v) => !v)
                        setLookupError('')
                      }}
                      aria-label={t.im.newChat}
                      title={t.im.newChat}
                      aria-expanded={composeOpen}
                      className={cx(
                        'grid h-8 w-8 shrink-0 place-items-center rounded-lg transition hover:bg-surface-2 hover:text-fg',
                        composeOpen ? 'bg-surface-2 text-brand' : 'text-muted',
                      )}
                    >
                      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                        <path d="M4 6h16v12H4z" />
                        <path d="m4 7 8 6 8-6" />
                        <path d="M18 3v4M20 5h-4" />
                      </svg>
                    </button>
                  )}
                </>
              )}
              <button
                type="button"
                onClick={doClose}
                aria-label={t.im.close}
                className="grid h-8 w-8 shrink-0 place-items-center rounded-lg text-muted transition hover:bg-surface-2 hover:text-fg"
              >
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden>
                  <path d="M18 6 6 18M6 6l12 12" />
                </svg>
              </button>
            </header>

            {/*
              找人的输入行。放在顶栏和列表之间，收起时整块不渲染 ——
              它不是常驻控件，常驻会让一个「看消息」的面板第一眼像个搜索页。
            */}
            {state === 'ready' && !active && composeOpen && (
              <div className="shrink-0 border-b border-line bg-surface-2/40 p-2">
                <div className="flex items-center gap-2">
                  <input
                    ref={emailRef}
                    type="email"
                    value={emailDraft}
                    onChange={(e) => {
                      setEmailDraft(e.target.value)
                      // 一开始改就把上一次的红字撤掉：留着它会像是在说新输的这个也错了
                      if (lookupError) setLookupError('')
                    }}
                    onKeyDown={(e) => {
                      // 和聊天输入框同一条规矩：组字期间的 Enter 是「确认候选词」，不是提交
                      if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
                        e.preventDefault()
                        void startByEmail()
                      }
                    }}
                    placeholder={t.im.emailPlaceholder}
                    inputMode="email"
                    /*
                      autoComplete="off" 是刻意的：浏览器在这里最想填的是**用户自己的**邮箱，
                      而那恰好是唯一一个填了必然报错的地址。
                      autoCapitalize / spellCheck 关掉是手机键盘的老问题 ——
                      首字母被自动大写、地址被画上红波浪线。
                    */
                    autoComplete="off"
                    autoCapitalize="none"
                    autoCorrect="off"
                    spellCheck={false}
                    disabled={lookupBusy}
                    className="h-9 min-w-0 flex-1 rounded-lg border border-line bg-surface px-3 text-sm outline-none placeholder:text-dim focus:border-brand disabled:opacity-60"
                  />
                  <button
                    type="button"
                    onClick={() => void startByEmail()}
                    disabled={!emailDraft.trim() || lookupBusy}
                    className="h-9 shrink-0 rounded-lg bg-brand px-3 text-sm font-semibold text-white transition hover:bg-brand-hover disabled:opacity-40"
                  >
                    {lookupBusy ? t.im.emailSearching : t.im.emailGo}
                  </button>
                </div>
                {lookupError ? (
                  // role="alert" 让读屏在原地念出来 —— 焦点还在输入框里，不会自己跑过来读
                  <p role="alert" className="mt-1.5 px-1 text-[11px] leading-relaxed text-live">
                    {lookupError}
                  </p>
                ) : (
                  <p className="mt-1.5 px-1 text-[11px] leading-relaxed text-dim">{t.im.emailHint}</p>
                )}
              </div>
            )}

            {state !== 'ready' ? (
              <StatusBody state={state} detail={detail} />
            ) : active ? (
              <ChatView key={active.id} conv={active} open={open} />
            ) : (
              <ConversationList
                convs={convs}
                error={convError}
                onPick={(c) => setActive({ id: c.id, peerId: c.peerId, nick: c.nick, avatar: c.avatar })}
                onNew={() => {
                  setComposeOpen(true)
                  setLookupError('')
                }}
              />
            )}
          </>
        )}
      </aside>
    </>
  )
}

/**
 * 头像。本站的头像是 emoji（users.avatar），但腾讯那个字段语义上是 URL ——
 * 两种都可能出现，所以按内容判断怎么画；图片挂了也要退回文字，不能留一个破图框。
 */
function Avatar({ value, size = 'sm' }: { value: string; size?: 'sm' | 'md' }) {
  const [broken, setBroken] = useState(false)
  const box = size === 'md' ? 'h-9 w-9 text-lg' : 'h-8 w-8 text-base'
  const isUrl = /^https?:\/\//.test(value) && !broken
  return (
    <span className={cx('grid shrink-0 place-items-center overflow-hidden rounded-full bg-surface-2', box)} aria-hidden>
      {isUrl ? (
        <img src={value} alt="" onError={() => setBroken(true)} className="h-full w-full object-cover" />
      ) : (
        <span>{broken || !value ? '🕹️' : value}</span>
      )}
    </span>
  )
}

/**
 * 连接中 / 被踢 / 出错 共用这一块。
 *
 * ⚠️ 这里**没有** `unavailable` 分支。第一版写了一整段（🚧 图标 + 占位文案），
 * 但那段代码不可达：`unavailable` 意味着 /api/im/sig 回了 501，于是从来没有
 * publishOpener、requestImDm 也返回 false，抽屉根本不会被打开。那种情况用户看到的是
 * ChatButton 自己的「即将上线」占位面板 —— 那才是接缝设计好的兜底。
 */
function StatusBody({ state, detail }: { state: ImState; detail: string }) {
  const t = useT()
  const [busy, setBusy] = useState(false)

  if (state === 'connecting' || state === 'off' || state === 'unavailable') {
    return (
      <div className="flex flex-1 items-center justify-center p-6 text-sm text-muted">
        <span className="animate-pulse">{t.im.connecting}</span>
      </div>
    )
  }

  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-3 p-6 text-center">
      <span className="text-3xl" aria-hidden>
        {state === 'kicked' ? '👋' : '⚠️'}
      </span>
      <p className="text-sm font-semibold">{state === 'kicked' ? t.im.kicked : t.im.error}</p>
      {state === 'kicked' && <p className="max-w-[16rem] text-xs leading-relaxed text-muted">{t.im.kickedHint}</p>}
      {state === 'error' && detail && <p className="max-w-[16rem] break-all text-xs text-dim">{detail}</p>}
      <button
        type="button"
        onClick={async () => {
          setBusy(true)
          try {
            await imReconnect()
          } finally {
            setBusy(false)
          }
        }}
        disabled={busy}
        className="mt-1 rounded-lg border border-line px-3 py-1.5 text-xs font-semibold transition hover:border-brand hover:text-brand disabled:opacity-50"
      >
        {t.im.reconnect}
      </button>
    </div>
  )
}

function ConversationList({
  convs,
  error,
  onPick,
  onNew,
}: {
  convs: ImConversation[]
  error: boolean
  onPick: (c: ImConversation) => void
  /** 打开顶栏那一行「按邮箱找人」。空列表时这里是唯一的入口 */
  onNew: () => void
}) {
  const t = useT()

  if (error) return <StatusBody state="error" detail="" />

  if (!convs.length) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-2 p-6 text-center">
        <span className="text-3xl" aria-hidden>
          💬
        </span>
        <p className="text-sm font-semibold">{t.im.empty}</p>
        <p className="max-w-[16rem] text-xs leading-relaxed text-muted">{t.im.emptyHint}</p>
        {/*
          一条会话都没有的时候，顶栏那颗 ✉️ 是整块面板里唯一能做的事，
          而它在角落里、只有 32 见方。这里再给一个说得出话的入口 ——
          空状态本来就该告诉用户「下一步按什么」，而不只是「这里没东西」。
        */}
        <button
          type="button"
          onClick={onNew}
          className="mt-1 rounded-lg border border-line px-3 py-1.5 text-xs font-semibold transition hover:border-brand hover:text-brand"
        >
          {t.im.newChat}
        </button>
      </div>
    )
  }

  return (
    <ul className="flex-1 overflow-y-auto">
      {convs.map((c) => (
        <li key={c.id}>
          <button
            type="button"
            onClick={() => onPick(c)}
            className="flex w-full items-center gap-3 px-3 py-2.5 text-left transition hover:bg-surface-2"
          >
            <Avatar value={c.avatar} size="md" />
            <span className="min-w-0 flex-1">
              <span className="flex items-baseline gap-2">
                <span className="min-w-0 flex-1 truncate text-sm font-semibold">{c.nick || c.peerId}</span>
                {c.lastTime > 0 && (
                  <span className="shrink-0 text-[10px] text-dim">{timeAgo(new Date(c.lastTime * 1000).toISOString())}</span>
                )}
              </span>
              <span className="mt-0.5 flex items-center gap-2">
                <span className="min-w-0 flex-1 truncate text-xs text-muted">{c.lastText}</span>
                {c.unread > 0 && (
                  <span className="grid h-4 min-w-4 shrink-0 place-items-center rounded-full bg-live px-1 text-[10px] font-bold leading-none text-white">
                    {c.unread > 99 ? '99+' : c.unread}
                  </span>
                )}
              </span>
            </span>
          </button>
        </li>
      ))}
    </ul>
  )
}

/**
 * 只往后追加没见过的消息。
 *
 * ⚠️ 这个函数是修一个**严重 bug** 的：第一版收到新消息时直接 `setItems(page.items)`，
 * 把整个数组换成第一页 —— 用户翻了五页历史（75 条），对方发一条，60 条**当场消失**，
 * 游标回退，视口在脚下塌陷。
 *
 * 用「追加没见过的」而不是「按时间合并重排」：腾讯的 time 是**秒级**，同一秒里的
 * 多条消息排序会被打乱；而新消息一定比手上所有消息都新，追加到末尾天然有序。
 * 没有新东西就原样返回 prev —— 让 React 跳过这次重渲染。
 */
function appendNew(prev: ImMessage[], incoming: ImMessage[]): ImMessage[] {
  if (!prev.length) return incoming
  const have = new Set(prev.map((m) => m.id))
  const add = incoming.filter((m) => !have.has(m.id))
  return add.length ? [...prev, ...add] : prev
}

function ChatView({
  conv,
  open,
}: {
  conv: { id: string; peerId: string; nick: string; avatar: string }
  open: boolean
}) {
  const t = useT()
  /** 服务端已知的消息。**只追加、只前置，永不整体替换**（见 appendNew） */
  const [items, setItems] = useState<ImMessage[]>([])
  /**
   * 正在发/发失败的消息，**和 items 分开存**。
   *
   * 第一版把乐观消息塞进 items，于是发送在飞时对方回一条 -> 刷新把整个数组换掉 ->
   * 乐观条目被冲掉 -> 发送兑现后那个 `map` 匹配不到任何东西，**消息已经送达但界面上
   * 永远没有**。分开存之后，刷新动不到它。
   */
  const [pending, setPending] = useState<ImMessage[]>([])
  const [cursor, setCursor] = useState('')
  const [done, setDone] = useState(false)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState(false)
  const [draft, setDraft] = useState('')
  const [sending, setSending] = useState(false)
  /** 有没有新消息到过。只用它触发已读上报，不参与渲染 */
  const [incoming, setIncoming] = useState(0)

  const scroller = useRef<HTMLDivElement>(null)
  /** 上一次是不是贴在底部。决定来新消息要不要跟着滚 */
  const stick = useRef(true)
  /** 翻历史时记下的锚点：加载前的 scrollHeight 和 scrollTop */
  const anchor = useRef<{ h: number; top: number } | null>(null)
  /** 请求序号。并发的刷新只让最后一次生效，否则旧快照会盖掉新数据 */
  const seq = useRef(0)

  /** 拉最新一页。first=true 时才动游标（翻过的历史不能被它重置） */
  const fetchLatest = useCallback(
    async (first: boolean) => {
      const my = ++seq.current
      if (first) setLoading(true)
      try {
        const page = await listImMessages(conv.id)
        if (my !== seq.current) return
        setItems((prev) => (prev.length ? appendNew(prev, page.items) : page.items))
        if (first) {
          setCursor(page.cursor)
          setDone(page.done)
        }
        setLoadError(false)
      } catch (e) {
        if (my !== seq.current) return
        if (e instanceof ImNotConnectedError) setLoadError(true)
        else console.warn('[im] 历史消息拉取失败：', e)
        /*
          首屏就失败时把 done 置真。不置的话会留下一颗「看更早的消息」按钮，
          按下去每次都失败、永远消失不了 —— 从评论区点开一条**还不存在**的会话
          （C2C<peerId> 服务端还没有）就正好是这个情形。
        */
        if (first) setDone(true)
      } finally {
        if (my === seq.current) setLoading(false)
      }
    },
    [conv.id],
  )

  // 首屏，以及每次重新打开抽屉时补一次最新的（appendNew 保证不会毁掉翻过的历史）
  useEffect(() => {
    if (!open) return
    void fetchLatest(items.length === 0)
    // items.length 故意不进依赖数组：它变一次就重拉一次会变成死循环
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, fetchLatest])

  // 新消息到达：只在抽屉开着时拉。关着的时候红点由 SDK 的未读总数负责，
  // 在这儿刷一个看不见的面板是纯浪费
  useEffect(() => {
    if (!open) return
    return onImMessagesChange((id) => {
      if (id !== conv.id) return
      setIncoming((n) => n + 1)
      void fetchLatest(false)
    })
  }, [open, conv.id, fetchLatest])

  /*
    标记已读。依赖里是 incoming 而不是 items.length ——
    第一版用后者，于是每发一条、每翻一页、每收一条都要上报一次，
    一次正常会话大约 40 多次网络写，而实际需要两三次。
  */
  useEffect(() => {
    if (open) void markImRead(conv.id)
  }, [open, conv.id, incoming])

  /*
    滚动定位。用 useLayoutEffect 而不是 useEffect + rAF：

    · effect 在浏览器绘制**之后**跑，会先画出停在原处的一帧再跳，肉眼能看到闪一下；
    · 第一版翻历史时用 rAF 还原位置，那和 React 的提交是**竞态** —— rAF 抢在提交
      之前跑的话，读到的 scrollHeight 还没包含新插入的节点，差值算成 0，
      于是把用户甩到最顶上。

    锚点分支优先：翻历史时不管 stick 是什么都按锚点还原
    （第一版这里也有坑 —— stick 初值 true 且不滚动就不会变，
      点「看更早的消息」会被甩到底部）。
  */
  useLayoutEffect(() => {
    const el = scroller.current
    if (!el) return
    const a = anchor.current
    if (a) {
      anchor.current = null
      // 加上 a.top：只算 scrollHeight 差值的话，只有原本停在最顶端时才对
      el.scrollTop = el.scrollHeight - a.h + a.top
      return
    }
    if (stick.current) el.scrollTop = el.scrollHeight
  }, [items, pending])

  const onScroll = () => {
    const el = scroller.current
    if (!el) return
    stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40
  }

  const loadMore = async () => {
    const el = scroller.current
    if (done || loading || !el) return
    anchor.current = { h: el.scrollHeight, top: el.scrollTop }
    setLoading(true)
    try {
      const page = await listImMessages(conv.id, cursor)
      setItems((prev) => {
        const have = new Set(prev.map((m) => m.id))
        const add = page.items.filter((m) => !have.has(m.id))
        return add.length ? [...add, ...prev] : prev
      })
      setCursor(page.cursor)
      setDone(page.done)
    } catch (e) {
      anchor.current = null
      if (e instanceof ImNotConnectedError) setLoadError(true)
      else console.warn('[im] 翻页失败：', e)
    } finally {
      setLoading(false)
    }
  }

  /** 真正把一条消息送出去。发送和重试共用 */
  const deliver = useCallback(
    async (text: string, localId: string) => {
      setSending(true)
      try {
        const real = await sendImText(conv.peerId, text)
        setPending((p) => p.filter((m) => m.id !== localId))
        // 本地发出的消息 SDK **不会**推 MESSAGE_RECEIVED（只有同账号其他端发的才会），
        // 所以这里要自己把它并进 items
        setItems((prev) => appendNew(prev, [real]))
      } catch (e) {
        const notConnected = e instanceof ImNotConnectedError
        if (!notConnected) console.warn('[im] 发送失败：', e)
        setPending((p) => p.map((m) => (m.id === localId ? { ...m, status: 'failed' } : m)))
        setLoadError(notConnected)
      } finally {
        setSending(false)
      }
    },
    [conv.peerId],
  )

  const send = () => {
    const body = draft.trim()
    if (!body || sending) return
    const localId = `local-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`
    /*
      乐观渲染：先把消息画出来。200ms 的往返里输入框空了但消息不出现，
      用户会以为没发出去，于是再点一次。

      失败时**不把文本还给输入框** —— 第一版那么做，而输入框在发送期间并没有禁用，
      于是三秒后失败会用旧文本覆盖用户新打的字，且不可恢复。
      现在失败的气泡自己带一颗「重试」。
    */
    setPending((p) => [...p, { id: localId, mine: true, text: body, time: Math.floor(Date.now() / 1000), status: 'sending' }])
    setDraft('')
    stick.current = true
    void deliver(body, localId)
  }

  const shown = pending.length ? [...items, ...pending] : items

  return (
    <>
      <div ref={scroller} onScroll={onScroll} className="flex-1 overflow-y-auto px-3 py-3">
        {!done && (
          <div className="mb-3 text-center">
            <button
              type="button"
              onClick={() => void loadMore()}
              disabled={loading}
              className="rounded-full border border-line px-3 py-1 text-[11px] text-muted transition hover:border-brand hover:text-brand disabled:opacity-50"
            >
              {loading ? t.common.loadingMore : t.im.loadMore}
            </button>
          </div>
        )}
        <ul className="flex flex-col gap-2">
          {shown.map((m) => (
            <li key={m.id} className={cx('flex', m.mine ? 'justify-end' : 'justify-start')}>
              <div
                className={cx(
                  'max-w-[80%] rounded-2xl px-3 py-2 text-sm leading-relaxed',
                  m.mine ? 'bg-brand text-white' : 'bg-surface-2 text-fg',
                  m.status === 'failed' && 'opacity-70 ring-1 ring-live',
                )}
              >
                {/* whitespace-pre-wrap：消息里的换行要留住，同时长串字符要能断行 */}
                <p className="whitespace-pre-wrap break-words">{m.text}</p>
                <p className={cx('mt-1 flex items-center gap-2 text-[10px]', m.mine ? 'text-white/60' : 'text-dim')}>
                  {m.status === 'sending' ? (
                    t.im.sending
                  ) : m.status === 'failed' ? (
                    <>
                      <span>{t.im.sendFailed}</span>
                      <button
                        type="button"
                        onClick={() => void deliver(m.text, m.id)}
                        disabled={sending}
                        className="underline underline-offset-2 disabled:opacity-50"
                      >
                        {t.im.retry}
                      </button>
                    </>
                  ) : (
                    // time 为 0 表示 SDK 没给时间。渲染出来会变成「1970年1月1日」
                    m.time > 0 && timeAgo(new Date(m.time * 1000).toISOString())
                  )}
                </p>
              </div>
            </li>
          ))}
        </ul>
      </div>

      <div className="shrink-0 border-t border-line p-2">
        {loadError && <p className="mb-1 px-1 text-[11px] text-live">{t.im.notConnected}</p>}
        <div className="flex items-end gap-2">
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              // Enter 发送、Shift+Enter 换行。输入法组字期间的 Enter 是「确认候选词」，
              // 不能当发送 —— 中日文用户每打一个词都会误发一条
              if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault()
                send()
              }
            }}
            rows={1}
            placeholder={t.im.placeholder}
            className="max-h-28 min-h-9 flex-1 resize-y rounded-lg border border-line bg-surface-2 px-3 py-2 text-sm outline-none placeholder:text-dim focus:border-brand"
          />
          <button
            type="button"
            onClick={send}
            disabled={!draft.trim() || sending}
            className="h-9 shrink-0 rounded-lg bg-brand px-3 text-sm font-semibold text-white transition hover:bg-brand-hover disabled:opacity-40"
          >
            {t.im.send}
          </button>
        </div>
      </div>
    </>
  )
}
