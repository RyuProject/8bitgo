/**
 * 双屏机型的屏幕布局。目前只有任天堂 DS（melonDS 核心）。
 *
 * ── 为什么需要这一层 ────────────────────────────────────────
 * NDS 的两块屏默认是**上下叠**着的：核心报给前端的画面是 256×384（2:3，竖的）。
 * 而播放器的框在桌面端是 16:9、在手机上是按平台查表给的一个固定比例
 * （见 screenAspect.ts）。引擎的画布是 object-fit:contain，容器比内容宽只是两侧
 * 多黑边、画面大小不变 —— 于是 2:3 的画面放进 16:9 的框里，**能用的宽度只有
 * 高度的三分之二**，一块 960×540 的播放器里画面只有 360×540，两侧各空 300px。
 *
 * melonDS 自己是支持换布局的（`melonds_screen_layout`，八种取值），换成
 * `Left/Right` 两块屏并排就是 512×192（8:3，横的），放进同一个 16:9 的框里
 * 宽度占满、每块屏 480×360 —— 比上下叠那一档每块屏（360×270）线性大三分之一，
 * 面积大近八成。**这是桌面端 NDS 最直接的一笔收益，而且不花任何额外算力。**
 *
 * 反过来手机竖屏里容器是竖的，`Top/Bottom` 才是对的 —— 所以默认值必须按容器
 * 方向定，不能全站一个值。
 *
 * ── 为什么不查表写死取值 ────────────────────────────────────
 * 取值字符串（`Top/Bottom`、`Hybrid Top`…）是**核心**定的，不是我们定的。
 * 换一版核心、换一个核心（desmume 那一路叫 `desmume_screens_layout`，取值也不同）
 * 表就对不上，而对不上是**静默**的：EmulatorJS 的 changeSettingOption 对认不出的
 * key 只是往 allSettings 里塞一格，不报错、不生效。
 *
 * 所以这里的做法是：**从核心自报的选项表里现找**（EmulatorJS 的
 * `gameManager.getCoreOptionsJSON()` 就是核心的 retro_core_options_v2），
 * 按 key 认出「哪一项是屏幕布局」，取值一律用它报上来的那些原样回填。
 * 我们只对取值做**形态归类**（上下叠 / 并排 / 单屏 / 混合），归不了类的按未知处理
 * —— 未知不影响能不能切，只影响我们要不要跟着改容器比例。
 *
 * 取证（2026-09-07，把 public/emulatorjs/cores/melonds-wasm.data 那个 7z 解开，
 * 直接读 wasm 数据段里的 retro_core_option_v2_definition 数组）：
 *
 *   melonds_screen_layout  默认 Top/Bottom
 *     Top/Bottom | Bottom/Top | Left/Right | Right/Left | Top Only | Bottom Only
 *     | Hybrid Top | Hybrid Bottom
 *   melonds_hybrid_small_screen  默认 Bottom（Bottom | Top | Duplicate）
 *   melonds_touch_mode           默认 Mouse（Mouse | Touch | Joystick | disabled）
 *   melonds_screen_gap           默认 0（0…126）
 *
 * 同时确认了这个构建里**没有** threaded renderer / JIT / OpenGL 渲染器这三类选项，
 * 也没有 `melonds-thread-wasm.data` —— 所以「开多线程给 NDS 提速」在当前核心上
 * 不存在这条路，能减的只有像素（单屏布局）和我们自己那侧的开销。别再去找那个开关。
 */
import type { PlatformId } from '@/types'

/**
 * 画面是两块屏拼出来的平台。
 *
 * 用途有两个，别只想着布局：
 *   1. 有没有布局可切（这个文件）
 *   2. **推流分档**：videoTuning 按画布总像素判「是不是像素画」，而双屏机型的
 *      总像素是两块屏加起来的 —— 单块屏才是判据（见 videoTuning.dualScreen）
 */
export const DUAL_SCREEN_PLATFORMS = new Set<PlatformId>(['nds'])

/**
 * 参数刻意放宽到 string：直播那条路手里只有 `BroadcastMeta.platform`（就是个 string，
 * 从房间快照里来的），为了这一个判断把整条链改成 PlatformId 不值得 ——
 * 认不出的字符串本来就返回 false，宽松在这里没有代价。
 */
export const isDualScreen = (platform: PlatformId | string): boolean =>
  DUAL_SCREEN_PLATFORMS.has(platform as PlatformId)

/** 核心自报的一项选项。字段名照 EmulatorJS 的 getCoreOptionsJSON */
export interface CoreOption {
  key?: string
  desc?: string | null
  values?: unknown
  default?: string | null
  current?: string | null
  visible?: boolean
}

/** 认出来的布局项：key 交给引擎，values 拿来画 UI */
export interface LayoutOption {
  key: string
  values: string[]
  /** 核心报的当前值（没报就是空） */
  current: string
  /** 核心报的出厂默认（没报就是空） */
  fallback: string
}

/**
 * 布局的几何形态。**只用来决定容器比例和触控守卫**，不参与和核心的通信。
 *
 *   stack   两块屏上下叠（竖的）
 *   side    两块屏左右并排（横的）
 *   single  只显示一块屏（4:3）
 *   hybrid  一大两小的混合摆法 —— 几何比例不好推，一律靠量画布
 *   unknown 认不出来。**不是错误**：照样能切，只是我们不替它猜比例
 */
export type LayoutShape = 'stack' | 'side' | 'single' | 'hybrid' | 'unknown'

/**
 * 哪一项是「屏幕布局」。
 *
 * 按 key 认而不按 desc 认：desc 会被 EmulatorJS 拿去做本地化查表，
 * 而 key 是核心的 ABI，稳定得多。
 */
/*
  三种真实写法都要认（都是实读核心得来的，不是推测）：
    melonds_screen_layout        melonDS，v2 选项格式
    desmume_screens_layout       DeSmuME，v2，注意是复数 screens
    Screen layout                DeSmuME 2015 走的是**旧版 v1 格式**，
                                 而 EmulatorJS 解析那份文本时是拿分号前那一截
                                 当 key 用的（见 parseCoreOptionsText）——
                                 所以空格分隔的写法也得放进来。
  代价是可控的：唯一可能被多认进来的，就是字面写着「screen layout」的那一项，
  而在文本兜底那条路上它**正是**引擎自己用的 key。
*/
const LAYOUT_KEY = /screen[\s_-]?s?[\s_-]?layout/i

/** 值里出现这些词就认得出形态。顺序有讲究：Only 要在 Top / Bottom 之前判 */
export function layoutShape(value: string): LayoutShape {
  const v = String(value || '').trim().toLowerCase()
  if (!v) return 'unknown'
  if (v.includes('hybrid')) return 'hybrid'
  // 「只显示一块屏」：melonDS 写 `Top Only` / `Bottom Only`
  if (/\bonly\b/.test(v)) return 'single'
  // 并排：`Left/Right` / `Right/Left`
  if (v.includes('left') && v.includes('right')) return 'side'
  // 上下叠：`Top/Bottom` / `Bottom/Top`
  if (v.includes('top') && v.includes('bottom')) return 'stack'
  return 'unknown'
}

/**
 * 这个布局下，**触摸屏那一块看得见吗**。
 *
 * ⚠️ 这是这个文件里最要紧的一条。NDS 的下屏就是触摸屏，`Top Only` 把它整块藏掉
 * —— 而指针优先的平台默认是**收起引擎那套屏幕按键**的（见 adapters/emulatorjs.ts
 * 的 POINTER_FIRST）。两件事叠起来就是：玩家一切到 `Top Only`，这一局
 * **一个能按的东西都没有** —— 画面点不到、按键收着、手机上又没有键盘。
 * 所以切布局必须连带把这一位算出来，交给适配器补上按键（见 syncTouchCaps）。
 *
 * 判据只认「只有上屏」这一种：`Top Only`。
 * `Bottom Only` 恰恰是**纯触控游戏最好的布局** —— 整个框都是触摸屏。
 * 混合布局的小屏默认放的是下屏（melonds_hybrid_small_screen 默认 Bottom），
 * 所以 hybrid 一律算看得见；玩家把小屏改成 Top 的话这里会说错，
 * 那是引擎菜单里另一项，我们不读也不改，宁可在这一格上偏保守（说看得见 =
 * 不强行弹按键，玩家自己去 🎮 里开）。
 */
export function showsTouchScreen(value: string): boolean {
  const v = String(value || '').trim().toLowerCase()
  if (!v) return true
  // `top only` / `only top` 都拦掉，别赌核心的词序
  return !(/\bonly\b/.test(v) && v.includes('top') && !v.includes('bottom'))
}

/** 把核心报的 values 摊平成字符串数组。它可能是 [{value,label}] 也可能是 [string] */
function flatValues(raw: unknown): string[] {
  if (!Array.isArray(raw)) return []
  const out: string[] = []
  for (const item of raw) {
    if (typeof item === 'string') {
      if (item) out.push(item)
    } else if (item && typeof item === 'object') {
      const v = (item as { value?: unknown }).value
      if (typeof v === 'string' && v) out.push(v)
    }
  }
  return out
}

/**
 * 老格式的核心选项（`getCoreOptions()` 返回的那一大坨文本）。
 *
 * 一行一项，形如 `melonds_screen_layout|Top/Bottom; Top/Bottom|Left/Right|…`
 * —— 竖线前是 key、后面是默认值；分号后是取值表。取法照抄 EmulatorJS
 * 自己建菜单时那段（`s.split("|")[0]` / `n[1].split("|")`），它才是这份文本的定义方。
 *
 * 为什么要留这条路：`getCoreOptionsJSON` 是新加的 cwrap，老一点的核心构建里
 * `Module._get_core_options_json` 根本不存在，引擎自己也是这么兜的。
 */
export function parseCoreOptionsText(text: unknown): CoreOption[] {
  if (typeof text !== 'string' || !text.trim()) return []
  const out: CoreOption[] = []
  for (const line of text.split('\n')) {
    const parts = line.split('; ')
    if (parts.length < 2) continue
    const head = parts[0].split('|')
    const key = head[0]?.trim()
    if (!key) continue
    const values = parts[1].split('|').map((v) => v.replace('(Default) ', '').trim()).filter(Boolean)
    out.push({ key, default: head.length > 1 ? head[1]?.trim() : values[0], values })
  }
  return out
}

/**
 * 从核心上报的选项表里找出布局那一项。
 *
 * 找不到就返回 null —— 那说明这个核心没有这回事（或者换了个名字），
 * 播放器那边整块 UI 直接不画。**不猜 key、不硬编默认值**：宁可没有这个功能，
 * 也不要给玩家一颗按了没反应的按钮（工具栏那个「屏幕按键」开关踩过一次）。
 *
 * 取值少于两个也当没有：只有一个取值的下拉框没有意义（EmulatorJS 自己的设置菜单
 * 也是这么判的 —— `e.values.length <= 1` 直接不画那一行）。
 */
export function findLayoutOption(options: unknown): LayoutOption | null {
  const list = Array.isArray(options)
    ? options
    : Array.isArray((options as { options?: unknown } | null)?.options)
      ? ((options as { options: unknown[] }).options)
      : null
  if (!list) return null
  for (const raw of list) {
    const opt = (raw ?? {}) as CoreOption
    const key = typeof opt.key === 'string' ? opt.key : ''
    if (!key || !LAYOUT_KEY.test(key)) continue
    const values = flatValues(opt.values)
    if (values.length < 2) continue
    const fallback = typeof opt.default === 'string' ? opt.default : ''
    const current = typeof opt.current === 'string' ? opt.current : ''
    return { key, values, current, fallback }
  }
  return null
}

/**
 * 容器是「宽的」还是「竖的」—— 决定默认给哪种布局。
 *
 * 1.2 不是 1.0：正方形附近两种布局差不多，而**判成 side 的代价更大**
 * （8:3 的画面放进接近正方形的框里，画面高度只剩容器的三分之一，
 * 比 2:3 放进同一个框里还小）。所以要明显是横的才给 side。
 */
export const WIDE_RATIO = 1.2

export function isWideBox(width: number, height: number): boolean {
  const w = Number(width) || 0
  const h = Number(height) || 0
  if (w <= 0 || h <= 0) return false
  return w / h >= WIDE_RATIO
}

/**
 * 这个容器该用哪种布局。**只在核心报上来的取值里挑**，挑不出来返回空串
 * （= 不去动它，让核心保持自己的默认）。
 *
 * 挑法：宽容器优先 side，竖容器优先 stack；同一形态里取核心列在前面的那个
 * （melonDS 的 `Left/Right` 排在 `Right/Left` 前，`Top/Bottom` 排在 `Bottom/Top` 前
 * —— 前者都是「主屏在左 / 在上」，跟实机摆法一致）。
 *
 * ⚠️ 单屏（`Top Only` / `Bottom Only`）**永远不做默认**：`Top Only` 会让纯触控游戏
 * 没有任何输入，`Bottom Only` 则藏掉上屏（大多数游戏的主画面在上屏）。
 * 这两个只能由玩家自己选。
 */
export function preferredLayout(values: string[], wide: boolean): string {
  const want: LayoutShape = wide ? 'side' : 'stack'
  for (const v of values) if (layoutShape(v) === want) return v
  return ''
}

/**
 * 布局取值 → 一个**稳定的文案键后缀**，给 i18n 用。
 *
 * 为什么要这一层：核心报上来的是英文原文（`Top/Bottom`、`Hybrid Top`），
 * 直接摆在中文界面上很生硬，而 EmulatorJS 自带的语言包里**根本没有**这些串
 * （2026-09-07 全量搜过 public/emulatorjs/localization/*.json，一条都没有）——
 * 指望引擎翻是不行的。
 *
 * 认不出来就返回空串：那时 UI 原样显示核心给的英文。**这比猜一个中文名安全** ——
 * 换核心之后取值可能是别的意思（desmume 那一路还有 `Quick Switch` 之类），
 * 硬翻会把玩家骗到。
 *
 * 「上屏 / 下屏」的对应关系：`Top/Bottom` 是上屏在**上**、下屏在下（实机摆法），
 * `Bottom/Top` 反过来；`Left/Right` 是上屏在**左**。这是 melonDS 的语义，
 * 词序就是屏幕顺序。
 */
export function layoutToken(value: string): string {
  const v = String(value || '').trim().toLowerCase()
  if (!v) return ''
  const shape = layoutShape(v)
  if (shape === 'hybrid') return v.includes('bottom') ? 'HybridBottom' : 'HybridTop'
  if (shape === 'single') return v.includes('bottom') ? 'BottomOnly' : 'TopOnly'
  if (shape === 'side') return v.indexOf('right') < v.indexOf('left') ? 'SideRight' : 'SideLeft'
  if (shape === 'stack') return v.indexOf('bottom') < v.indexOf('top') ? 'StackBottom' : 'StackTop'
  return ''
}

/**
 * 布局形态 → 画面的标称宽高比。
 *
 * ⚠️ 这只是**兜底**。真正该用的是画布的实测尺寸（core 的 av_info 几何，
 * 切完布局下一帧就更新了）—— 混合布局的比例取决于 melonds_hybrid_ratio 这类
 * 我们不读的选项，查表一定会错。量得到就别用这里的数（见 adapters/emulatorjs.ts
 * 的 reportGeometry 与 screenAspect.aspectClass）。
 */
export function nominalRatio(shape: LayoutShape): number {
  switch (shape) {
    case 'stack':
      return 256 / 384
    case 'side':
      return 512 / 192
    case 'single':
      return 256 / 192
    default:
      return 0
  }
}
