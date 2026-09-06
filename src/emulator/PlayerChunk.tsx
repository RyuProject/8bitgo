/**
 * 懒加载的播放器。
 *
 * 为什么要懒：`EmulatorPlayer` 会静态引入 `runtimes.ts`，那是唯一把九个适配器
 * （EmulatorJS、js-dos、Ruffle、jsnes、J2ME、webretro、云联机、看直播）全部拉进来的地方。
 * 而详情页是静态路由，页面一进主包，整套引擎实现就跟着进主包 —— 于是**看博客、逛首页、
 * 翻房间列表的人也在下载模拟器**，尽管他们一局都不会开。
 *
 * 拆出来之后：解析「该用哪个引擎」仍然走轻的那条路（registry + runtimeMeta），
 * 引擎实现要到真的渲染播放器时才下载。
 *
 * 占位不用 PageSkeleton —— 播放器是嵌在页面里的一块，不是整页路由。
 * 这里用一块和播放器同比例的底，避免 chunk 到货时整页跳动。
 */
import { Suspense } from 'react'
import { lazyNamed } from '@/routes/lazy'
import type { ComponentProps } from 'react'
import type { EmulatorPlayer as EmulatorPlayerType } from './EmulatorPlayer'

const LazyPlayer = lazyNamed(() => import('./EmulatorPlayer'), 'EmulatorPlayer')

type PlayerProps = ComponentProps<typeof EmulatorPlayerType>

/** 播放器 chunk 还在下载时的占位：保持版位，别让内容在到货那一刻跳一下 */
function PlayerFallback({ fill }: { fill?: boolean }) {
  return (
    <div
      className={
        fill
          ? 'h-full w-full bg-black'
          : 'aspect-video w-full overflow-hidden rounded-xl bg-black/90 ring-1 ring-line'
      }
      aria-busy="true"
    />
  )
}

export function EmulatorPlayer(props: PlayerProps) {
  return (
    <Suspense fallback={<PlayerFallback fill={props.fill} />}>
      <LazyPlayer {...props} />
    </Suspense>
  )
}
