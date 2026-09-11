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

/* ---------------- 详情页 16:9 舞台的高度上限 ---------------- */

/**
 * 为什么是**限高**而不是限宽（2026-09-07 改，站长拿红线标了要对齐）。
 *
 * 原来的做法是给那个 16:9 的框设宽度上限（`max-w = (100dvh - 10rem) * 16/9`）再居中，
 * 为的是矮屏（1280×720 的笔记本）上 16:9 铺满宽度会比视口还高、玩家得滚着玩。
 * 代价是框的两侧缩进，**和底下的标题、资料区对不齐** —— 一眼看过去像没对齐。
 *
 * 换成限高之后：框铺满内容列宽度、边缘和内容列对齐；高度到顶就停，
 * 而引擎画布是 `object-fit: contain`，于是画面在框内左右留黑边。
 * **画面本身的尺寸一模一样**（受同一个高度约束），只是黑边从「框外的页面底色」
 * 变成「框内的黑」。矮屏那条约束一点没放松。
 *
 * ⚠️ **必须挂在真正带 aspect-ratio 的那个元素上**，不是它的外框。
 * 详情页里那三块都是「外框（overflow-hidden rounded-2xl）+ 内层 16:9」的结构 ——
 * 上限挂到外框上，内层照旧按 16:9 算高度、然后被 `overflow-hidden` 裁掉一截
 * （年龄门那种居中的内容会被推出视野）。所以：
 *   · 播放器      —— 挂在舞台上，而且**只挂在「普通」那一支**：全屏时舞台自己是
 *                    fullscreen 元素、游玩布局时是 `fixed inset-0`，
 *                    一个 max-h 会把这两种铺满视口的形态一起夹住。
 *   · 年龄门      —— 由 GameAgeGuard 的 className 传到它内层那个 16:9 上
 *   · 跨源入口卡  —— 由 IsolatedPlayCard 的 frameClassName 传到内层
 *
 * ⚠️ 两个值都必须是**完整的类名字面量**（理由同 MOBILE_ASPECT：Tailwind 扫源码文本）。
 * 沉浸模式那一档不带 `lg:` 前缀，沿用改动前的写法。
 *
 * 刻意**没有**做成「挂外框、用 `[&>*]:` 变体转给子元素」那种写法：少改两个组件，
 * 但换来一条只有构建之后才验得出来的花招 CSS，不值得。
 */
const CAP = {
  immersive: 'max-h-[calc(100dvh-7rem)]',
  normal: 'lg:max-h-[calc(100dvh-10rem)]',
} as const

export const stageHeightCap = (immersive: boolean): string => (immersive ? CAP.immersive : CAP.normal)

/**
 * 和 `CAP` 是**同一份数字**，给需要在 inline style 里做 `min()` 的地方用（见 liveStageStyle）。
 *
 * ⚠️ 只能写两遍：Tailwind 的类名必须是字面量（理由同 MOBILE_ASPECT），
 * 而 CSS 的 `calc()` 里减号两侧要有空格、Tailwind 的任意值里不能有空格 ——
 * 两种写法拼不成一个。`scripts/test-live-scale.mjs` 有一条断言把两边钉在一起，
 * 改了一处忘了另一处会红。
 */
export const STAGE_CAP_EXPR = {
  immersive: 'calc(100dvh - 7rem)',
  normal: 'calc(100dvh - 10rem)',
} as const

/* ---------------- 看直播时：画面最多放大到原生分辨率的几倍 ---------------- */

/**
 * 观众端画面的放大上限（2026-09-11，站长报「大播放器会导致串流画面很糊」）。
 *
 * ## 为什么「回到第一版布局」解决不了这件事
 *
 * 站长记忆里的「第一版 play page」是 09-07 之前那个 8/4 两栏、播放器塞在左边 8 列的样子
 * （1440 屏上画面约 750×420）。那**确实**会让画面变小，但它是「跟着窗口缩放」的 ——
 * 4K 屏上照样会被撑到 1400 宽，糊只是来得慢一点。
 * （顺带：09-07 那次「限宽 → 限高」的改动里**画面尺寸一个像素都没变**，
 * 见 stageHeightCap 上面那段推导。所以如果「第一版」指的是那一版，改回去是纯粹的空操作。）
 *
 * ## 真正的病因是放大倍数
 *
 * 推流发的是**源画布的分辨率**，而像素画那一档还刻意 `maintain-resolution`
 * （见 videoTuning.ts：小源宁可掉帧也不减分辨率）。于是 NES 约 256×240 的一路流，
 * 被一路撑到四倍多，而且是一条按 0.25 bit/像素/帧 压过的流 ——
 * 编码器省掉的每一个细节都跟着放大四倍。
 *
 * **09-11 在云端真 Chromium 里量的**（Playwright + 手写等价 CSS 的 probe，
 * 内容列上限 1900、视口高度预算 10rem，流按 256×240）：
 *
 * | 视口 | 现状：画面 / 放大 | 限 3 倍之后 |
 * |---|---|---|
 * | 1920×1170 | 1077×1010 / **4.21×** | 768×720 / 3.00× |
 * | 1920×1080 | 981×920 / 3.83× | 768×720 / 3.00× |
 * | 2560×1440 | 1140×1069 / **4.45×** | 768×720 / 3.00× |
 * | 1280×720 | 597×560 / 2.33× | **597×560 / 2.33×（一模一样）** |
 *
 * 最后一行是这套做法最值得看的一条：**矮屏上什么都没变**。
 * 那里限住画面的本来就是视口高度（`calc(100dvh - 10rem)`），
 * 这个上限只是把外面那个黑框从 1216 收到 768，画面一个像素没动。
 * 换句话说它只在「窗口大到开始糊」的时候才起作用。
 *
 * 代价是大屏上画面明显变小（NES 最大 768×720），两侧是黑边 —— 这是站长要的取舍。
 *
 * 3 倍怎么来的：2 倍在 1080p 屏上偏小（NES 只有 512×480），4 倍就回到现在这个量级了
 * （上表 3.83× 已经在糊）。真要调就改这个常量，它是这套逻辑里唯一一个可调的数。
 */
export const LIVE_MAX_SCALE = 3

/**
 * 观众端舞台的 inline style。`undefined` = 还不知道流多大，**不猜**（照常走类名那一套）。
 *
 * 三件事一起做，缺一件都不对：
 *
 * 1. **`aspectRatio` 按流的实际比例**。不这么做的话舞台还是 16:9，
 *    而 4:3 的流在里面 contain 一次 —— maxWidth 限的是那个 16:9 的框，
 *    画面只能拿到 `768 × 9/16 × 4/3 = 576` 宽，也就是 2.25 倍，不是 3 倍。
 *    直播这一支舞台里没有别的东西（桌面端工具栏是叠加的），所以舞台 = 画面，
 *    比例给准了就不会有任何一次多余的 contain。
 * 2. **`maxWidth`** = 原生宽 × 倍数。
 * 3. **`maxHeight`** = `min(原来那个视口上限, 原生高 × 倍数)`。
 *    ⚠️ 必须自己做这个 min：inline style 的优先级高过任何类名，
 *    直接写 `maxHeight: '720px'` 会把 stageHeightCap 那条**顶掉** ——
 *    矮屏上画面就会比视口还高，玩家得滚着看。
 *
 * ⚠️ **只在桌面端的普通分支用**：手机上舞台是 auto 高度（画面 + 手柄 + 工具栏三段），
 * 给它一个 aspectRatio 会把后两段挤出去；而全屏 / 游玩布局本来就是要铺满视口的。
 * 手机上也用不着 —— 390 宽的屏幕对 NES 只有 1.5 倍，压根不糊。
 */
export function liveStageStyle(
  geometry: { width: number; height: number } | null | undefined,
  immersive: boolean,
  maxScale: number = LIVE_MAX_SCALE,
): { aspectRatio: string; maxWidth: string; maxHeight: string } | undefined {
  const w = Number(geometry?.width) || 0
  const h = Number(geometry?.height) || 0
  if (w <= 0 || h <= 0) return undefined
  const scale = Math.max(1, Math.floor(maxScale) || 1)
  const cap = immersive ? STAGE_CAP_EXPR.immersive : STAGE_CAP_EXPR.normal
  return {
    aspectRatio: `${w} / ${h}`,
    maxWidth: `${w * scale}px`,
    maxHeight: `min(${cap}, ${h * scale}px)`,
  }
}
