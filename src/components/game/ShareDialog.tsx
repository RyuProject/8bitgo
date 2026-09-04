/**
 * 分享面板：复制链接 + 复制可以贴到别处的 iframe 嵌入代码。
 *
 * ── 为什么从「一个按钮」变成「一个面板」──────────────────────
 * 嵌入这件事有几句话必须说出来，而一个按钮没有地方说：
 *   · 跨站 iframe 的存储被浏览器分区，Safari 直接屏蔽第三方存储 ——
 *     嵌入的这一局**存不了档**、也带不进登录态和 G 币。
 *   · 需要 SharedArrayBuffer 的那批游戏（shared/isolated-embeds.js）在别人的页面里
 *     永远拿不到隔离，只能给跳转入口。
 * 不说这两句，玩家会以为是站点坏了；说了，他们才知道该贴哪种。
 *
 * ── 为什么代码写得这么"老"─────────────────────────────────────
 * 目标是 BBS（Discuz!、phpBB 这类）。那边的富文本过滤器**几乎一定会剥掉 style 属性**，
 * 所以不能用 `style="aspect-ratio:16/9"` 那套响应式包裹 —— 剥完就是一个 0 高度的
 * 空框。宽高走 HTML 属性、边框用 `frameborder="0"`（HTML5 里已废弃，但所有浏览器
 * 都还认，而且它能活着穿过过滤器），这是这里唯一能稳的写法。
 * 尺寸给几个 4:3 预设：多数复古平台是 4:3，播放器自己会给宽屏内容加黑边。
 */
import { useEffect, useState } from 'react'
import { Button } from '@/components/ui/Button'
import { useT, fmt } from '@/services/i18n'
import { langPrefix } from '@/config/languages'
import { useLang } from '@/services/lang'

const SIZES = [
  { w: 640, h: 480 },
  { w: 800, h: 600 },
  { w: 960, h: 720 },
] as const

/** 这段字符串是要当 HTML 贴出去的，游戏名里的引号和尖括号必须转义 */
function escapeAttr(s: string) {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

const inputClass =
  'w-full rounded-xl border border-line bg-surface-2 px-3 py-2 font-mono text-[11px] leading-5 text-fg'

export function ShareDialog({
  open,
  onClose,
  slug,
  title,
  isolated,
}: {
  open: boolean
  onClose: () => void
  slug: string
  title: string
  /** 需要跨源隔离才跑得起来的游戏：不给嵌入代码，只给链接 */
  isolated: boolean
}) {
  const t = useT()
  const lang = useLang()
  const [size, setSize] = useState(0)
  const [copied, setCopied] = useState<'link' | 'code' | null>(null)

  useEffect(() => {
    if (!open) return
    setCopied(null)
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => {
      document.body.style.overflow = prev
      window.removeEventListener('keydown', onKey)
    }
  }, [open, onClose])

  if (!open) return null

  // 嵌入代码给的是**当前访问的这个 origin**：站长在预发环境上复制，拿到的就是预发地址，
  // 这比硬写线上域名更符合直觉，也省掉一个「为什么代码指向了别的站」的问题。
  const origin = typeof window === 'undefined' ? '' : window.location.origin
  const pageUrl = `${origin}${langPrefix(lang)}/games/${encodeURIComponent(slug)}`
  const embedUrl = `${origin}${langPrefix(lang)}/embed/${encodeURIComponent(slug)}`
  const { w, h } = SIZES[size]
  const code =
    `<iframe src="${embedUrl}" width="${w}" height="${h}" frameborder="0"` +
    ` title="${escapeAttr(title)}" allowfullscreen` +
    ` allow="fullscreen; autoplay; gamepad"></iframe>`

  const copy = async (text: string, which: 'link' | 'code') => {
    try {
      await navigator.clipboard.writeText(text)
      setCopied(which)
    } catch {
      /* 剪贴板不可用时忽略 —— 文本框本身可以手选复制 */
    }
  }

  return (
    <div
      className="fixed inset-0 z-[80] flex items-center justify-center overflow-y-auto bg-black/50 p-4 backdrop-blur-sm"
      onMouseDown={onClose}
      role="dialog"
      aria-modal="true"
      aria-labelledby="share-dialog-title"
    >
      <div
        className="relative my-auto w-full max-w-xl rounded-2xl border border-line bg-surface p-6 shadow-2xl sm:p-7"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <button
          type="button"
          onClick={onClose}
          aria-label={t.common.close}
          className="absolute right-4 top-4 grid h-9 w-9 place-items-center rounded-full text-muted transition hover:bg-black/5 hover:text-fg"
        >
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" aria-hidden>
            <path d="M6 6l12 12M18 6L6 18" />
          </svg>
        </button>

        <h2 id="share-dialog-title" className="text-xl font-extrabold text-fg">
          {t.share.title}
        </h2>

        {/* 链接 */}
        <div className="mt-5">
          <label className="text-xs font-semibold text-muted" htmlFor="share-link">
            {t.share.linkLabel}
          </label>
          <div className="mt-1.5 flex gap-2">
            <input id="share-link" readOnly value={pageUrl} onFocus={(e) => e.currentTarget.select()} className={inputClass} />
            <Button variant="secondary" size="sm" className="flex-none" onClick={() => void copy(pageUrl, 'link')}>
              {copied === 'link' ? t.share.copied : t.share.copy}
            </Button>
          </div>
        </div>

        {/* 嵌入代码 */}
        <div className="mt-6 border-t border-line pt-5">
          <p className="text-sm font-extrabold text-fg">{t.share.embedTitle}</p>
          <p className="mt-1 text-xs leading-6 text-muted">{t.share.embedDesc}</p>

          {isolated ? (
            <p className="mt-3 rounded-xl border border-line bg-surface-2 px-3 py-2.5 text-xs leading-6 text-muted">
              {t.share.embedIsolated}
            </p>
          ) : (
            <>
              <div className="mt-3 flex flex-wrap gap-1.5">
                {SIZES.map((s, i) => (
                  <button
                    key={`${s.w}x${s.h}`}
                    type="button"
                    onClick={() => setSize(i)}
                    aria-pressed={i === size}
                    className={
                      i === size
                        ? 'rounded-lg border-2 border-brand bg-brand-soft px-2.5 py-1 text-xs font-bold text-fg'
                        : 'rounded-lg border border-line px-2.5 py-1 text-xs text-muted transition hover:border-brand hover:text-fg'
                    }
                  >
                    {s.w}×{s.h}
                  </button>
                ))}
              </div>
              <textarea
                readOnly
                value={code}
                rows={3}
                onFocus={(e) => e.currentTarget.select()}
                className={`mt-2 resize-none ${inputClass}`}
                aria-label={t.share.embedTitle}
              />
              <div className="mt-2 flex flex-wrap items-center gap-2">
                <Button variant="primary" size="sm" onClick={() => void copy(code, 'code')}>
                  {copied === 'code' ? t.share.copied : t.share.copyCode}
                </Button>
                <a
                  href={embedUrl}
                  target="_blank"
                  rel="noopener"
                  className="text-xs text-muted underline underline-offset-2 transition hover:text-fg"
                >
                  {t.share.previewEmbed}
                </a>
              </div>
              <p className="mt-3 text-[11px] leading-6 text-dim">{fmt(t.share.embedLimits, { site: '8BitGo' })}</p>
            </>
          )}
        </div>
      </div>
    </div>
  )
}
