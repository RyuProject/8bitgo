import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { cx } from '@/lib/format'
import { useT } from '@/services/i18n'
import { getImUnread, imReady, imUnreadLabel, onImChange, onImPreview, openIm, type ImPreview } from '@/services/im'

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
/** 走马灯速度（px/秒）。比这快读不完，比这慢像卡住了 */
const MARQUEE_SPEED = 45
/** 开滚之前先停一下，让人读到开头 */
const MARQUEE_DELAY_MS = 900
/** 滚到尾巴之后再停一下，让人读完结尾 */
const MARQUEE_TAIL_MS = 1400
/** 不需要滚（短消息）时整条停留多久 */
const STATIC_HOLD_MS = 4000
/** 走马灯本身的时长上下限：太短像抽风，太长挡着顶栏不走 */
const MARQUEE_MIN_MS = 1200
const MARQUEE_MAX_MS = 8000
/** clip-path 收起动画的时长，要和 index.css 里 .im-preview 的 transition 对上 */
const COLLAPSE_MS = 360

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n))

export function ChatButton() {
  const t = useT()
  const [unread, setUnread] = useState(() => getImUnread())
  /**
   * 正在滚的那条新消息。null = 不画。
   *
   * **不做队列。**连着来五条时排队播会让顶栏被占住几十秒，而且最后一条
   * （最该看的那条）反而最晚出现。新的直接顶掉旧的，这才是通知该有的行为。
   */
  const [preview, setPreview] = useState<ImPreview | null>(null)
  /** 展开状态。和 preview 分开，是因为 clip-path 过渡需要先有一帧「收起」才跑得起来 */
  const [shown, setShown] = useState(false)
  /** overflow-hidden 的那一层，量可视宽度用 */
  const clipRef = useRef<HTMLSpanElement>(null)
  /** 真正被 transform 推走的那一层，量内容宽度用 */
  const trackRef = useRef<HTMLSpanElement>(null)
  /** 占位面板开着没有。IM 真接上之后这个 state 就用不到了（那时走 openIm） */
  const [placeholder, setPlaceholder] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => onImChange(() => setUnread(getImUnread())), [])

  /*
    新消息来了就换内容、并且**先回到收起状态** —— 下一个 layout effect 里再展开，
    这样 clip-path 才有起始帧可插值（直接渲染成展开态是不会有过渡的）。
  */
  useEffect(() => onImPreview((p) => {
    setPreview(p)
    setShown(false)
  }), [])

  /**
   * 量溢出、算时长、排收起。
   *
   * 用 useLayoutEffect 而不是 useEffect：要在浏览器绘制**之前**把 --im-span /
   * --im-dur 写进去。晚一帧的话动画会先按默认值（span 0）跑起来，看到的是文字
   * 先不动、然后突然开始滚。
   *
   * 依赖是 preview（整个对象）—— 它带着递增的 seq，所以同样文字的第二条消息
   * 也会让这一段重跑。
   */
  useLayoutEffect(() => {
    if (!preview) return
    const clip = clipRef.current
    const track = trackRef.current
    if (!clip || !track) return

    /*
      减弱动态效果时不滚。**是不动，不是减速** —— 滚动文字对前庭敏感的人是明确的
      触发源。读不全的部分抽屉里有，而且停留时间给长一点。
      CSS 那边也关了一道（@media prefers-reduced-motion），这里关的是**时长计算**：
      不然会按一个根本不会跑的动画去排收起时间，整条在顶栏上多待好几秒。
    */
    const reduced =
      typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches

    // 4px 容差：亚像素误差会让一条刚好放得下的消息也被判成要滚
    const span = Math.max(0, track.scrollWidth - clip.clientWidth)
    let total = reduced ? STATIC_HOLD_MS + MARQUEE_TAIL_MS : STATIC_HOLD_MS

    if (span > 4 && !reduced) {
      const dur = clamp((span / MARQUEE_SPEED) * 1000, MARQUEE_MIN_MS, MARQUEE_MAX_MS)
      track.style.setProperty('--im-span', `${span}px`)
      track.style.setProperty('--im-dur', `${dur}ms`)
      track.style.setProperty('--im-delay', `${MARQUEE_DELAY_MS}ms`)
      // 顺序要紧：变量先写，动画类后加。反过来动画会以默认值 span 0 起跑（见 JSX 那条注释）
      track.classList.add('im-marquee')
      total = MARQUEE_DELAY_MS + dur + MARQUEE_TAIL_MS
    }

    // 展开：等一帧，让「收起」那一帧先落到屏幕上
    const raf = requestAnimationFrame(() => setShown(true))
    const hide = window.setTimeout(() => setShown(false), total)
    // 收完再卸内容，否则 clip-path 的收起动画会因为节点消失而看不到
    const drop = window.setTimeout(() => setPreview(null), total + COLLAPSE_MS)
    return () => {
      cancelAnimationFrame(raf)
      clearTimeout(hide)
      clearTimeout(drop)
    }
  }, [preview])

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
      {/*
        新消息预览条。

        ## 为什么是绝对定位，而不是真的把按钮撑长

        顶栏那一组是 `ml-auto flex`（右对齐），这颗按钮是里面**最后一个**。
        让它真的变宽，整组的左边界就会往左挪 —— 搜索、金币、「下载 App」
        每来一条消息全都横向抖一下，而用户可能正要点其中一个。
        绝对定位从气泡左侧展开，文档流里那颗按钮尺寸一动不动，**零重排**。

        代价是它会盖住左边那两三个控件几秒。这个代价是接受的：它自己会收，
        而且锚在它所说明的那颗按钮上 —— 通知类的浮层本来就是这么长的。

        ## pointer-events-none 是刻意的

        它不可点。一个会自己冒出来、又盖在「下载 App」上面的可点区域，
        等于给用户造了一个误点陷阱：手已经往那儿去了，浮层忽然出现接走了这一下。
        真要进聊天，右边那颗气泡一直在原地。

        ## aria-hidden 也是刻意的

        未读数已经在按钮的 aria-label 里（「消息 · 3」），读屏用户拿到的信息
        和这个功能上线之前一致。把私信正文自动念出来，在有人旁听时反而是泄露。
      */}
      {preview && (
        <div
          aria-hidden
          data-open={shown}
          className={cx(
            'im-preview pointer-events-none absolute right-0 top-0 z-0 flex h-9 w-max items-center',
            // pr-11 = 气泡(36px) + 一点余量，保证文字永远不会压在气泡底下
            'max-w-[min(72vw,24rem)] rounded-lg border border-line bg-surface pl-3 pr-11 shadow-lg shadow-black/20',
          )}
        >
          {/* min-w-0 + overflow-hidden 两个都要：flex 项默认 min-width:auto 会把
              用过的宽度抬回内容宽度，overflow 不是 visible 时那个自动最小尺寸才归零 */}
          <span ref={clipRef} className="im-preview-clip min-w-0 flex-1 overflow-hidden">
            {/*
              key 用 seq。连着两条一样的「哈喽」时 nick 和 text 都没变，
              React 会复用节点、CSS 动画不会重播 —— 用户看不出有新消息。
              seq 变了才会重挂，动画才会重头跑。
            */}
            <span
              key={preview.seq}
              ref={trackRef}
              /*
                ⚠️ 这里**故意不写 im-marquee**。动画类是在下面那个 layout effect 里
                量完、把 --im-span / --im-dur 设好之后才加上的。

                写在这儿的话，动画会在元素第一次算样式时就以默认值（span 0）起跑，
                然后才被改成真值 —— 实测（headless Chromium）那种情况下 transform
                一直停在 0，走马灯根本不动。先设变量再加类，不依赖「layout effect
                抢在首帧之前」这种时序假设。
              */
              className="block whitespace-nowrap text-xs leading-9"
            >
              {preview.nick && <span className="font-semibold text-brand">{preview.nick}</span>}
              {preview.nick && <span className="text-dim">：</span>}
              <span className="text-fg">{preview.text}</span>
            </span>
          </span>
        </div>
      )}

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
          // z-10：长条是绝对定位的，不抬一手会盖在按钮上面把点击吃掉
          'relative z-10 grid h-9 w-9 place-items-center rounded-lg border border-line bg-surface transition hover:border-brand/60 hover:text-brand',
          placeholder && 'border-brand/60 text-brand',
          // 有新消息滚着时把气泡也点亮，让人看出这两块是一体的
          preview && 'border-brand/60 text-brand',
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
