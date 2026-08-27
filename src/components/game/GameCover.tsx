import { useRef } from 'react'
import type { Game } from '@/types'
import { platformMap } from '@/data/platforms'
import { gradientFor } from '@/lib/gradients'
import { romUrlForKey } from '@/services/roms'
import { cx } from '@/lib/format'
import { useT, fmt } from '@/services/i18n'

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

/** 悬停时播放的封面视频（静音、循环、行内）。移动端无悬停时显示 poster / 首帧。 */
function CoverVideo({ src, poster, priority }: { src: string; poster?: string; priority?: boolean }) {
  const ref = useRef<HTMLVideoElement>(null)
  return (
    <video
      ref={ref}
      src={src}
      poster={poster}
      muted
      loop
      playsInline
      // 列表里的封面视频只在鼠标移上去才播，提前拉 metadata 等于每张卡都白下一段。
      // 首屏那几张（priority）才值得先拿 metadata，换第一次悬停不卡。
      preload={priority ? 'metadata' : 'none'}
      className="absolute inset-0 h-full w-full object-cover transition duration-500 group-hover:scale-105"
      onMouseEnter={() => void ref.current?.play().catch(() => {})}
      onMouseLeave={() => {
        const v = ref.current
        if (v) {
          v.pause()
          v.currentTime = 0
        }
      }}
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
  const platform = platformMap[game.platform]
  const coverSrc = game.cover ? romUrlForKey(game.cover) : ''
  const videoSrc = game.video ? romUrlForKey(game.video) : ''
  const hasMedia = Boolean(videoSrc || coverSrc)

  return (
    <div
      className={cx('relative overflow-hidden', ratios[ratio], className)}
      style={hasMedia ? { background: '#000' } : { background: gradientFor(game.slug) }}
      role="img"
      aria-label={fmt(t.common.coverAlt, { title: game.title })}
    >
      {/* 背景层：视频 / 封面图 / 程序化封面 */}
      {videoSrc ? (
        <CoverVideo src={videoSrc} poster={coverSrc || undefined} priority={priority} />
      ) : coverSrc ? (
        <img
          src={coverSrc}
          alt={game.title}
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
          <p className="line-clamp-2 text-[13px] font-bold leading-tight text-white drop-shadow">{game.title}</p>
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
