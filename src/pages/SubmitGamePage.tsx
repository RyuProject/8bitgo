import { useEffect, useMemo, useRef, useState } from 'react'
import { useSeo } from '@/services/seo'
import { useT, fmt } from '@/services/i18n'
import { useCurrentUser, useAuthReady } from '@/services/auth'
import { openAuthModal } from '@/services/authModal'
import { api, apiBase, apiEnabled, getToken } from '@/services/api'
import {
  SUBMIT_ROM_LANGS,
  DEFAULT_SUBMIT_MAX_FILE_MB,
  DEFAULT_SUBMIT_MAX_TOTAL_MB,
  isAllowedRomExt,
} from '../../shared/game-submission.js'

/**
 * 语言列表**从 shared 里取**，这里只补一张「语言 -> 文案键」的对照表。
 * 各写一份的话，后端加了一种语言而前端没跟上，那一栏就永远没人能填 —— 而且不报错。
 */
const ROM_LANG_LABEL_KEY = {
  en: 'romEn',
  ja: 'romJa',
  zh: 'romZh',
  zhHant: 'romZhHant',
  de: 'romDe',
  fr: 'romFr',
  it: 'romIt',
  es: 'romEs',
} as const

const ROM_LANGS = SUBMIT_ROM_LANGS.map((key) => ({ key, labelKey: ROM_LANG_LABEL_KEY[key] }))

interface Suggestion {
  slug: string
  title: string
  titleZh: string | null
  platform: string
}

interface Limits {
  maxFileBytes: number
  maxTotalBytes: number
}

const MB = 1024 * 1024
/** 拿不到 /limits 时的兜底，和 shared 里的默认值一致 */
const FALLBACK_LIMITS: Limits = {
  maxFileBytes: DEFAULT_SUBMIT_MAX_FILE_MB * MB,
  maxTotalBytes: DEFAULT_SUBMIT_MAX_TOTAL_MB * MB,
}

const human = (n: number) => (n < MB ? `${(n / 1024).toFixed(0)} KB` : `${(n / MB).toFixed(1)} MB`)

const inputClass =
  'w-full rounded-xl border border-line-strong bg-surface px-3.5 py-2.5 text-sm text-fg outline-none transition placeholder:text-dim focus:border-brand focus:ring-2 focus:ring-brand/30'

/**
 * 带上传进度的 POST。
 *
 * 为什么不用 fetch：fetch 拿不到**上传**方向的进度。ROM 动辄十几兆，
 * 点完提交之后按钮只是变灰、十几秒没有任何反馈 —— 用户会以为卡死了然后再点一次，
 * 于是同一份 ROM 发两封信。XHR 是目前唯一能报上传进度的办法（services/roms.ts 同理）。
 */
function postFormWithProgress(
  url: string,
  fd: FormData,
  token: string,
  onProgress: (pct: number) => void,
): Promise<{ ok: boolean; status: number; error?: string }> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest()
    xhr.open('POST', url)
    if (token) xhr.setRequestHeader('Authorization', `Bearer ${token}`)
    xhr.upload.onprogress = (e) => {
      // 传完还要等服务端发信，封顶 99%，免得停在 100% 让人以为卡住
      if (e.lengthComputable) onProgress(Math.min(99, Math.round((e.loaded / e.total) * 100)))
    }
    xhr.onerror = () => reject(new Error('network'))
    xhr.onabort = () => reject(new Error('abort'))
    xhr.onload = () => {
      let error: string | undefined
      try {
        error = JSON.parse(xhr.responseText)?.error
      } catch {
        /* 非 JSON（网关错误页之类），下面只看状态码 */
      }
      resolve({ ok: xhr.status >= 200 && xhr.status < 300, status: xhr.status, error })
    }
    xhr.send(fd)
  })
}

/**
 * 提交游戏页。
 *
 * 必须登录：未登录渲染登录引导，点按钮走全局登录弹窗。
 * ROM 作为 multipart 附件直接 POST 给后端，后端转成邮件发出，不落 R2 也不落库 ——
 * 所以大小上限由**邮箱**决定，见 shared/game-submission.js 的注释。
 */
export function SubmitGamePage() {
  const t = useT()
  const copy = t.submitGame
  const user = useCurrentUser()
  const authReady = useAuthReady()

  useSeo({ title: copy.metaTitle, description: copy.metaDescription, noindex: true })

  const [name, setName] = useState('')
  const [existingSlug, setExistingSlug] = useState('')
  const [description, setDescription] = useState('')
  const [reason, setReason] = useState('')
  const [roms, setRoms] = useState<Record<string, File | null>>({})
  const [romLinks, setRomLinks] = useState<Record<string, string>>({})
  const [suggestions, setSuggestions] = useState<Suggestion[]>([])
  /** idle=还没查 / loading=查着 / done=查完了（done 且 suggestions 为空才敢说「库里没有」） */
  const [suggestState, setSuggestState] = useState<'idle' | 'loading' | 'done'>('idle')
  const [showSuggest, setShowSuggest] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [progress, setProgress] = useState<number | null>(null)
  const [done, setDone] = useState(false)
  const [error, setError] = useState('')
  const [limits, setLimits] = useState<Limits>(FALLBACK_LIMITS)

  const nameBoxRef = useRef<HTMLDivElement>(null)

  /**
   * 问一下服务端真正生效的大小上限。
   * 不能只用 shared 里的默认值：上限是环境变量改得动的，前端写死就会出现
   * 「页面说 20MB 没问题，传完却被拒」。拿不到就退回默认值，不影响使用。
   */
  useEffect(() => {
    if (!apiEnabled()) return
    let alive = true
    api
      .get<Limits>('/api/submit-game/limits')
      .then((data) => {
        if (alive && data?.maxTotalBytes) setLimits(data)
      })
      .catch(() => {
        /* 拿不到就用默认值 */
      })
    return () => {
      alive = false
    }
  }, [])

  // 输入游戏名时联想游戏库里有没有同名的
  useEffect(() => {
    const q = name.trim()
    if (!apiEnabled() || q.length < 1) {
      setSuggestions([])
      setSuggestState('idle')
      return
    }
    setSuggestState('loading')
    const id = setTimeout(async () => {
      try {
        const data = await api.get<{ items: Suggestion[] }>(
          `/api/games/suggest?q=${encodeURIComponent(q)}&limit=6`,
        )
        setSuggestions(data.items || [])
      } catch {
        setSuggestions([])
      } finally {
        setSuggestState('done')
      }
    }, 250)
    return () => clearTimeout(id)
  }, [name])

  // 点击外部关闭联想下拉
  useEffect(() => {
    const onDoc = (e: MouseEvent) => {
      if (nameBoxRef.current && !nameBoxRef.current.contains(e.target as Node)) setShowSuggest(false)
    }
    document.addEventListener('mousedown', onDoc)
    return () => document.removeEventListener('mousedown', onDoc)
  }, [])

  const totalBytes = useMemo(
    () => Object.values(roms).reduce((sum, f) => sum + (f?.size ?? 0), 0),
    [roms],
  )
  const overLimit = totalBytes > limits.maxTotalBytes

  function pickSuggestion(s: Suggestion) {
    setName(s.titleZh || s.title)
    setExistingSlug(s.slug)
    setShowSuggest(false)
    setSuggestions([])
    setSuggestState('done')
  }

  /**
   * 选文件的当下就检查格式和大小。
   *
   * 服务端当然还会再查一遍（前端的检查永远只是提示），但**必须**在这里也查：
   * 等传完二十兆才被告知「.exe 收不了」，那二十兆的上行流量和等待时间就白花了。
   */
  function setRom(key: string, file: File | null) {
    setError('')
    if (file) {
      if (!isAllowedRomExt(file.name)) {
        setError(fmt(copy.errorBadExt, { name: file.name }))
        return
      }
      if (file.size > limits.maxFileBytes) {
        setError(fmt(copy.errorFileTooLarge, { name: file.name, max: human(limits.maxFileBytes) }))
        return
      }
    }
    setRoms((prev) => ({ ...prev, [key]: file }))
  }

  function setRomLink(key: string, value: string) {
    setRomLinks((prev) => ({ ...prev, [key]: value }))
  }

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault()
    setError('')
    if (!name.trim() || !description.trim()) {
      setError(copy.errorFields)
      return
    }
    const hasRom =
      Object.values(roms).some(Boolean) || Object.values(romLinks).some((v) => v.trim())
    if (!hasRom) {
      setError(copy.errorRom)
      return
    }
    // 总量超了就别传了 —— 传上去服务端也只会退回来，白等一趟
    if (overLimit) {
      setError(fmt(copy.errorTotalTooLarge, { total: human(totalBytes), max: human(limits.maxTotalBytes) }))
      return
    }

    const fd = new FormData()
    fd.append('name', name.trim())
    fd.append('description', description.trim())
    fd.append('reason', reason.trim())
    if (existingSlug) fd.append('existingSlug', existingSlug)
    for (const { key } of ROM_LANGS) {
      const f = roms[key]
      if (f) fd.append(`rom_${key}`, f, f.name)
      const link = romLinks[key]?.trim()
      if (link) fd.append(`rom_link_${key}`, link)
    }

    setSubmitting(true)
    setProgress(0)
    try {
      /**
       * ⚠️ 必须用 apiBase() 拼地址，不能写死相对路径 '/api/…'。
       * VITE_API_URL 填绝对地址（前后端分域）的部署里，相对路径会打到**前端**那个域名上，
       * 那儿根本没有这个接口 —— 而 same-origin 部署下一切正常，所以很容易一直没人发现。
       */
      const res = await postFormWithProgress(
        `${apiBase()}/api/submit-game`,
        fd,
        getToken(),
        setProgress,
      )
      if (!res.ok) {
        setError(res.error || copy.errorGeneric)
        return
      }
      setDone(true)
    } catch {
      setError(copy.errorGeneric)
    } finally {
      setSubmitting(false)
      setProgress(null)
    }
  }

  // 登录态还没确定：先不渲染，避免已登录用户被弹一次登录引导
  if (!authReady) return null

  if (!user) {
    return (
      <div className="container-x py-20">
        <div className="mx-auto max-w-md rounded-3xl border border-line bg-surface p-8 text-center">
          <div className="mb-4 text-4xl" aria-hidden>🔒</div>
          <h1 className="text-2xl font-extrabold">{copy.loginRequired}</h1>
          <p className="mt-2 text-sm text-muted">{copy.loginRequiredHint}</p>
          <button
            type="button"
            onClick={() => openAuthModal()}
            className="mt-6 inline-flex h-11 items-center justify-center rounded-2xl bg-brand px-6 text-sm font-bold text-white shadow-[0_4px_0_0_var(--color-brand-shadow)] transition active:translate-y-[3px] active:shadow-none"
          >
            {copy.loginCta}
          </button>
        </div>
      </div>
    )
  }

  if (done) {
    return (
      <div className="container-x py-20">
        <div className="mx-auto max-w-md rounded-3xl border border-line bg-surface p-8 text-center">
          <div className="mb-4 text-4xl" aria-hidden>✅</div>
          <h1 className="text-2xl font-extrabold">{copy.successTitle}</h1>
          <p className="mt-2 text-sm text-muted">{copy.successBody}</p>
          <button
            type="button"
            onClick={() => {
              setDone(false)
              setName('')
              setExistingSlug('')
              setDescription('')
              setReason('')
              setRoms({})
              setRomLinks({})
              setSuggestState('idle')
            }}
            className="mt-6 inline-flex h-11 items-center justify-center rounded-2xl border-2 border-line-strong bg-surface px-6 text-sm font-bold text-fg shadow-[0_4px_0_0_var(--color-line-strong)] transition active:translate-y-[3px] active:shadow-none"
          >
            {copy.submitAnother}
          </button>
        </div>
      </div>
    )
  }

  const notInLibrary = suggestState === 'done' && suggestions.length === 0 && name.trim().length > 0

  return (
    <div className="container-x max-w-2xl py-10 sm:py-14">
      <h1 className="text-3xl font-extrabold tracking-tight">{copy.heading}</h1>
      <p className="mt-2 text-sm text-muted">{copy.intro}</p>

      <form onSubmit={onSubmit} className="mt-8 space-y-6">
        {/* 游戏名称 + 联想 */}
        <div ref={nameBoxRef} className="relative">
          <label className="mb-1.5 block text-sm font-semibold">
            {copy.nameLabel} <span className="text-live">*</span>
          </label>
          <input
            className={inputClass}
            value={name}
            placeholder={copy.namePlaceholder}
            onChange={(e) => {
              setName(e.target.value)
              setExistingSlug('')
              setShowSuggest(true)
            }}
            onFocus={() => setShowSuggest(true)}
            autoComplete="off"
          />
          {showSuggest && suggestions.length > 0 && (
            <ul className="absolute z-20 mt-1 w-full overflow-hidden rounded-xl border border-line bg-surface shadow-xl">
              {suggestions.map((s) => (
                <li key={s.slug}>
                  <button
                    type="button"
                    onClick={() => pickSuggestion(s)}
                    className="flex w-full items-center justify-between gap-3 px-3.5 py-2.5 text-left text-sm transition hover:bg-black/5"
                  >
                    <span className="min-w-0 truncate font-medium">{s.titleZh || s.title}</span>
                    <span className="shrink-0 text-[11px] text-muted">{copy.inLibrary}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
          {existingSlug ? (
            <p className="mt-1.5 text-xs text-coin">✓ {fmt(copy.nameExistingHint, { title: name })}</p>
          ) : notInLibrary ? (
            /**
             * 「查过了，库里没有」必须**显式**说出来。
             * 只画有结果的下拉框的话，「还没查」和「查完没有」在界面上长得一模一样，
             * 用户没法从「什么都没弹出来」里得到任何结论 —— 而这一栏的用处就是让他知道
             * 该不该提交这款游戏。
             */
            <p className="mt-1.5 text-xs text-muted">{copy.notInLibrary}</p>
          ) : null}
        </div>

        {/* 游戏简介 */}
        <div>
          <label className="mb-1.5 block text-sm font-semibold">
            {copy.descLabel} <span className="text-live">*</span>
          </label>
          <textarea
            className={inputClass}
            rows={4}
            value={description}
            placeholder={copy.descPlaceholder}
            onChange={(e) => setDescription(e.target.value)}
          />
        </div>

        {/* ROM 上传 */}
        <div>
          <label className="mb-1.5 block text-sm font-semibold">
            {copy.romLabel} <span className="text-live">*</span>
          </label>
          <p className="mb-1 text-xs text-muted">{copy.romHint}</p>
          <p className="mb-3 text-xs text-muted">
            {fmt(copy.romSizeHint, { file: human(limits.maxFileBytes), total: human(limits.maxTotalBytes) })}
          </p>
          <div className="grid gap-3 sm:grid-cols-2">
            {ROM_LANGS.map(({ key, labelKey }) => {
              const file = roms[key]
              const link = romLinks[key] || ''
              return (
                <div key={key} className="rounded-xl border border-line bg-surface-2/40 p-3">
                  <span className="block text-xs font-semibold text-muted">{copy[labelKey]}</span>
                  <label className="mt-2 flex cursor-pointer items-center gap-2 rounded-lg border border-dashed border-line-strong px-3 py-2 text-xs transition hover:border-brand">
                    <span className="min-w-0 flex-1 truncate text-fg">
                      {file ? `${file.name}（${human(file.size)}）` : copy.chooseFile}
                    </span>
                    <input
                      type="file"
                      className="sr-only"
                      onChange={(e) => {
                        setRom(key, e.target.files?.[0] ?? null)
                        // 选中被拒（格式/大小）时把 input 清掉，否则显示的还是那个文件名
                        e.target.value = ''
                      }}
                    />
                    {file && (
                      <button
                        type="button"
                        onClick={(e) => {
                          // 按钮嵌在 <label> 里：不拦住的话点「移除」会顺带把文件选择器打开
                          e.preventDefault()
                          e.stopPropagation()
                          setRom(key, null)
                        }}
                        className="shrink-0 text-dim transition hover:text-live"
                        aria-label={copy.removeFile}
                      >
                        ✕
                      </button>
                    )}
                  </label>
                  <span className="mt-2 block text-[11px] text-muted">{copy.romLinkLabel}</span>
                  <input
                    className="mt-1 w-full rounded-lg border border-line-strong bg-surface px-3 py-2 text-xs text-fg outline-none transition placeholder:text-dim focus:border-brand"
                    value={link}
                    placeholder={copy.romLinkPlaceholder}
                    inputMode="url"
                    onChange={(e) => setRomLink(key, e.target.value)}
                  />
                </div>
              )
            })}
          </div>
          {totalBytes > 0 && (
            <p className={`mt-2 text-xs ${overLimit ? 'text-live' : 'text-muted'}`}>
              {fmt(copy.romTotalHint, { total: human(totalBytes), max: human(limits.maxTotalBytes) })}
            </p>
          )}
        </div>

        {/* 提交理由 */}
        <div>
          <label className="mb-1.5 block text-sm font-semibold">{copy.reasonLabel}</label>
          <textarea
            className={inputClass}
            rows={3}
            value={reason}
            placeholder={copy.reasonPlaceholder}
            onChange={(e) => setReason(e.target.value)}
          />
        </div>

        {error && (
          <p className="rounded-xl border border-live/30 bg-live/10 px-4 py-3 text-sm text-live">{error}</p>
        )}

        {submitting && progress !== null && (
          <div>
            <div className="h-2 overflow-hidden rounded-full bg-line">
              <div className="h-full rounded-full bg-brand transition-[width]" style={{ width: `${progress}%` }} />
            </div>
            <p className="mt-1.5 text-xs text-muted">{fmt(copy.uploadingPct, { n: String(progress) })}</p>
          </div>
        )}

        <button
          type="submit"
          disabled={submitting || overLimit}
          className="inline-flex h-12 items-center justify-center rounded-2xl bg-brand px-8 text-base font-bold text-white shadow-[0_4px_0_0_var(--color-brand-shadow)] transition active:translate-y-[3px] active:shadow-none disabled:opacity-60"
        >
          {submitting ? copy.submitting : copy.submit}
        </button>
      </form>
    </div>
  )
}
