import { useEffect, useRef } from 'react'
import type { Game } from '@/types'
import { platformMap } from '@/data/platforms'
import { gradientFor } from '@/lib/gradients'
import { romUrlForKey } from '@/services/roms'
import { cx } from '@/lib/format'
import { useT, fmt } from '@/services/i18n'
import { useLang } from '@/services/lang'
import { gameTitle } from '@/services/i18nData'

interface Props {
  game: Game
  /** 宽高比：竖版 3/4，4:3 横版，16:9 宽屏，方形 1/1 */
  ratio?: 'portrait' | 'landscape' | 'wide' | 'square'
  className?: string
  /** 是否显示标题（用于没有真实封面的程序化封面） */
  showTitle?: boolean
  iconSize?: 'sm' | 'md' | 'lg'
  /** 是否显示左上角平台角标 */
  showBadge?: boolean
  /** 右下角有其他角标时，为标题预留空间 */
  reserveBottomRight?: boolean
  /**
   * 首屏可见（LCP 候选）。开了就 eager + 高优先级下载、视频也预取 metadata。
   * 只给真正一进页面就能看到的那几张，给多了等于没分优先级。
   */
  priority?: boolean
}

const ratios = {
  portrait: 'aspect-[3/4]',
  landscape: 'aspect-[4/3]',
  wide: 'aspect-video',
  square: 'aspect-square',
}

const iconSizes = {
  sm: 'text-4xl',
  md: 'text-5xl sm:text-6xl',
  lg: 'text-7xl sm:text-8xl',
}

/**
 * 封面视频：**滚到能看见就自动播**（静音、循环、行内），移出视口就暂停。
 *
 * 之前是「悬停才播」，但后台的说明写的是「有视频时卡片会自动播放（静音循环）」——
 * 说的和做的不一致，而且触屏设备根本没有悬停，等于永远看不到视频，
 * 卡片上只剩一块黑（preload="none" 不会拉任何一帧，没设封面图就没有 poster 可显示）。
 *
 * 之所以不直接写 autoPlay 而要用 IntersectionObserver：
 * 首页一屏能排十几张卡，全都 autoPlay 等于同时下载十几个视频、解码十几路画面，
 * 手机上会明显发烫掉帧。只播看得见的那几张，代价就回到可接受范围。
 *
 * 另外尊重「减少动态效果」的系统设置：开了就不自动播，仍然可以悬停播放。
 */
function CoverVideo({ src, poster, priority }: { src: string; poster?: string; priority?: boolean }) {
  const ref = useRef<HTMLVideoElement>(null)

  useEffect(() => {
    const v = ref.current
    if (!v) return

    /**
     * 循环播放的兜底。
     *
     * <video loop> 是靠「放到末尾就 seek 回 0」实现的 —— 我在 Chromium 里量过：
     * loop 生效时只有一串 seeked 事件，**ended 一次都不触发**。
     * 所以能走进这个回调，就说明浏览器自己那套循环已经失败、退回普通的结束流程了，
     * 表现就是停在最后一帧、看着像「只播了一次」。
     *
     * 什么时候会失败：seek 回不去的时候。响应不支持 Range、或者素材的时长信息
     * 不可靠（录屏和流式封装出来的 MP4 / WebM 常见）都算。后台的视频是直接传上来的
     * （accept="video/*"，中间没有转码这一步），什么封装都可能碰上。
     *
     * 兜底代价接近于零：loop 正常时这段代码永远不会执行。
     */
    const onEnded = () => {
      try {
        v.currentTime = 0
      } catch {
        /* seekable 为空时设 currentTime 会抛，交给下面的 load() */
      }
      // seek 没生效（不可 seek 的流会静默忽略）就整段重新加载。
      // load() 走 HTTP 缓存，通常不会真的再下一遍，代价只是 poster 闪一下
      if (v.currentTime > 0.05) v.load()
      void v.play().catch(() => {})
    }
    v.addEventListener('ended', onEnded)

    const reduced =
      typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches
    // 不自动播，但悬停播放和上面的循环兜底照常 —— 是玩家自己把鼠标放上去的
    if (reduced) return () => v.removeEventListener('ended', onEnded)

    // 不支持 IntersectionObserver 的老浏览器：退回悬停播放，不做自动播
    if (typeof IntersectionObserver !== 'function') return () => v.removeEventListener('ended', onEnded)

    const io = new IntersectionObserver(
      ([entry]) => {
        if (!entry) return
        if (entry.isIntersecting) {
          // 到这一步才允许加载：在视口外时 preload="none"，不占带宽
          if (v.preload === 'none') v.preload = 'auto'
          // 播完停在末尾的那种：play() 会自动从头开始（规范就是这么定的），
          // 所以滚出去再滚回来也能自愈
          void v.play().catch(() => {
            /* 自动播放被拦（比如省电模式）就算了，悬停仍然能播 */
          })
        } else {
          v.pause()
        }
      },
      // 一半以上露出来才播，免得横向轮播里边缘那张一闪一闪
      { threshold: 0.5 },
    )
    io.observe(v)
    return () => {
      v.removeEventListener('ended', onEnded)
      io.disconnect()
    }
  }, [src])

  return (
    <video
      ref={ref}
      src={src}
      poster={poster}
      muted
      loop
      playsInline
      // muted + playsInline 是浏览器允许自动播放的前提，缺一个都会被拦
      preload={priority ? 'metadata' : 'none'}
      className="absolute inset-0 h-full w-full object-cover transition duration-500 group-hover:scale-105"
      // 悬停仍然生效：自动播被系统设置或省电模式拦下时，这是兜底
      onMouseEnter={() => void ref.current?.play().catch(() => {})}
    />
  )
}

/**
 * 游戏封面。优先级：视频 > 封面图 > 程序化渐变 + emoji。
 * 媒体（图片 / 视频）以 object-cover 填满封面框，保持封面框现有高度与比例（4:3 横版素材最佳）。
 * cover / video 可以是对象存储 key（自动拼成公开地址）或完整 URL。
 */
export function GameCover({
  game,
  ratio = 'portrait',
  className,
  showTitle = true,
  iconSize = 'md',
  showBadge = true,
  reserveBottomRight = false,
  priority = false,
}: Props) {
  const t = useT()
  const lang = useLang()
  // 封面上的字、alt、aria-label 都得跟界面同一种语言
  const title = gameTitle(game, lang)
  const platform = platformMap[game.platform]
  const coverSrc = game.cover ? romUrlForKey(game.cover) : ''
  const videoSrc = game.video ? romUrlForKey(game.video) : ''

  return (
    <div
      className={cx('relative overflow-hidden', ratios[ratio], className)}
      // 视频加载出来之前这层背景就是玩家看到的东西。
      // 有封面图时用黑色（图片自己会铺满）；只有视频没有封面图时用程序化渐变，
      // 否则 preload="none" 的卡片在播起来之前就是一块纯黑。
      style={{ background: coverSrc ? '#000' : gradientFor(game.slug) }}
      role="img"
      aria-label={fmt(t.common.coverAlt, { title })}
    >
      {/* 背景层：视频 / 封面图 / 程序化封面 */}
      {videoSrc ? (
        <CoverVideo src={videoSrc} poster={coverSrc || undefined} priority={priority} />
      ) : coverSrc ? (
        <img
          src={coverSrc}
          alt={title}
          // 首屏那几张必须 eager：对着 LCP 图片加 loading="lazy"，
          // 等于让浏览器先跳过它、发现完别的资源再回头下，LCP 反而更慢
          loading={priority ? 'eager' : 'lazy'}
          fetchPriority={priority ? 'high' : 'auto'}
          decoding="async"
          className="absolute inset-0 h-full w-full object-cover transition duration-500 group-hover:scale-105"
        />
      ) : (
        <>
          <div className="pixel-grid absolute inset-0 opacity-70" aria-hidden />
          <div className="absolute inset-0 bg-[radial-gradient(circle_at_30%_20%,rgba(255,255,255,0.35),transparent_55%)]" aria-hidden />
          <div
            className={cx(
              'absolute inset-0 flex items-center justify-center drop-shadow-[0_6px_12px_rgba(0,0,0,0.45)] transition duration-500 group-hover:scale-110',
              iconSizes[iconSize],
              showTitle && ratio === 'portrait' && '-translate-y-3',
            )}
            aria-hidden
          >
            {game.icon}
          </div>
        </>
      )}

      {/* 标题遮罩 */}
      {showTitle && (
        <div
          className={cx(
            'absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/85 via-black/50 to-transparent px-3 pb-2.5 pt-8',
            reserveBottomRight && 'pr-14',
          )}
        >
          <p className="line-clamp-2 text-[13px] font-bold leading-tight text-white drop-shadow">{title}</p>
        </div>
      )}

      {/* 平台角标 */}
      {showBadge && (
        <span
          className="text-pixel absolute left-2 top-2 rounded bg-black/55 px-1.5 py-1 text-[10px] text-white backdrop-blur"
          style={{ borderLeft: `3px solid ${platform.color}` }}
        >
          {platform.shortName}
        </span>
      )}
    </div>
  )
}
