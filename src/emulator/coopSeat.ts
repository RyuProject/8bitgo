/**
 * 「上场当 2P」：把一个观众的按键，经直播那条 PeerConnection 送到房主这边，
 * 注入同屏双打游戏的第二组键位（Ruffle 的 `keys.p2`，见 flashKeys.ts）。
 *
 * ── 为什么这不是 netplay ────────────────────────────────────
 * EmulatorJS 联机难在**同步核心状态**：两边都在跑游戏，状态必须一致。
 * 而同屏双打的 Flash 游戏根本不需要 —— 游戏只在房主那一台跑，访客从来不跑游戏，
 * 他看到的是直播画面。要做的事只剩一件：把他的按键送过来。
 * 所以 Flash / html5 这些「没有联机能力」的引擎，反而能用这条路凑出双人游戏。
 *
 * ── 通道 ────────────────────────────────────────────────────
 * 走直播 PeerConnection 上的 DataChannel（房主在 createOffer 之前建，进 SDP，
 * 不需要重新协商）。不走 socket.io：每次按键多一趟服务器往返，还给信令服务器
 * 加上按键量级的负载，而这条 PC 本来就已经付过了。
 *
 * ── ⚠️ 身份只能来自「这条消息从哪条通道来的」 ─────────────────
 * 这一条是从 netplayGuard.ts 那次事故里逐字搬来的：EmulatorJS 的 netplay 让访客
 * 自己在消息里填 `player`，于是任何访客（连观众都算）都能替 1P 按键。
 * 所以本协议的按键消息里**没有座位号**，`admit()` 只认「发送方是不是当前持座的那一位」。
 * 服务器看不见 DataChannel，这道闸只可能在房主的浏览器里守 —— 也正因如此，
 * 整个功能不需要服务端改一行（代价是大厅暂时不知道「这房还差一个人」）。
 *
 * ── ⚠️ 松键是这个功能最要紧的安全性质 ────────────────────────
 * 漏掉一个 keyup，游戏里那个角色就一直朝墙里跑，而且看起来像游戏卡住了 ——
 * 玩家不会想到是「刚才那个人下场了」。所以收座 / 通道关 / 观众断线 / 停播
 * 这四条路径都必须把还按着的键全部松开，`grant/revoke/forget` 因此统一
 * **返回「要松开哪些键」**，调用方照着发 up 就行，不需要自己记。
 *
 * 拆成独立模块是为了能在 node 里测（`npm run test:coop-seat`）——
 * broadcast.ts / liveview.ts 本体依赖一堆浏览器环境，没法直接 import。
 */
import type { PadButton } from './types'

/** DataChannel 的名字。两边靠它认出这条通道是干什么的 */
export const COOP_CHANNEL = 'coop'

/**
 * 一条消息的长度上限（字符）。`{"t":"k","b":"right","d":true}` 三十来个字符，
 * 200 已经很宽松 —— 卡这一道是为了让「往通道里灌垃圾」在 JSON.parse 之前就被挡掉。
 */
export const MAX_MSG_LEN = 200

/**
 * 按键消息的限流（每秒）。键盘不是摇杆：一个人两只手按到最快也就每秒几十个事件，
 * 120 留了几倍余量。超出的静默丢 —— 每一条都要进一次运行时，灌满了房主的游戏会卡。
 */
export const KEYS_PER_SEC = 120
/** 「我想上场」的限流（每秒）。不卡的话能刷爆房主那条提示 */
export const WANTS_PER_SEC = 1

/** 协议里允许出现的按钮。抽象按钮层的好处：两边键位不用一致，映射在房主那边做 */
const BUTTONS: readonly PadButton[] = ['up', 'down', 'left', 'right', 'a', 'b', 'select', 'start']
const BUTTON_SET = new Set<string>(BUTTONS)

/**
 * 通道上跑的四种消息。
 *
 *   hello  房主 → 访客   通道一开就发，告诉他这局有没有 2P 位（能力发现）
 *   want   访客 → 房主   我想上场
 *   leave  访客 → 房主   我下场（不加这一条，访客想退出只能关页面 ——
 *                        那样房主要等 DataChannel 关掉才察觉，中间那段键还按着）
 *   seat   房主 → 访客   给你 / 收回，附上「你能按哪几颗」
 *   k      访客 → 房主   一次按键（**没有座位号**，见文件头）
 */
export type CoopMsg =
  | { t: 'hello'; coop: boolean; buttons?: PadButton[] }
  | { t: 'want' }
  | { t: 'leave' }
  | { t: 'seat'; on: boolean; buttons?: PadButton[] }
  | { t: 'k'; b: PadButton; d: boolean }

export function encode(msg: CoopMsg): string {
  return JSON.stringify(msg)
}

/**
 * 解析一条收到的消息。**任何拿不准的都返回 null** —— 这是对面（可能是任何人）
 * 送进来的字节，形状、长度、按钮名全部在这里核一遍，别让它进到运行时。
 */
export function parse(raw: unknown): CoopMsg | null {
  // 只收字符串：ArrayBuffer / Blob 一律不认，省掉一整类解码歧义
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > MAX_MSG_LEN) return null
  let obj: unknown
  try {
    obj = JSON.parse(raw)
  } catch {
    return null
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null
  const m = obj as Record<string, unknown>
  switch (m.t) {
    case 'want':
      return { t: 'want' }
    case 'leave':
      return { t: 'leave' }
    case 'k':
      if (typeof m.b !== 'string' || !BUTTON_SET.has(m.b) || typeof m.d !== 'boolean') return null
      return { t: 'k', b: m.b as PadButton, d: m.d }
    case 'hello':
      if (typeof m.coop !== 'boolean') return null
      return { t: 'hello', coop: m.coop, ...(buttonList(m.buttons) ? { buttons: buttonList(m.buttons) } : {}) }
    case 'seat': {
      if (typeof m.on !== 'boolean') return null
      const buttons = buttonList(m.buttons)
      return { t: 'seat', on: m.on, ...(buttons ? { buttons } : {}) }
    }
    default:
      return null
  }
}

/** 按钮清单：认不出的成员直接剔掉；一个都不剩就当没给 */
function buttonList(value: unknown): PadButton[] | undefined {
  if (!Array.isArray(value)) return undefined
  const out = value.filter((b): b is PadButton => typeof b === 'string' && BUTTON_SET.has(b))
  return out.length ? out : undefined
}

/** 房主侧的闸 */
export interface SeatGate {
  /**
   * 一条消息进来。放行就返回解析后的消息，丢掉返回 null。
   * @param from 这条消息**从哪条通道来的**（观众 id）。绝不能取自消息内容
   */
  admit: (from: string, raw: unknown, now?: number) => CoopMsg | null
  /** 把座位给某个观众。返回要松开的键（换人时上一位可能还按着） */
  grant: (from: string) => PadButton[]
  /** 收回座位。返回要松开的键 */
  revoke: () => PadButton[]
  /** 这条通道没了（观众断线 / 拆连接）。不是持座那位就什么都不做 */
  forget: (from: string) => PadButton[]
  /**
   * 同一个人换了 id（观众信令重连后 socket.id 变了，服务端发 viewer-rebound，
   * 房主把那条**还在流的**连接改个名字 —— 见 broadcast.ts 里 peers 的注释）。
   *
   * ⚠️ 这一条不加会静默失效：连接还在、画面一帧不掉，但闸里的座位还记着旧 id，
   * 于是持座那位**从此一个键都送不进来**，而两边界面都显示他还是 2P。
   * 按着的键**不清** —— 人没变、手还按在那儿，清了他的角色会莫名停一下。
   */
  rename: (from: string, to: string) => void
  /** 当前持座的观众 id；没人就是 null */
  seated: () => string | null
  /** 当前还按着的键 */
  held: () => PadButton[]
}

interface Rate {
  keys: number
  wants: number
  /** 这个计数窗口的起点（毫秒） */
  at: number
}

/**
 * @param buttons 这一局 2P 真的读哪几颗键（`keys.p2` 的键集）。给了就只放行这几颗 ——
 *        第二道闸：运行时那边 `pad?.[button]` 查不到也会忽略，但拦在这里能少走一趟。
 *        返回空数组 = 这一局没有 2P 位，那就一个按键都不该放行。
 */
export function createSeatGate(buttons?: () => readonly PadButton[]): SeatGate {
  let seat: string | null = null
  const down = new Set<PadButton>()
  const rates = new Map<string, Rate>()

  /** 松开所有按着的键并清空。返回刚才按着的那些 */
  const flush = (): PadButton[] => {
    const out = [...down]
    down.clear()
    return out
  }

  const allowed = (b: PadButton): boolean => {
    if (!buttons) return true
    const list = buttons()
    return Array.isArray(list) && list.includes(b)
  }

  /** 限流：每秒一个计数窗口。超了返回 false */
  const takeToken = (from: string, kind: 'keys' | 'wants', now: number): boolean => {
    let r = rates.get(from)
    if (!r || now - r.at >= 1000) {
      r = { keys: 0, wants: 0, at: now }
      rates.set(from, r)
    }
    const limit = kind === 'keys' ? KEYS_PER_SEC : WANTS_PER_SEC
    if (r[kind] >= limit) return false
    r[kind] += 1
    return true
  }

  return {
    admit(from, raw, now = Date.now()) {
      const msg = parse(raw)
      if (!msg) return null
      if (msg.t === 'want') return takeToken(from, 'wants', now) ? msg : null
      // 下场：只有持座那位说了才算数（别人发等于替他下场）。和 want 共用一个配额桶
      if (msg.t === 'leave') return seat === from && takeToken(from, 'wants', now) ? msg : null
      if (msg.t === 'k') {
        // ⚠️ 只认持座那一位。观众、以及「刚被收回座位的人」发的按键一律丢
        if (!seat || from !== seat) return null
        if (!allowed(msg.b)) return null
        if (!takeToken(from, 'keys', now)) return null
        if (msg.d) down.add(msg.b)
        else down.delete(msg.b)
        return msg
      }
      // hello / seat 是房主发给访客的，房主这边收到只能是对面在乱发
      return null
    },
    grant(from) {
      if (seat === from) return []
      // 换人：上一位按着的键必须松掉，否则那个角色永远朝一个方向跑
      const stuck = flush()
      seat = from
      return stuck
    },
    revoke() {
      seat = null
      return flush()
    },
    forget(from) {
      rates.delete(from)
      if (seat !== from) return []
      seat = null
      return flush()
    },
    rename(from, to) {
      if (from === to) return
      const r = rates.get(from)
      if (r) {
        rates.delete(from)
        rates.set(to, r)
      }
      if (seat === from) seat = to
    },
    seated: () => seat,
    held: () => [...down],
  }
}
