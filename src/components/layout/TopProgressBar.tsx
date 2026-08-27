import { useProgress } from '@/services/progress'

/**
 * 页面顶部的加载细条（YouTube 那种）。
 *
 * 位置：fixed 在视口最顶上，盖住 Topbar 的头 3px —— 和 YouTube 一样贴着浏览器地址栏下沿。
 * 想改成贴在窗口底部的话，把下面的 top-0 换成 bottom-0 就行。
 *
 * 用 width 而不是 transform: scaleX：条上带发光阴影，scaleX 会把阴影一起横向拉扁，
 * 看起来像糊了。就一个 3px 的元素、每秒几次更新，width 的开销可以忽略。
 *
 * data-active：只有条露着的时候才给宽度加过渡。收尾归零那一下要是也走过渡，
 * 会看到条从满格往回缩 —— 归零必须瞬间完成（那时候已经透明了，看不见）。
 *
 * aria-hidden：它只是个视觉提示，页面本身已经有「正在加载」的文案给读屏软件，
 * 再报一遍这种估算出来的假进度只会更吵。
 */
export function TopProgressBar() {
  const { value, visible } = useProgress()

  return (
    <div aria-hidden="true" className="pointer-events-none fixed inset-x-0 top-0 z-[100] h-[3px]">
      <div
        className="progress-bar h-full rounded-r-full bg-brand"
        data-active={visible ? 'true' : 'false'}
        style={{
          width: `${(value * 100).toFixed(1)}%`,
          opacity: visible ? 1 : 0,
          boxShadow: '0 0 8px var(--color-brand), 0 0 2px var(--color-brand)',
        }}
      />
    </div>
  )
}
