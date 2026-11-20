/**
 * 播放器的懒加载壳。详情页只 import 这一个文件；EmulatorPlayer 本体独立分块，
 * 适配器再按选中的运行时动态加载 —— 见 project 记忆「模拟器不进主包」。
 */
import { Suspense, type ReactNode } from 'react'
import { lazyNamed } from '@/routes/lazy'
import type { ComponentProps } from 'react'
import type { EmulatorPlayer as EmulatorPlayerType } from './EmulatorPlayer'
import { useT } from '@/services/i18n'
import { allowsSpeculativePlayerPreload, type NetworkHint } from './preloadPolicy'
import { DETAIL_PAGE_STAGE_ASPECT, mobileScreenAspect, stageHeightCap } from './screenAspect'
import { cx } from '@/lib/format'
import type { PlatformId } from '@/types'

const loadPlayer = () => import('./EmulatorPlayer')
const LazyPlayer = lazyNamed(loadPlayer, 'EmulatorPlayer')

let preloaded = false
/**
 * 提前把播放器 chunk 拉下来（只下载、不挂载）。
 *
 * 详情页要先过一遍年龄门（GameAgeGuard 的 access 接口，no-store）才挂播放器，而 lazy() 是
 * 挂载那一刻才开始下载 —— 两件事本来互不相干，却被串成了一条：接口 300ms + chunk 几百 KB，
 * 玩家白等一段。详情页确认是内嵌游戏后调这个，chunk 和接口并行；等门放行时 LazyPlayer 拿到的是
 * 同一个模块 promise（ESM 模块缓存），Suspense 几乎不会再挂占位。
 * 失败不用管：真正挂载时 lazy() 会再试一次，那时才由它报错。
 */
export function preloadPlayer(): void {
  if (preloaded) return
  const connection = typeof navigator === 'undefined'
    ? undefined
    : (navigator as Navigator & { connection?: NetworkHint }).connection
  if (!allowsSpeculativePlayerPreload(connection)) return
  preloaded = true
  loadPlayer().catch(() => {
    preloaded = false
  })
}

type PlayerProps = ComponentProps<typeof EmulatorPlayerType>

/**
 * 详情页（新版设计稿）播放器到货之前的占位：和播放器空闲态**同尺寸、同底图**。
 *
 * 详情页首屏依次会出现三帧：年龄门「确认中」→ 播放器分块下载中 → 播放器空闲态。SSR 首屏画的就是第一帧。
 * 三帧必须是同一个版位，否则每换一帧下面的标题和资料就跳一下（CLS），首屏也会先是一块和设计稿不一样的黑板：
 *   · 桌面 2:1 + 同一条高度上限，手机按平台原生比例（和播放器舞台用同一张表）；
 *   · 同样的模糊封面 + 黑色渐变，中间同一张小封面和标题，只把开始按钮换成转圈；
 *   · 下面那条弹幕栏占位和真实弹幕栏（LiveChatBar variant="page"）等高。
 *
 * 导出给 GameDetailPage 的年龄门「确认中」那一帧复用；成人游戏那边不要传 stagePoster（核实前不露清晰封面）。
 */
export function DetailStagePlaceholder({
  backdrop,
  displayTitle,
  stagePoster,
  platformId,
  label,
}: {
  backdrop?: ReactNode
  displayTitle?: string
  stagePoster?: ReactNode
  platformId?: PlatformId
  label: string
}) {
  return (
    <div aria-busy="true">
      <div className="overflow-hidden rounded-t-2xl border border-line bg-black">
        <div
          className={cx(
            'relative w-full overflow-hidden bg-black',
            platformId ? mobileScreenAspect(platformId) : 'aspect-video',
            DETAIL_PAGE_STAGE_ASPECT,
            stageHeightCap(false),
          )}
        >
          {backdrop && <div className="absolute inset-0 opacity-60 blur-sm">{backdrop}</div>}
          <div className="scanlines absolute inset-0" aria-hidden />
          <div className="absolute inset-0 bg-gradient-to-t from-black via-black/60 to-black/20" />
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-4 px-6 text-center lg:gap-6">
            {(stagePoster || displayTitle) && (
              <div className="flex max-w-full flex-col items-center gap-3 lg:gap-4">
                {stagePoster && (
                  <div aria-hidden className="size-[72px] overflow-hidden rounded-[7px] drop-shadow-[0_4px_3.35px_rgba(0,0,0,0.1)] max-sm:hidden lg:size-[111px]">
                    {stagePoster}
                  </div>
                )}
                {displayTitle && (
                  <p className="max-w-full truncate text-xl font-extrabold leading-tight tracking-[-0.35px] text-[#f2f4f8] lg:text-[30px] lg:leading-9">
                    {displayTitle}
                  </p>
                )}
              </div>
            )}
            <div role="status" aria-live="polite" className="flex flex-col items-center gap-3 text-center">
              <span className="h-8 w-8 animate-spin rounded-full border-2 border-white/25 border-t-brand" aria-hidden />
              <span className="text-xs font-medium tracking-wide text-white/70">{label}</span>
            </div>
          </div>
        </div>
      </div>
      {/* 弹幕栏占位：和 LiveChatBar variant="page" 一样高（py-2 + 40px 输入框 + 底边框） */}
      <div className="h-[57px] rounded-b-2xl border border-t-0 border-[#dce3e8] bg-[#fcfcfc]" aria-hidden />
    </div>
  )
}

/**
 * 播放器 chunk 还在下载时的占位：保持版位，别让内容在到货那一刻跳一下。
 *
 * 外框和 EmulatorPlayer 的外框、年龄门「正在确认」那一帧完全一样（rounded-2xl / border / bg-black /
 * 压暗的封面）—— 这三段是连着出现的，框一变形玩家就觉得页面在抽。以前这里是一块纯黑：
 * 门刚放行、chunk 没到的那几百毫秒里封面消失、变成黑板，看着像播放器坏了。
 */
function PlayerFallback({
  fill,
  backdrop,
  pagePresentation,
  displayTitle,
  stagePoster,
  platformId,
}: {
  fill?: boolean
  backdrop?: ReactNode
  pagePresentation?: boolean
  displayTitle?: string
  stagePoster?: ReactNode
  platformId?: PlatformId
}) {
  const t = useT()
  const status = (
    <div role="status" aria-live="polite" className="flex flex-col items-center gap-3 text-center">
      <span className="h-8 w-8 animate-spin rounded-full border-2 border-white/25 border-t-brand" aria-hidden />
      <span className="text-xs font-medium tracking-wide text-white/70">{t.player.statusLoading}</span>
    </div>
  )
  if (fill) {
    return (
      <div className="flex h-full w-full items-center justify-center bg-black" aria-busy="true">
        {status}
      </div>
    )
  }
  if (pagePresentation) {
    return (
      <DetailStagePlaceholder
        backdrop={backdrop}
        displayTitle={displayTitle}
        stagePoster={stagePoster}
        platformId={platformId}
        label={t.player.statusLoading}
      />
    )
  }
  return (
    <div className="overflow-hidden rounded-2xl border border-line bg-black" aria-busy="true">
      <div className="relative aspect-video w-full overflow-hidden bg-black">
        {backdrop && <div className="absolute inset-0 opacity-25 blur-sm">{backdrop}</div>}
        <div className="absolute inset-0 bg-black/80" />
        <div className="absolute inset-0 flex items-center justify-center">{status}</div>
      </div>
    </div>
  )
}

export function EmulatorPlayer(props: PlayerProps) {
  return (
    <Suspense
      fallback={
        <PlayerFallback
          fill={props.fill}
          backdrop={props.backdrop}
          pagePresentation={props.pagePresentation}
          displayTitle={props.displayTitle}
          stagePoster={props.stagePoster}
          platformId={props.platform?.id}
        />
      }
    >
      <LazyPlayer {...props} />
    </Suspense>
  )
}
