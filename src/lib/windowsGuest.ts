/**
 * 共享 Windows 3.x / 9x 系统镜像的启动配置。
 *
 * js-dos 支持把多个 bundle 依次叠进同一个虚拟文件系统；DOSBox-X 又能在 boot 时把
 * 一个目录动态转换成客体系统可见的 FAT 硬盘。两者合起来，系统镜像与每款游戏就不必
 * 再打成一个近百 MB 的包：系统层提供 qcow2/img，游戏层只提供 GAME/ 下的文件。
 */
import { assertValidZip, extractZipEntry } from './unzip'
import { WINDOWS_GAME_ROOT, WINDOWS_LAUNCHER_PATH } from './jsdosBundle'
import { mergeDosboxConfigOverride } from '../../shared/dosbox-config.js'

const td = new TextDecoder()
const te = new TextEncoder()
const DRIVE_CANDIDATES = 'DEFGHIJKLMNOPQRSTUVWXYZ'

/** 从 .jsdos 中读出系统自己的 dosbox.conf；系统镜像的硬件参数一行都不能凭空重造。 */
export async function readWindowsSystemConfig(buf: ArrayBuffer): Promise<string> {
  const entries = assertValidZip(buf, 'Windows 系统 JSDOS')
  const entry = entries.find((item) => item.name.toLowerCase() === '.jsdos/dosbox.conf')
  if (!entry) throw new Error('Windows 系统镜像缺少 .jsdos/dosbox.conf')
  if (entry.uncompressedSize > 1024 * 1024) throw new Error('Windows 系统镜像的 dosbox.conf 大小异常')
  const conf = td.decode(await extractZipEntry(buf, entry)).replace(/\r\n?/g, '\n')
  if (!/^\s*\[autoexec\]\s*$/im.test(conf)) throw new Error('Windows 系统镜像的 dosbox.conf 缺少 [autoexec]')
  return conf
}

function mountedDriveLetters(autoexec: string[]): Set<string> {
  const used = new Set<string>()
  for (const line of autoexec) {
    const hit = line.match(/^\s*(?:mount|imgmount)\s+([a-z]):?(?:\s|$)/i)
    if (hit) used.add(hit[1].toUpperCase())
    /*
      DOSBox-X 也接受硬盘序号：2=C、3=D……Sockdrive 官方示例就是 `imgmount 2 sockdrive`。
      若这里只认字母，系统镜像已经占着 D: 时仍会重复挑中 D:，直到客体启动后才报挂载冲突。
    */
    const numeric = line.match(/^\s*imgmount\s+(\d+)(?:\s|$)/i)
    const index = Number(numeric?.[1])
    if (Number.isInteger(index) && index >= 2 && index <= 25) {
      used.add(String.fromCharCode(65 + index))
    }
  }
  return used
}

function setSectionOption(lines: string[], section: string, key: string, value: string): string[] {
  const header = `[${section.toLowerCase()}]`
  const start = lines.findIndex((line) => line.trim().toLowerCase() === header)
  if (start < 0) return [...lines, '', `[${section}]`, `${key}=${value}`]
  let end = lines.length
  for (let i = start + 1; i < lines.length; i++) {
    if (/^\s*\[[^\]]+\]\s*$/.test(lines[i])) {
      end = i
      break
    }
  }
  const option = new RegExp(`^\\s*${key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*=`, 'i')
  const at = lines.findIndex((line, i) => i > start && i < end && option.test(line))
  if (at >= 0) {
    const next = [...lines]
    next[at] = `${key}=${value}`
    return next
  }
  return [...lines.slice(0, end), `${key}=${value}`, ...lines.slice(end)]
}

export interface WindowsGuestConfig {
  dosboxConf: string
  /** 动态游戏盘在客体 Windows 中的盘符。 */
  gameDrive: string
  /** Windows“运行”对话框要打开的固定批处理路径。 */
  launcher: string
}

export interface WindowsSockdriveGuestConfig extends WindowsGuestConfig {
  /** js-dos 静态 Sockdrive 的目录 URL；运行时会在它后面请求 sockdrive.metaj 与 *.raw。 */
  sockdriveUrl: string
  /** 挂游戏盘用的硬盘序号（2=C、3=D……）。 */
  gameDriveIndex: number
}

export function normalizeSockdriveUrl(value: string): string {
  const raw = value.trim().replace(/\/+$/, '')
  // URL 会直接落进 [autoexec]；空白、引号或换行都会把后半段变成另一条 DOS 命令。
  // eslint-disable-next-line no-control-regex
  if (!raw || /[\x00-\x20"']/.test(raw)) throw new Error('Sockdrive 目录 URL 含空白、引号或控制字符')
  let parsed: URL
  try {
    parsed = new URL(raw)
  } catch {
    throw new Error('Sockdrive 必须是完整的 HTTP(S) 目录 URL')
  }
  if (!/^https?:$/.test(parsed.protocol) || parsed.username || parsed.password) {
    throw new Error('Sockdrive 必须是没有账号口令的 HTTP(S) 目录 URL')
  }
  // js-dos 会直接拼 `${url}/sockdrive.metaj`；查询串或锚点会把文件名拼到错误的位置。
  if (parsed.search || parsed.hash) throw new Error('Sockdrive 目录 URL 不能带查询参数或锚点')
  const normalized = parsed.toString().replace(/\/+$/, '')
  /*
    URL 会成为 [autoexec] 的一条命令参数；这一层等同批处理，%、&、管道/重定向符和括号可能被
    COMMAND.COM 展开或拆成另一条命令。版本目录统一用 ASCII slug，别靠运行时猜怎么转义 URL。
  */
  if (/[%&|<>^()]/.test(normalized)) {
    throw new Error('Sockdrive 目录 URL 含 DOS 批处理不能安全传递的字符')
  }
  /*
    js-dos 8.4.1 用 URL 清洗后的前 200 个字符当 OPFS 目录名。若完整 URL 超过这条线，
    版本号恰好在截断位置之后时 v1 / v2 会命中同一个缓存目录，把两代磁盘块拼在一起。
    与其让客体文件系统随机损坏，不如在第一次启动前明确拒绝过长地址。
  */
  if (normalized.replace(/^https?:\/\//i, '').length > 200) {
    throw new Error('Sockdrive 完整 URL 过长；js-dos 的本地块缓存会截断并可能混入旧版本')
  }
  return normalized
}

/**
 * Sockdrive 存档是“某个基础磁盘之上的扇区差异”，不能只按游戏 slug 归档。
 * v1 的差异套到 v2 可能改写完全不同的扇区，因此把规范 URL 的 64 位指纹写进存档键；版本升级时
 * 自动开新档，旧档仍原样保留。这里不需要密码学用途，两路 FNV-1a 只为把 URL 稳定压到短键里。
 */
export function sockdriveVersionedSaveKey(gameKey: string, sockdriveUrl: string): string {
  const url = normalizeSockdriveUrl(sockdriveUrl)
  const hash = (seed: number) => {
    let value = seed >>> 0
    for (let i = 0; i < url.length; i++) {
      value = Math.imul(value ^ url.charCodeAt(i), 0x01000193) >>> 0
    }
    return value.toString(16).padStart(8, '0')
  }
  // 云存档 game_slug 是 VARCHAR(160)，给 `:sd:` + 16 位指纹预留 20 个字符。
  const cleanGameKey = gameKey
    .trim()
    // eslint-disable-next-line no-control-regex -- 云存档路由明确不接受这些字符，必须稳定替换而非删除。
    .replace(/[/\\\x00-\x1f\x7f]/g, '_')
  const safeGameKey = Array.from(cleanGameKey).slice(0, 140).join('') || 'game'
  return `${safeGameKey}:sd:${hash(0x811c9dc5)}${hash(0x9e3779b9)}`
}

function safeStreamedExecutable(executable: string): string {
  const path = executable.replace(/\\/g, '/').replace(/^(?:\.\/)+/, '').replace(/^\/+|\/+$/g, '')
  if (
    !path ||
    !/\.exe$/i.test(path) ||
    /^[a-z]:/i.test(path) ||
    path.split('/').some((part) => !part || part === '.' || part === '..') ||
    // eslint-disable-next-line no-control-regex
    /[\x00-\x1f:"<>|?*]/.test(path)
  ) {
    throw new Error('流式 Windows 自启动程序必须是游戏盘内安全的 .exe 相对路径')
  }
  return path
}

/**
 * 流式游戏盘不再有一份本地游戏 ZIP 可改写，因此把极小的启动批处理放在单独的本地盘。
 * 它只负责切到远程游戏盘、进入 EXE 所在目录再启动；游戏数据仍全部从 Sockdrive 按块读取。
 */
export function windowsSockdriveLauncherFile(
  executable: string,
  drive: string,
): { path: string; contents: Uint8Array<ArrayBuffer> } {
  const actual = safeStreamedExecutable(executable)
  if (!/^[d-z]$/i.test(drive)) throw new Error('Sockdrive 游戏盘符必须是 D-Z')
  const slash = actual.lastIndexOf('/')
  const dir = slash >= 0 ? `\\${actual.slice(0, slash).replace(/\//g, '\\')}` : '\\'
  const file = actual.slice(slash + 1)
  /*
    FAT 文件名允许 & 和 %，但批处理把前者当命令分隔、后者当环境变量。路径一律加引号，
    并把 % 写成 %% 得到字面量，避免合法游戏目录意外执行成两条命令。
  */
  const quote = (value: string) => `"${value.replace(/%/g, '%%')}"`
  const contents = te.encode([
    '@echo off',
    `${drive.toLowerCase()}:`,
    `cd ${quote(dir)}`,
    quote(file),
    'exit',
  ].join('\r\n') + '\r\n') as Uint8Array<ArrayBuffer>
  return { path: '8BITGO/RUN.BAT', contents }
}

/**
 * Windows 3.x 的 DOS 会话不能反向启动 16 位 Windows 图形程序：RUN.BAT 会正常结束，
 * 但其中的游戏 EXE 只会得到“需要 Microsoft Windows”。这里把完整 EXE 路径交给
 * Windows 启动器，由它借 File Manager 设置工作目录；Windows 95/98 继续用批处理。
 */
export function windowsGuestLaunchCommand(
  guest: Pick<WindowsGuestConfig, 'gameDrive' | 'launcher'>,
  executable: string,
  version: '3x' | '9x' = '9x',
  /**
   * 盘根有没有收窄到 EXE 那一层（见 makeWindowsGameLayer 的 singleDir）。
   * 收窄了就只敲文件名；没收窄就得把子目录一起敲进去，否则 File > Run 在盘根上找不到它。
   */
  narrowedToExeDir = true,
): string {
  if (version !== '3x') return guest.launcher
  const path = executable.replace(/\\/g, '/').replace(/^\/+/, '')
  const file = path.split('/').pop()
  if (!file) throw new Error('Windows 3.x 自启动程序文件名为空')
  return `${guest.gameDrive}:\\${(narrowedToExeDir ? file : path).replace(/\//g, '\\')}`
}

/**
 * 保留系统镜像的全部硬件配置，只接管 [autoexec] 的最后两步：挂游戏盘、启动客体系统。
 *
 * 原镜像可能用 imgmount 2，也可能直接 imgmount c；我们不猜、不改那些命令，只把已有
 * BOOT 移到最后并加 -convertfat。盘符从未占用的 D-Z 里挑，因此未来换带 CD-ROM 的
 * Win98 镜像也不会因为 D: 已存在而互相踩。
 */
export function buildWindowsGuestConfig(
  base: string,
  configOverride?: string,
  gameRoot = WINDOWS_GAME_ROOT,
): WindowsGuestConfig {
  const cleanGameRoot = gameRoot.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '')
  if (!cleanGameRoot || cleanGameRoot.split('/').some((part) => part === '.' || part === '..' || !/^[a-z0-9_.-]+$/i.test(part))) {
    throw new Error('Windows 游戏挂载目录必须是安全的 DOS 路径')
  }
  let lines = base.replace(/\r\n?/g, '\n').split('\n')
  const autoAt = lines.findIndex((line) => /^\s*\[autoexec\]\s*$/i.test(line))
  if (autoAt < 0) throw new Error('Windows 系统镜像的 dosbox.conf 缺少 [autoexec]')

  // 通常 [autoexec] 在文件最后，但可复用的系统镜像不能依赖这个习惯；若后面还有 section，
  // mount / boot 必须插在它前面，否则命令会落进别的配置节，DOSBox-X 根本不会执行。
  const nextSectionOffset = lines.slice(autoAt + 1).findIndex((line) => /^\s*\[[^\]]+\]\s*$/.test(line))
  const autoEnd = nextSectionOffset < 0 ? lines.length : autoAt + 1 + nextSectionOffset
  const autoexec = lines.slice(autoAt + 1, autoEnd)
  if (!autoexec.some((line) => /^\s*imgmount\b/i.test(line))) {
    throw new Error('Windows 系统镜像没有在 [autoexec] 中挂载硬盘镜像')
  }
  const used = mountedDriveLetters(autoexec)
  const gameDrive = [...DRIVE_CANDIDATES].find((drive) => !used.has(drive))
  if (!gameDrive) throw new Error('Windows 系统镜像没有空闲盘符可挂载游戏')

  let bootDrive = 'C:'
  for (const line of autoexec) {
    const hit = line.match(/^\s*boot\s+([a-z]:)/i)
    if (hit) bootDrive = hit[1].toUpperCase()
  }
  const withoutBoot = autoexec.filter((line) => !/^\s*boot\b/i.test(line))
  lines = [
    ...lines.slice(0, autoAt + 1),
    ...withoutBoot,
    '',
    // -freesize 与 convert fat free space 双保险，避免一个 800KB 游戏被扩成 250MB 的临时盘。
    `mount ${gameDrive.toLowerCase()} ${cleanGameRoot} -freesize 16`,
    `boot ${bootDrive.toLowerCase()} -convertfat`,
    ...lines.slice(autoEnd),
  ]
  lines = setSectionOption(lines, 'dosbox', 'convert fat free space', '16')

  const generated = `${lines.join('\n').replace(/\n+$/, '')}\n`
  return {
    // 覆盖最后应用，但解析器会拒绝 [autoexec] 和关键挂载参数，所以管理员只能调整硬件配置。
    dosboxConf: mergeDosboxConfigOverride(generated, configOverride),
    gameDrive,
    launcher: `${gameDrive}:\\${WINDOWS_LAUNCHER_PATH.replace(/\//g, '\\')}`,
  }
}

/**
 * 保留共享系统镜像，只把每款大型游戏改成静态 Sockdrive。
 *
 * 游戏盘必须用 `imgmount <序号> sockdrive <目录>`，不能用普通 mount：前者按扇区懒加载，
 * 后者只能看到已经下载到浏览器文件系统里的完整文件。启动批处理另挂一个极小的本地盘，
 * 避免为了写 RUN.BAT 又去修改、复制或重新发布那块远程磁盘。
 */
export function buildSockdriveWindowsGuestConfig(
  base: string,
  sockdriveUrl: string,
  configOverride?: string,
): WindowsSockdriveGuestConfig {
  let lines = base.replace(/\r\n?/g, '\n').split('\n')
  const autoAt = lines.findIndex((line) => /^\s*\[autoexec\]\s*$/i.test(line))
  if (autoAt < 0) throw new Error('Windows 系统镜像的 dosbox.conf 缺少 [autoexec]')
  const nextSectionOffset = lines.slice(autoAt + 1).findIndex((line) => /^\s*\[[^\]]+\]\s*$/.test(line))
  const autoEnd = nextSectionOffset < 0 ? lines.length : autoAt + 1 + nextSectionOffset
  const autoexec = lines.slice(autoAt + 1, autoEnd)
  if (!autoexec.some((line) => /^\s*imgmount\b/i.test(line))) {
    throw new Error('Windows 系统镜像没有在 [autoexec] 中挂载硬盘镜像')
  }

  const used = mountedDriveLetters(autoexec)
  const gameDrive = [...DRIVE_CANDIDATES].find((drive) => !used.has(drive))
  if (!gameDrive) throw new Error('Windows 系统镜像没有空闲盘符可挂载流式游戏盘')
  used.add(gameDrive)
  const launcherDrive = [...DRIVE_CANDIDATES].find((drive) => !used.has(drive))
  if (!launcherDrive) throw new Error('Windows 系统镜像没有空闲盘符可挂载启动文件')

  let bootDrive = 'C:'
  for (const line of autoexec) {
    const hit = line.match(/^\s*boot\s+([a-z]:)/i)
    if (hit) bootDrive = hit[1].toUpperCase()
  }
  const withoutBoot = autoexec.filter((line) => !/^\s*boot\b/i.test(line))
  const gameDriveIndex = gameDrive.charCodeAt(0) - 65
  const normalizedUrl = normalizeSockdriveUrl(sockdriveUrl)
  lines = [
    ...lines.slice(0, autoAt + 1),
    ...withoutBoot,
    '',
    `imgmount ${gameDriveIndex} sockdrive ${normalizedUrl}`,
    `mount ${launcherDrive.toLowerCase()} 8BITGO -freesize 1`,
    `boot ${bootDrive.toLowerCase()} -convertfat`,
    ...lines.slice(autoEnd),
  ]
  lines = setSectionOption(lines, 'dosbox', 'convert fat free space', '16')

  const generated = `${lines.join('\n').replace(/\n+$/, '')}\n`
  return {
    dosboxConf: mergeDosboxConfigOverride(generated, configOverride),
    gameDrive,
    gameDriveIndex,
    launcher: `${launcherDrive}:\\RUN.BAT`,
    sockdriveUrl: normalizedUrl,
  }
}
