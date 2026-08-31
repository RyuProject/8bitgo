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
export function scheduleWindowsLaunch(
  ci: WindowsLaunchCi,
  command: string,
  waitSeconds: number,
  stopped: () => boolean,
  onLaunched: () => void,
  shell: WindowsLaunchShell = '9x',
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

  const typeCommand = (value: string, onSubmitted: () => void) => {
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
      else throw new Error(`Windows 自动启动路径含无法输入的字符：${ch}`)
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

  const finishLaunch = () => {
    // Windows shell 收到命令后还要创建进程；这段时间继续盖住桌面与“运行”框。
    later(5000, onLaunched)
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
  const observeSize = (width: number, height: number) => {
    if (isWindowsGraphicsMode(width, height)) arm()
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
