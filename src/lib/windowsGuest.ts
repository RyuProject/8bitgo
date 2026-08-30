/**
 * 共享 Windows 9x 系统镜像的启动配置。
 *
 * js-dos 支持把多个 bundle 依次叠进同一个虚拟文件系统；DOSBox-X 又能在 boot 时把
 * 一个目录动态转换成客体系统可见的 FAT 硬盘。两者合起来，系统镜像与每款游戏就不必
 * 再打成一个近百 MB 的包：系统层提供 qcow2/img，游戏层只提供 GAME/ 下的文件。
 */
import { assertValidZip, extractZipEntry } from './unzip'
import { WINDOWS_GAME_ROOT, WINDOWS_LAUNCHER_PATH } from './jsdosBundle'

const td = new TextDecoder()
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

/**
 * 保留系统镜像的全部硬件配置，只接管 [autoexec] 的最后两步：挂游戏盘、启动客体系统。
 *
 * 原镜像可能用 imgmount 2，也可能直接 imgmount c；我们不猜、不改那些命令，只把已有
 * BOOT 移到最后并加 -convertfat。盘符从未占用的 D-Z 里挑，因此未来换带 CD-ROM 的
 * Win98 镜像也不会因为 D: 已存在而互相踩。
 */
export function buildWindowsGuestConfig(base: string): WindowsGuestConfig {
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
    `mount ${gameDrive.toLowerCase()} ${WINDOWS_GAME_ROOT} -freesize 16`,
    `boot ${bootDrive.toLowerCase()} -convertfat`,
    ...lines.slice(autoEnd),
  ]
  lines = setSectionOption(lines, 'dosbox', 'convert fat free space', '16')

  return {
    dosboxConf: `${lines.join('\n').replace(/\n+$/, '')}\n`,
    gameDrive,
    launcher: `${gameDrive}:\\${WINDOWS_LAUNCHER_PATH.replace(/\//g, '\\')}`,
  }
}
