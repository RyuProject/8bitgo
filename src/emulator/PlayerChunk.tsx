/**
 * 播放器的懒加载壳。详情页只 import 这一个文件，EmulatorPlayer 本体（连同各引擎适配器）
 * 走独立 chunk —— 见 project 记忆「模拟器不进主包」。
 */
import { Suspense, type ReactNode } from 'react'
import { lazyNamed } from '@/routes/lazy'
import type { ComponentProps } from 'react'
import type { EmulatorPlayer as EmulatorPlayerType } from './EmulatorPlayer'

const loadPlayer = () => import('./EmulatorPlayer')
const LazyPlayer = lazyNamed(loadPlayer, 'EmulatorPlayer')

let preloaded = false
/**
 * 提前把播放器 chunk 拉下来（只下载、不挂载）。
 *
 * 详情页要先过一遍年龄门（GameAgeGuard 的 access 接口，no-store）才挂播放器，而 lazy() 是
 * 挂载那一刻才开始下载 —— 两件事本来互不相干，却被串成了一条：接口 300ms + chunk 几百 KB，
 * 玩家白等一段。详情页一进来就调这个，chunk 和接口并行；等门放行时 LazyPlayer 拿到的是
 * 同一个模块 promise（ESM 模块缓存），Suspense 几乎不会再挂占位。
 * 失败不用管：真正挂载时 lazy() 会再试一次，那时才由它报错。
 */
export function preloadPlayer(): void {
  if (preloaded) return
  preloaded = true
  loadPlayer().catch(() => {
    preloaded = false
  })
}

type PlayerProps = ComponentProps<typeof EmulatorPlayerType>

/**
 * 播放器 chunk 还在下载时的占位：保持版位，别让内容在到货那一刻跳一下。
 *
 * 外框和 EmulatorPlayer 的外框、年龄门「正在确认」那一帧完全一样（rounded-2xl / border / bg-black /
 * 压暗的封面）—— 这三段是连着出现的，框一变形玩家就觉得页面在抽。以前这里是一块纯黑：
 * 门刚放行、chunk 没到的那几百毫秒里封面消失、变成黑板，看着像播放器坏了。
 */
function PlayerFallback({ fill, backdrop }: { fill?: boolean; backdrop?: ReactNode }) {
  if (fill) return <div className="h-full w-full bg-black" aria-busy="true" />
  return (
    <div className="overflow-hidden rounded-2xl border border-line bg-black" aria-busy="true">
      <div className="relative aspect-video w-full overflow-hidden bg-black">
        {backdrop && <div className="absolute inset-0 opacity-25 blur-sm">{backdrop}</div>}
        <div className="absolute inset-0 bg-black/80" />
        <div className="absolute inset-0 flex items-center justify-center">
          <span className="h-8 w-8 animate-spin rounded-full border-2 border-white/25 border-t-brand" aria-hidden />
        </div>
      </div>
    </div>
  )
}

export function EmulatorPlayer(props: PlayerProps) {
  return (
    <Suspense fallback={<PlayerFallback fill={props.fill} backdrop={props.backdrop} />}>
      <LazyPlayer {...props} />
    </Suspense>
  )
}
