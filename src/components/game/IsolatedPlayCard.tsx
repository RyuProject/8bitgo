/**
 * 详情页上「这款游戏要整页打开」的入口卡片。
 *
 * 用在仍需单独跨源隔离页（SharedArrayBuffer）的 WebAssembly 大作上。隔离头必须发在
 * **顶层文档**上；PSP 已经让正常详情页成为隔离文档，因此不会再经过这张卡，
 * PS2 / Dolphin 暂时仍保留独立页。完整理由见 shared/isolated-embeds.js。
 *
 * 所以这里只画一个和播放器同尺寸（16:9）的卡片，点了整页跳到 /play/<slug> ——
 * 人还在站内，只是换了一页。
 *
 * ⚠️ 必须用 <a> 而不是 react-router 的 <Link>：浏览器要重新请求顶层文档，Express 才能
 * 给这条响应加 COOP / COEP。SPA 内部跳转不会换响应头，SharedArrayBuffer 仍然不可用。
 */
import { buttonClasses } from '@/components/ui/Button'
import { langPrefix } from '@/config/languages'
import { useLang } from '@/services/lang'
import { useT } from '@/services/i18n'
import { cx } from '@/lib/format'
import type { ReactNode } from 'react'
import type { IsolatedRuntimePlatformId } from '../../../shared/isolated-runtime-platforms.js'
import { newStartupId, recordStartupEvent } from '@/services/startupFunnel'

interface Props {
  slug: string
  gameName: string
  /** 仍使用独立页的 pthread 模拟器走自己的隔离路由；其余条目走 isolated-embeds 登记的外壳。 */
  isolatedPlatform?: IsolatedRuntimePlatformId
  /** 空闲态的大图标，和 EmulatorPlayer 的 icon 一个意思 */
  icon?: string
  /** 背景（通常是封面），和播放器空闲态保持一致的观感 */
  backdrop?: ReactNode
  className?: string
  /**
   * 加在**内层那个 16:9 元素**上（不是外框）。详情页拿它传高度上限 ——
   * 这张卡是播放器的替身，两者得一样高，否则同一款游戏「能内嵌 / 只能跳整页」
   * 两种情形下版面高度不一样。外框是 overflow-hidden，上限挂那儿会把内层裁掉。
   * 见 emulator/screenAspect.ts 的 stageHeightCap。
   */
  frameClassName?: string
  /** 详情页启动漏斗要跨一次整页导航，短 id 随 URL 带进隔离播放器，不写 cookie。 */
  startupVisitId?: string
}

export function IsolatedPlayCard({ slug, gameName, isolatedPlatform, icon, backdrop, className, frameClassName, startupVisitId }: Props) {
  const lang = useLang()
  const t = useT()
  // 语言前缀由 basename 承载，而这是一条整页跳转，得自己拼上，否则英文用户会掉到中文页
  const href = `${langPrefix(lang)}/play/${isolatedPlatform ? `${isolatedPlatform}/` : ''}${encodeURIComponent(slug)}`

  return (
    <div className={cx('overflow-hidden rounded-2xl border border-line bg-black', className)}>
      {/* frameClassName 落在这一层（带 aspect-video 的那个），不是外框 —— 见 screenAspect.ts 的 stageHeightCap */}
      <div className={cx('relative flex aspect-video w-full items-center justify-center', frameClassName)}>
        <div className="absolute inset-0 opacity-60 blur-sm">{backdrop}</div>
        <div className="scanlines absolute inset-0" aria-hidden />
        <div className="absolute inset-0 bg-gradient-to-t from-black via-black/60 to-black/20" />

        <div className="relative flex flex-col items-center gap-4 px-6 text-center">
          {icon && (
            <span className="hidden text-6xl drop-shadow-[0_8px_16px_rgba(0,0,0,0.6)] sm:block sm:text-7xl" aria-hidden>
              {icon}
            </span>
          )}
          {/* 按钮说「开始游戏」，和播放器那颗一致；游戏名在页面标题里已经有了 */}
          <a
            href={href}
            onClick={(event) => {
              if (!startupVisitId) return
              const attemptId = newStartupId()
              const startedAt = Date.now()
              const runtime = isolatedPlatform === 'psp' ? 'ppsspp' : isolatedPlatform === 'ps2' ? 'play' : isolatedPlatform ? 'dolphin' : 'html5'
              recordStartupEvent(slug, {
                visitId: startupVisitId,
                attemptId,
                event: 'start_click',
                runtime,
                platform: isolatedPlatform ?? '',
                elapsedMs: 0,
              })
              // 默认导航继续执行；只把短期漏斗 id 带到新页面，首帧/失败才能归回同一次点击。
              const url = new URL(event.currentTarget.href)
              url.searchParams.set('fv', startupVisitId)
              url.searchParams.set('fa', attemptId)
              url.searchParams.set('fs', String(startedAt))
              event.currentTarget.href = url.href
            }}
            className={buttonClasses('primary', 'lg')}
            aria-label={`${t.player.start} · ${gameName}`}
          >
            <span aria-hidden>▶</span> {t.player.start}
          </a>
          <p className="max-w-sm text-xs text-muted">{t.player.isolatedHint}</p>
        </div>
      </div>
    </div>
  )
}
