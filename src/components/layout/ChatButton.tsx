import { useEffect, useRef, useState } from 'react'
import { cx } from '@/lib/format'
import { useT } from '@/services/i18n'
import { getImUnread, imReady, imUnreadLabel, onImChange, openIm } from '@/services/im'

/**
 * 顶栏的聊天气泡按钮。**IM 的入口，也是它唯一的落点。**
 *
 * 它替掉了原来那块「头像 + 昵称 + 下拉」的用户菜单。那块能安全拿掉是因为身份和入口
 * 侧边栏底部已经有一份（头像 + 昵称 + G 币 → /me），退出登录在 /me 页面里也有 ——
 * 顶栏那份一直是重复的。
 *
 * 这个组件**对 IM 一无所知**：不认 socket、不认协议、不认消息结构，只跟
 * services/im.ts 打交道。真接 IM 时在那边 registerImOpener + setImUnread，这里不用动。
 *
 * 没接上的时候点它会展开一个「即将上线」的占位面板 —— 刻意不做成禁用按钮：
 * 灰掉的按钮看着像坏了，而一颗点了完全没反应的按钮比没有更糟。
 */
export function ChatButton() {
  const t = useT()
  const [unread, setUnread] = useState(() => getImUnread())
  /** 占位面板开着没有。IM 真接上之后这个 state 就用不到了（那时走 openIm） */
  const [placeholder, setPlaceholder] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => onImChange(() => setUnread(getImUnread())), [])

  // 点外面收起。和原来那个用户菜单同一套写法
  useEffect(() => {
    if (!placeholder) return
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setPlaceholder(false)
    }
    document.addEventListener('mousedown', onDoc)
    return () => document.removeEventListener('mousedown', onDoc)
  }, [placeholder])

  const badge = imUnreadLabel(unread)
  const label = badge ? `${t.topbar.chat} · ${badge}` : t.topbar.chat

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => {
          // IM 接上了就交给它；没接上才退回占位面板
          if (openIm()) return
          setPlaceholder((v) => !v)
        }}
        title={label}
        aria-label={label}
        aria-haspopup={imReady() ? undefined : 'dialog'}
        aria-expanded={placeholder || undefined}
        className={cx(
          'relative grid h-9 w-9 place-items-center rounded-lg border border-line bg-surface transition hover:border-brand/60 hover:text-brand',
          placeholder && 'border-brand/60 text-brand',
        )}
      >
        {/* 气泡。用 SVG 而不是 emoji：emoji 在各系统上大小和基线差得多，这是个 36px 的方钮，差一点就歪了 */}
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z" />
        </svg>

        {/*
          未读红点。压在按钮右上角，pointer-events-none —— 它不该把点击从按钮身上抢走。
          aria 那边不用它：数字已经在按钮的 aria-label 里了，读屏读两遍反而啰嗦。
        */}
        {badge && (
          <span
            aria-hidden
            className="pointer-events-none absolute -right-1 -top-1 grid h-4 min-w-4 place-items-center rounded-full bg-live px-1 text-[10px] font-bold leading-none text-white"
          >
            {badge}
          </span>
        )}
      </button>

      {placeholder && (
        <div
          role="dialog"
          aria-label={t.topbar.chat}
          className="absolute right-0 top-full z-50 mt-2 w-56 rounded-xl border border-line bg-surface p-3 shadow-2xl shadow-black/60"
        >
          <p className="text-sm font-semibold">{t.topbar.chat}</p>
          <p className="mt-1 text-xs leading-relaxed text-muted">{t.topbar.chatSoon}</p>
        </div>
      )}
    </div>
  )
}
