import type { PlatformId } from '@/types'

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
  // 双屏上下叠着，是竖的 —— 给 16:9 的话上下两块屏会被压成两条
  nds: 'aspect-[3/4]',
  // J2ME 手机游戏，竖屏 240×320 居多
  java: 'aspect-[3/4]',
  // 现代网页游戏就是宽屏
  html5: 'aspect-video',
}

/**
 * 移动端画面区该用的 aspect 类名。认不出的平台按 16:9 处理 ——
 * 那是最保守的选择：只可能偏矮，不会把页面撑得离谱。
 */
export function mobileScreenAspect(platform: PlatformId): string {
  return MOBILE_ASPECT[platform] ?? 'aspect-video'
}
