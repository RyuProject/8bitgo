import type { PlatformId } from '@/types'
import { isDualScreen } from './dualScreen'

/**
 * 各平台画面的原生宽高比，只在**移动端**用来决定播放器画面区的高度。
 *
 * 为什么需要它：桌面端播放器是一个 16:9 的框，工具栏是框里的最后一行 ——
 * 屏幕宽的时候 16:9 足够高，让出一行工具栏没什么感觉。手机上完全不成立：
 * 390pt 宽的屏幕，16:9 只有 200pt 高，工具栏一占就剩不到 80pt 给画面，
 * 红白机的游戏窗口小到几乎看不见（用户实测截图）。
 *
 * 所以移动端改成「画面自己占一个按原生比例的框，工具栏排在框下面」。
 * 比例按平台给，不再一律 16:9 —— 引擎无论如何都会在容器里保持自己的比例居中，
 * 容器比内容宽只是两侧多出黑边、画面大小不变；而容器比内容**矮**才是真的把画面压小。
 * 所以这里宁可给得偏高一点：4:3 的游戏放进 4:3 的框，比放进 16:9 的框高出三分之一。
 *
 * ⚠️ 值必须写成完整的 Tailwind 类名字面量。Tailwind 是扫源码文本生成 CSS 的，
 * 拼接出来的类名（`aspect-[${x}]`）不会被扫到，上线后是**没有这条 CSS** 的。
 */
const MOBILE_ASPECT: Partial<Record<PlatformId, string>> = {
  // 主机与街机基本都是 4:3（CRT 年代的显示比例，不是像素比例）
  nes: 'aspect-[4/3]',
  snes: 'aspect-[4/3]',
  n64: 'aspect-[4/3]',
  psx: 'aspect-[4/3]',
  segaMD: 'aspect-[4/3]',
  arcade: 'aspect-[4/3]',
  dos: 'aspect-[4/3]',
  // Flash 时代的网页游戏多数也是 4:3；真是宽屏的那些只会多出上下黑边，画面不缩小
  flash: 'aspect-[4/3]',
  // 掌机各有各的屏
  gb: 'aspect-[10/9]', // 160×144
  gbc: 'aspect-[10/9]',
  gba: 'aspect-[3/2]', // 240×160
  ws: 'aspect-[14/9]', // 224×144
  // 双屏上下叠着，是竖的 —— 给 16:9 的话上下两块屏会被压成两条。
  // 256×(192+192) = 256×384 = 2/3。以前写的 3/4 比原生**更矮**，
  // 恰好违反上面那条「宁可偏高不可偏矮」：画面被按高度缩掉约 11%，
  // 两侧多出黑边，本来就小的下屏触摸区更难点。
  nds: 'aspect-[2/3]',
  // J2ME 手机游戏，竖屏 240×320 居多
  java: 'aspect-[3/4]',
  // 现代网页游戏就是宽屏
  html5: 'aspect-video',
}

/**
 * 实测比例 → Tailwind 字面量的阶梯。**降序**，每一档的 min 就是那个类名的真实比例。
 *
 * 为什么 min 必须等于类名自己的比例、而不是一个稍小的整数：查表是**向下取**的
 * （见 aspectClass），取到的那一档必须不比内容更宽。差一点就反了 ——
 * 比方说给 aspect-video 配 min:1.7，内容比例 1.72 会落到 16:9（1.778）这一档，
 * 容器比内容宽，画面就按高度缩了。这正是这个文件开头那条「宁可偏高不可偏矮」
 * 想避免的事，只是这次错在取整方向上。
 *
 * ⚠️ 值必须是完整的类名字面量，理由同 MOBILE_ASPECT（Tailwind 扫源码文本）。
 */
const ASPECT_LADDER: readonly { readonly min: number; readonly cls: string }[] = [
  { min: 8 / 3, cls: 'aspect-[8/3]' },
  { min: 16 / 9, cls: 'aspect-video' },
  { min: 3 / 2, cls: 'aspect-[3/2]' },
  { min: 4 / 3, cls: 'aspect-[4/3]' },
  { min: 10 / 9, cls: 'aspect-[10/9]' },
  { min: 1, cls: 'aspect-square' },
  { min: 3 / 4, cls: 'aspect-[3/4]' },
  { min: 2 / 3, cls: 'aspect-[2/3]' },
  { min: 0, cls: 'aspect-[1/2]' },
]

/**
 * 把一个实测比例落到最近的、**不比它更宽**的那一档类名。
 *
 * 容器宽度是页面定的、高度由 aspect-ratio 算出来。所以：
 *   容器比内容窄（比例更小）→ 内容按宽度铺满，上下多黑边，**画面尺寸一点不损失**
 *   容器比内容宽（比例更大）→ 内容按高度缩，两侧黑边，**画面真的变小了**
 * 两种偏差不对称，所以一律向「更竖」的那一档取。
 */
export function aspectClass(ratio: number): string {
  const r = Number(ratio)
  if (!Number.isFinite(r) || r <= 0) return 'aspect-video'
  for (const step of ASPECT_LADDER) if (r >= step.min) return step.cls
  return 'aspect-video'
}

/**
 * 移动端画面区该用的 aspect 类名。认不出的平台按 16:9 处理 ——
 * 那是最保守的选择：只可能偏矮，不会把页面撑得离谱。
 *
 * `geometry` 是画布的**实测**尺寸（核心的 av_info 几何，见 adapters/emulatorjs.ts
 * 的 reportGeometry）。只有双屏机型才认它：那一类的画面比例会随玩家换布局在
 * 2:3（上下叠）、8:3（并排）、4:3（单屏）之间跳，查表给不出。
 *
 * 其余平台**故意继续查表**：MOBILE_ASPECT 里写的是 CRT 年代的**显示**比例
 * （红白机 4:3），而画布的像素尺寸是 256×224（10:9）—— 拿实测值去顶，
 * 会把所有主机平台的框悄悄改矮一档。NDS 两块屏都是方像素（每屏 256×192 = 4:3），
 * 实测和显示比例一致，才敢这么用。
 */
export function mobileScreenAspect(platform: PlatformId, geometry?: { width: number; height: number } | null): string {
  if (isDualScreen(platform) && geometry && geometry.width > 0 && geometry.height > 0) {
    return aspectClass(geometry.width / geometry.height)
  }
  return MOBILE_ASPECT[platform] ?? 'aspect-video'
}

/**
 * 桌面端播放器外框该用的 aspect 类名。**默认就是全站那个 16:9**，
 * 所以调用方直接用它顶掉写死的 `sm:aspect-video`，不要两个类名一起挂 ——
 * 同为 aspect-ratio 的两条规则谁赢取决于 Tailwind 生成的先后，那是碰运气。
 *
 * 桌面端跟移动端不是一回事：这个框的宽度是版面给的一整行，16:9 已经足够高，
 * 全站统一也让详情页的高度可预测。只有一种情况值得破例 —— 双屏机型选了
 * 上下叠：2:3 的画面在 16:9 的框里只能用到三分之一的宽度（960 的框里画面
 * 只有 360 宽）。放到 4:3 就是 480×720，线性大三分之一。
 *
 * 为什么**只放到 4:3、不按实测值一路给到 2:3**：那会是一个 960×1440 的播放器，
 * 一屏装不下，玩家得滚动着玩，比黑边糟得多。这里是刻意的取舍，不是漏了 ——
 * 想要满比例的人可以进全屏（全屏那条路不走这个函数）。
 */
export function desktopScreenAspect(platform: PlatformId, geometry?: { width: number; height: number } | null): string {
  if (!isDualScreen(platform) || !geometry || geometry.width <= 0 || geometry.height <= 0) return 'sm:aspect-video'
  const ratio = geometry.width / geometry.height
  // 比 16:9 还宽（并排布局 8:3）→ 16:9 里画面宽度已经铺满，再改只是白占页面高度
  if (ratio >= 16 / 9) return 'sm:aspect-video'
  if (ratio >= 3 / 2) return 'sm:aspect-[3/2]'
  return 'sm:aspect-[4/3]'
}
