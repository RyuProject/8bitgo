/**
 * 启动 BAT 的 DOSBox 兼容修补（只读原包，修补结果作为别名 BAT 写进最终 bundle）。
 *
 * ── 为什么（2026-11-05《大富翁3》实测）─────────────────────────────────────
 * 原版 PLAY.BAT 只有四行：`subst a: .` / `Mouse.com` / `SS` / `RICH3`。两行都在 DOSBox 里出事：
 *
 *   1. **SUBST**：js-dos 的 DOSBox 没有这个命令，只打一句 Illegal command 就继续。游戏随后从 A:
 *      读图——主菜单还能出来，进「單人遊戲」后选人画面缺背景和按钮，点下去整局卡死。
 *      这里在 autoexec 里换成等价的 `mount a .`（同一个宿主目录），BAT 里那行改成 REM。
 *   2. **外置鼠标驱动**：MOUSE.COM 接管 INT 33h 后，DOSBox 内置驱动的绝对定位全部失效，只剩
 *      PS/2 相对位移再被驱动加速：没锁定指针时游戏光标和真实鼠标对不上，触屏鼠标板 / 手柄右摇杆的
 *      绝对坐标也全部作废。DOSBox 自带完整的 INT 33h 驱动，所以把这类行改成 REM。
 *
 * 只认这两类、写法明确的行；BAT 里出现 CD / 换盘符之后，当前目录不再可知，SUBST 不再翻译。
 * BAT 可能含 Big5 / GBK 的 ECHO 文本，全程按字节处理，不经 UTF-8 解码。
 */

/** DOS 下常见的鼠标驱动程序名（不含路径） */
const MOUSE_DRIVERS = new Set([
  'mouse', 'mouse.com', 'mouse.exe',
  'gmouse', 'gmouse.com', 'gmouse.exe',
  'ctmouse', 'ctmouse.com', 'ctmouse.exe',
  'msmouse', 'msmouse.com', 'msmouse.exe',
  'lmouse', 'lmouse.com', 'lmouse.exe',
  'mscmouse', 'mscmouse.com', 'mscmouse.exe',
])

/** BAT 再大就不是这类启动脚本了，不碰 */
export const DOS_BATCH_COMPAT_MAX_BYTES = 16 * 1024

const DOS_83_SEGMENT = /^[A-Za-z0-9_^$~!#%&{}@'()-]{1,8}(\.[A-Za-z0-9_^$~!#%&{}@'()-]{1,3})?$/

export interface DosBatchCompatOptions {
  /** BAT 在 ZIP 里的目录，'' 或以 / 结尾，例如 'RICH3/' */
  dir: string
  /** ZIP 里是否存在这个文件（不区分大小写） */
  fileExists: (path: string) => boolean
  /** 已被 autoexec 占用的盘符（小写），C 永远算占用 */
  takenDrives?: Iterable<string>
}

export interface DosBatchCompatPlan {
  /** 修补后的 BAT 字节；没改动时为 null */
  bytes: Uint8Array<ArrayBuffer> | null
  /** 要加到 autoexec（启动程序之前）的挂载命令 */
  mounts: string[]
  /** 给控制台 / 测试看的改动说明 */
  notes: string[]
}

function bytesToBinary(bytes: Uint8Array): string {
  let out = ''
  for (let i = 0; i < bytes.length; i += 8192) out += String.fromCharCode(...bytes.subarray(i, i + 8192))
  return out
}

function binaryToBytes(text: string): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(text.length) as Uint8Array<ArrayBuffer>
  for (let i = 0; i < text.length; i++) out[i] = text.charCodeAt(i) & 0xff
  return out
}

/** 去掉 @ 和 LH / LOADHIGH 前缀，返回命令名与其余参数 */
function commandOf(line: string): { name: string; args: string } | null {
  let rest = line.trim().replace(/^@\s*/, '')
  const loadHigh = /^(?:lh|loadhigh)\s+/i.exec(rest)
  if (loadHigh) rest = rest.slice(loadHigh[0].length)
  const match = /^([^\s/]+)(.*)$/.exec(rest)
  if (!match) return null
  return { name: match[1]!.toLowerCase(), args: match[2]!.trim() }
}

export function planDosBatchCompatibility(source: Uint8Array, options: DosBatchCompatOptions): DosBatchCompatPlan {
  const none: DosBatchCompatPlan = { bytes: null, mounts: [], notes: [] }
  if (!source.length || source.length > DOS_BATCH_COMPAT_MAX_BYTES) return none
  const dir = options.dir.replace(/\\/g, '/')
  const hostDir = dir.replace(/\/$/, '')
  if (hostDir && !hostDir.split('/').every((segment) => DOS_83_SEGMENT.test(segment))) return none
  const taken = new Set(['c', ...[...(options.takenDrives ?? [])].map((drive) => drive.toLowerCase())])

  const text = bytesToBinary(source)
  // 保留每行原来的换行符（CRLF / LF）以及末尾的 Ctrl-Z
  const parts = text.split(/(\r?\n)/)
  const mounts: string[] = []
  const notes: string[] = []
  let cwdKnown = true
  let changed = false

  for (let index = 0; index < parts.length; index += 2) {
    const line = parts[index]!
    const trimmed = line.replace(/\x1a+$/, '').trim()
    if (!trimmed || /^(?:rem\b|::)/i.test(trimmed.replace(/^@\s*/, ''))) continue
    const command = commandOf(trimmed)
    if (!command) continue

    if (command.name === 'cd' || command.name === 'chdir' || command.name.startsWith('cd\\') || command.name.startsWith('cd.')
      || /^[a-z]:$/i.test(command.name) || command.name === 'call' || command.name === 'pushd' || command.name === 'popd') {
      cwdKnown = false
      continue
    }

    if (command.name === 'subst') {
      const subst = /^([a-z]):\s+\.\\?$/i.exec(command.args)
      if (!cwdKnown || !subst) continue
      const drive = subst[1]!.toLowerCase()
      if (taken.has(drive)) continue
      taken.add(drive)
      mounts.push(hostDir ? `mount ${drive} ./${hostDir}` : `mount ${drive} .`)
      parts[index] = `REM 8bitgo: SUBST ${drive.toUpperCase()}: replaced by MOUNT`
      notes.push(`subst ${drive}: → mount ${drive}`)
      changed = true
      continue
    }

    if (MOUSE_DRIVERS.has(command.name)) {
      const candidates = command.name.includes('.') ? [command.name] : [`${command.name}.com`, `${command.name}.exe`]
      if (!candidates.some((name) => options.fileExists(`${dir}${name}`))) continue
      parts[index] = `REM 8bitgo: ${command.name.toUpperCase()} skipped, DOSBox has a built-in mouse driver`
      notes.push(`skip ${command.name}`)
      changed = true
    }
  }

  if (!changed) return none
  return { bytes: binaryToBytes(parts.join('')), mounts, notes }
}

/** 从 autoexec 片段里读出已经被挂载的盘符 */
export function dosMountedDrives(commands: string | undefined): string[] {
  const drives: string[] = []
  for (const line of (commands ?? '').split(/\r?\n/)) {
    const match = /^\s*@?\s*(?:mount|imgmount)\s+([a-z])(?::)?\s/i.exec(line)
    if (match) drives.push(match[1]!.toLowerCase())
  }
  return drives
}
