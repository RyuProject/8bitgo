/**
 * Windows 客体的自动启动。
 *
 * js-dos 的 ci-ready 只表示 DOSBox-X 接口建好了，此时 Windows 往往还停在 BIOS、启动
 * Logo 或磁盘检查。过去从 ci-ready 直接倒计时，慢设备会在桌面出现前把 Ctrl+Esc / R
 * 全部吞掉，而且只有一次机会。DOSBox-X 没有“桌面已就绪”事件，但会在 Windows 切进
 * 图形界面时把画面切到至少 640×480；因此把后台配置的等待秒数锚定到这个信号之后。
 */

interface WindowsLaunchEvents {
  onFrameSize: (consumer: (width: number, height: number) => void) => void
}

export interface WindowsLaunchCi {
  screenshot?: () => Promise<ImageData>
  sendKeyEvent: (keyCode: number, pressed: boolean) => void
  events?: () => WindowsLaunchEvents
}

export type WindowsLaunchShell = '3x' | '9x'

/** 极少数自定义镜像不报告画面尺寸，不能让它们永远等不到启动。 */
export const WINDOWS_GRAPHICS_SIGNAL_FALLBACK_MS = 90_000

/** 720×400 / 640×400 都还是 DOS 文本或启动阶段；Win95 桌面会进入 640×480 或更高。 */
export function isWindowsGraphicsMode(width: number, height: number): boolean {
  return width >= 640 && height >= 480
}

export function windowsLaunchDelayMs(waitSeconds = 24): number {
  return Math.max(5, Math.min(120, waitSeconds)) * 1000
}

/**
 * 敲完启动命令之后，最多再花多久确认「客体里真的有反应」。
 *
 * ⚠️ 这是整条 Windows 客体链路上最重要的一道闸，值得说清楚：
 *
 * 以前 `finishLaunch` 是**无条件**在回车后 5 秒调 `onLaunched()`（= markReady）的，
 * 和客体里到底发生了什么完全无关。而 markReady 会顺手把 `readyFallback` 那个超时兜底
 * clearTimeout 掉、把 `ready` 置真 —— 于是启动链上任何一步走岔（开始菜单没开、Run 框没弹、
 * 盘符猜错、EXE 名字不是 8.3、缺 DLL），玩家看到的都是「遮罩撤掉 + 状态运行中 + 记一次游玩」，
 * 而且那唯一一次自动重试也被作废了。**这条链被设计成不可能报失败。**
 *
 * 现在改成拿画面当证据。判据刻意定得**极其保守**：只有在这段时间里画面
 * 几乎一个像素都没动（低于 CHANGE_RATIO）才判失败。理由是两个方向的误判代价差得很远 ——
 *   · 误判成功（今天的行为）= 玩家对着桌面干瞪眼，永远没人告诉他出了什么事
 *   · 误判失败 = 把一局本来能成的游戏拆掉重来，等好几分钟
 * 所以宁可放过一些失败，也不能冤枉一次成功。「敲下去的键全打进了空气」这一类
 * （最常见、也最没救的一类）画面确实纹丝不动，跑不掉。
 */
export const WINDOWS_LAUNCH_VERIFY_MS = 20_000
/** 每隔多久看一眼画面 */
const VERIFY_POLL_MS = 5_000
/**
 * 画面变了多少才算「有反应」。
 *
 * 2% 是有意留出的分水岭：游戏窗口 / 全屏画面远大于此；而「键打进桌面的 type-ahead、
 * 选中了一个图标」那点高亮只有千分之几，不会被误判成启动成功。
 * 弹出一个「找不到文件」对话框（约 300×150 ≈ 14%）会被算作有反应 —— 那正是上面说的
 * 「宁可放过」：那种情况至少客体是活的，玩家能看见那个框。
 */
const CHANGE_RATIO = 0.02

/** 两帧之间有多少比例的像素不一样。尺寸变了直接算「全变了」 */
export function frameDiffRatio(a: ImageData, b: ImageData): number {
  if (a.width !== b.width || a.height !== b.height) return 1
  const total = a.width * a.height
  if (!total) return 0
  // 抽样：整屏逐像素比在 1024×768 上是三百万次比较，没必要
  const step = Math.max(1, Math.floor(total / 20_000))
  let seen = 0
  let diff = 0
  for (let i = 0; i < total; i += step) {
    const at = i * 4
    seen++
    // 只比 RGB。alpha 在 DOSBox 的帧里恒为 255，比它是白花时间
    if (a.data[at] !== b.data[at] || a.data[at + 1] !== b.data[at + 1] || a.data[at + 2] !== b.data[at + 2]) diff++
  }
  return seen ? diff / seen : 0
}

/** File Manager 要先完成切盘和目录初始化，随后 File > Run 才会继承正确工作目录。 */
export const WINDOWS_3X_FILE_MANAGER_READY_MS = 4000
export const WINDOWS_3X_DRIVE_READY_MS = 1500

export interface Windows3xLaunchCommands {
  fileManager: string
  drive: string
  executable: string
}

/**
 * Windows 3.x 的 Program Manager 直接运行完整路径时不会把工作目录切到 EXE 旁边。
 * 游戏层会把 EXE 父目录挂成独立盘；这里拆出盘符和文件名，交给 File Manager 切盘。
 */
export function windows3xLaunchCommands(command: string): Windows3xLaunchCommands {
  const normalized = command.replace(/\//g, '\\')
  if (!/^[a-z]:\\/i.test(normalized)) throw new Error('Windows 3.x 自启动程序必须是带盘符的完整路径')
  const slash = normalized.lastIndexOf('\\')
  if (slash < 2 || slash === normalized.length - 1) throw new Error('Windows 3.x 自启动程序路径不完整')
  const directory = slash === 2 ? normalized.slice(0, 3) : normalized.slice(0, slash)
  return {
    fileManager: 'WINFILE.EXE',
    drive: directory[0].toUpperCase(),
    executable: normalized.slice(slash + 1),
  }
}

/** js-dos / Emscripten 使用 GLFW 键码；这里只列打开 Windows“运行”框需要的按键。 */
const WIN_KEY = {
  enter: 257,
  esc: 256,
  leftShift: 340,
  leftCtrl: 341,
  leftAlt: 342,
  d: 68,
  f: 70,
  r: 82,
  s: 83,
  space: 32,
  minus: 45,
  semicolon: 59,
} as const

/**
 * 进入客体图形模式后打开系统自己的“运行”对话框，再输入启动命令。
 *
 * Windows 95/98 会输入固定的 D:\\8BITGO\\RUN.BAT，由批处理切换真实工作目录；
 * Windows 3.x 的 DOS 会话无法启动 Windows 图形 EXE，而 Program Manager 直接运行又不
 * 会切换工作目录，所以先启动 File Manager 打开父目录，再从它的 File > Run 执行 EXE。
 */
/** 自动输入只会敲这些字符；别的字符在 DOS 8.3 文件名里也合法（~ ! $ # 之类），但这里敲不出来 */
const TYPEABLE = /^[a-z0-9:\\. \-_]*$/i

/**
 * 启动前先验一遍能不能敲出来。
 * 以前是敲到那个字符时在 setTimeout 里抛 —— 没人接得住：整条启动链停在半路，Windows 明明
 * 已经在屏幕上跑着，遮罩却一直盖着，四分多钟后才报一句「初始化超时」，重试一次再来一遍。
 */
export function assertTypeable(command: string): void {
  const bad = command.split('').find((ch) => !TYPEABLE.test(ch))
  if (bad !== undefined) throw new Error(`Windows 自动启动路径含无法输入的字符：${bad}`)
}

export function scheduleWindowsLaunch(
  ci: WindowsLaunchCi,
  command: string,
  waitSeconds: number,
  stopped: () => boolean,
  onLaunched: () => void,
  shell: WindowsLaunchShell = '9x',
  /** 确认不了「客体里有反应」时调它。**必须在 onLaunched 之前**，那样播放器还能自动重试一次 */
  onFailed?: (message: string) => void,
): () => void {
  const timers = new Set<number>()
  let armed = false
  const win3x = shell === '3x' ? windows3xLaunchCommands(command) : null
  const later = (ms: number, fn: () => void) => {
    const id = window.setTimeout(() => {
      timers.delete(id)
      if (!stopped()) fn()
    }, ms)
    timers.add(id)
  }
  const tap = (key: number, shift = false) => {
    if (shift) ci.sendKeyEvent(WIN_KEY.leftShift, true)
    ci.sendKeyEvent(key, true)
    ci.sendKeyEvent(key, false)
    if (shift) ci.sendKeyEvent(WIN_KEY.leftShift, false)
  }

  /** 开始打字前的那一帧，finishLaunch 拿它当基准 */
  let baselineFrame: ImageData | null = null

  const typeCommand = (value: string, onSubmitted: () => void) => {
    /*
      抓基准。异步落地，打字本来就要几百毫秒，来得及。
      ⚠️ 每次都覆盖，不是「只记第一次」：3.x 那条路会调两次 typeCommand
      （先敲 WINFILE，再敲游戏），基准必须是**最后那条命令**敲下去之前的画面，
      否则「文件管理器开起来了」这个变化会被算成「游戏起来了」。
    */
    void ci
      .screenshot?.()
      .then((frame) => {
        if (!stopped()) baselineFrame = frame
      })
      .catch(() => {})
    const chars = value.toLowerCase().split('')
    const typeAt = (at: number) => {
      if (at >= chars.length) {
        tap(WIN_KEY.enter)
        onSubmitted()
        return
      }
      const ch = chars[at]
      if (/[a-z0-9]/.test(ch)) tap(ch.toUpperCase().charCodeAt(0))
      else if (ch === ':') tap(WIN_KEY.semicolon, true)
      else if (ch === '\\') tap(92)
      else if (ch === '.') tap(46)
      else if (ch === ' ') tap(WIN_KEY.space)
      else if (ch === '-') tap(WIN_KEY.minus)
      else if (ch === '_') tap(WIN_KEY.minus, true)
      // 敲不出来的字符 assertTypeable 早就拦了；万一漏网也别在定时器里抛（没人接），跳过它
      later(35, () => typeAt(at + 1))
    }
    typeAt(0)
  }

  const openFileRun = (onOpened: () => void) => {
    ci.sendKeyEvent(WIN_KEY.leftAlt, true)
    tap(WIN_KEY.f)
    ci.sendKeyEvent(WIN_KEY.leftAlt, false)
    later(350, () => tap(WIN_KEY.r))
    later(800, onOpened)
  }

  /**
   * 敲完了。接下来盯着画面确认客体里真的有反应（见 WINDOWS_LAUNCH_VERIFY_MS）。
   *
   * `baseline` 是**开始打字之前**那一帧：那时我们认为 Run 框已经开着。
   * 拿它当基准，「键全打进了空气、桌面纹丝不动」这一类就能被认出来。
   */
  const finishLaunch = () => {
    const shot = ci.screenshot
    if (typeof shot !== 'function' || !onFailed) {
      // 拿不到画面（旧版 js-dos / 调用方不接失败）：只能沿用老行为，蒙一个 5 秒
      later(5000, onLaunched)
      return
    }
    let elapsed = 0
    const poll = () => {
      if (stopped()) return
      elapsed += VERIFY_POLL_MS
      void shot
        .call(ci)
        .then((frame) => {
          if (stopped()) return
          const base = baselineFrame
          // 基准没拿到就别判失败：证据不足时一律按成功走
          if (!base || frameDiffRatio(base, frame) >= CHANGE_RATIO) return onLaunched()
          if (elapsed >= WINDOWS_LAUNCH_VERIFY_MS) {
            onFailed(
              'Windows 客体没有响应自动启动命令（画面始终没有变化）。' +
                '多半是开始菜单/运行框没能打开，或者启动路径在客体里不存在。',
            )
            return
          }
          later(VERIFY_POLL_MS, poll)
        })
        .catch(() => {
          // 截不到图就别较真，按老行为放行
          if (!stopped()) onLaunched()
        })
    }
    later(VERIFY_POLL_MS, poll)
  }

  const launch = () => {
    if (win3x) {
      // Windows 3.x 没有开始菜单，Ctrl+Esc 打开的是 Task List，随后按 R 什么也不会运行。
      // File Manager 的 Run 会继承当前盘根目录；游戏层已把 EXE 父目录挂成这个盘。
      openFileRun(() => typeCommand(win3x.fileManager, () => {
        later(WINDOWS_3X_FILE_MANAGER_READY_MS, () => {
          ci.sendKeyEvent(WIN_KEY.leftAlt, true)
          tap(WIN_KEY.d)
          ci.sendKeyEvent(WIN_KEY.leftAlt, false)
          later(350, () => tap(WIN_KEY.s))
          later(800, () => {
            tap(win3x.drive.charCodeAt(0))
            later(350, () => {
              tap(WIN_KEY.enter)
              later(WINDOWS_3X_DRIVE_READY_MS, () => {
                openFileRun(() => typeCommand(win3x.executable, finishLaunch))
              })
            })
          })
        })
      }))
      return
    }

    // DOSBox-X 不会把浏览器的 Meta / Super 键可靠地交给 Win95；Win+R 会退化成桌面上的
    // 普通字母 R。Ctrl+Esc 是 Windows 95 原生的“打开开始菜单”，随后 R 触发 Run。
    ci.sendKeyEvent(WIN_KEY.leftCtrl, true)
    tap(WIN_KEY.esc)
    ci.sendKeyEvent(WIN_KEY.leftCtrl, false)
    later(350, () => tap(WIN_KEY.r))
    later(800, () => typeCommand(command, finishLaunch))
  }
  const arm = () => {
    if (armed || stopped()) return
    armed = true
    later(windowsLaunchDelayMs(waitSeconds), launch)
  }
  /**
   * 见过一次「不是图形模式」的尺寸没有。
   *
   * ⚠️ 这个信号的两个误判方向代价差得很远：
   *   · 偏晚（真桌面没被认出来）→ 90 秒兜底接住，只是慢一点
   *   · 偏早（把还没进桌面的画面当成桌面）→ `armed` 是一次性闩锁，再也不会重来，
   *     整套「锚定到图形信号」退化成「ci-ready 起倒计时」，而那正是这个文件要修掉的老 bug。
   *     后果是按键全打在 BIOS / 启动阶段，然后 5 秒后 markReady，**完全静默**。
   * 所以要求先见过一次非图形尺寸再接受图形尺寸：镜像一启动就报 ≥640×480
   * （比如镜像自带 `[render] aspect=true`，720×400 文本模式校正后输出 720×540）不可信。
   * 真的一直没见过文本模式也不会卡住 —— 90 秒兜底照样 arm。
   */
  let sawTextMode = false
  const observeSize = (width: number, height: number) => {
    if (!isWindowsGraphicsMode(width, height)) {
      sawTextMode = true
      return
    }
    if (sawTextMode) arm()
  }

  try {
    const events = ci.events?.()
    if (events) {
      events.onFrameSize(observeSize)
      // 注册监听前若已切过画面模式，补读当前帧，避免永远只等兜底。
      void ci.screenshot?.().then((frame) => observeSize(frame.width, frame.height)).catch(() => {})
    } else {
      // 兼容没有 events() 的旧版 js-dos；这种情况下只能保留原来的倒计时行为。
      arm()
    }
  } catch {
    arm()
  }
  later(WINDOWS_GRAPHICS_SIGNAL_FALLBACK_MS, arm)

  return () => {
    for (const timer of timers) window.clearTimeout(timer)
    timers.clear()
  }
}
