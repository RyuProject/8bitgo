import { readZipFile, type ExtraFile } from '@/lib/jsdosBundle'
import { mergeDosboxConfigOverride } from '../../shared/dosbox-config.js'

/** 原版 Caesar III 的 c3.inf 结构：resolutionId 是从 1 开始的 640/800/1024 三档。 */
const CAESAR3_RESOLUTION_OFFSET = 16
const CAESAR3_RESOLUTION_800 = 2
const CAESAR3_INF_SIZE = 560

const normalizedSlug = (slug?: string): string => slug?.trim().toLowerCase() ?? ''

/**
 * StarCraft 1.16.1 的便携目录仍会从注册表读取安装盘和资料盘路径。原压缩包附带的
 * RegSetup.exe 会弹成功对话框，网页自动启动无法可靠替玩家确认；静默导入同包的 STAR.REG
 * 能在 EXE 读取数据前完成，而且整包与 Sockdrive 都走同一条启动批处理。
 */
export function windowsGameCompatibilityRegistryImport(
  gameSlug: string | undefined,
  executable: string,
): string | undefined {
  const slug = normalizedSlug(gameSlug)
  if (slug !== 'starcraft' && slug !== 'starcraft-1-16-1') return undefined
  const file = executable.trim().replace(/\\/g, '/').split('/').pop()?.toLowerCase()
  if (file !== 'starcraft.exe') throw new Error('StarCraft 的 Windows 自启动程序必须是 StarCraft.exe')
  return 'STAR.REG'
}

/**
 * StarCraft 1.16.1 的 DirectDraw 菜单在这份 Win95 镜像里会偶发停在全黑主表面；进程并没崩，
 * Ctrl+Esc 失焦后再 Alt+Tab 回来就会立刻重建调色板。把判定收在这里，避免给所有 Windows
 * 游戏乱发系统切换键；EXE 校验复用注册表规则，第三方启动器仍然不会被误放行。
 */
export function windowsGameNeedsDirectDrawFocusRefresh(
  gameSlug: string | undefined,
  executable: string,
): boolean {
  return windowsGameCompatibilityRegistryImport(gameSlug, executable) === 'STAR.REG'
}

/**
 * StarCraft 1.16.1 在 Win95 + DOSBox-X 下用 normal core 已完成主菜单和 Brood War 建档实测。
 * 共享系统盘的 auto 会随宿主选择不同执行核心，旧版 DirectDraw 程序可能在部分设备上无报错退回
 * 桌面；这里把已验证配置作为游戏级默认值，同时让后台显式配置保留最终决定权。
 */
export function windowsGameCompatibilityDosboxConfig(
  gameSlug: string | undefined,
  executable: string | undefined,
  override: string | undefined,
): string | undefined {
  const slug = normalizedSlug(gameSlug)
  if (slug !== 'starcraft' && slug !== 'starcraft-1-16-1') return override
  windowsGameCompatibilityRegistryImport(gameSlug, executable ?? '')
  return mergeDosboxConfigOverride('[cpu]\ncore=normal', override)
}

/**
 * 生成 Windows 客体游戏在挂盘前要合并的兼容文件。
 *
 * Caesar III 的游戏包里 `c3.inf` 把 resolutionId 存成了 3（1024×768），但共享 Win95
 * 桌面与 DOSBox-X 帧缓冲是 800×600。老 DirectDraw 会把 1024×768 的画面缩进 800×600，
 * Windows 集成鼠标却仍按桌面坐标上报，于是游戏画出的光标和按钮命中点使用两套比例：
 * 越靠右下偏得越远。把它改成 2 等同游戏内按 F8，而且在 EXE 启动前就生效，不依赖脆弱的
 * 定时模拟按键，也不会先让玩家看到一次错误分辨率。
 *
 * 返回的仍是 extras，让适配器和后台附加文件只重打一次 ZIP；一份八十多 MB 的 ROM 若先合并
 * extras 再单独打补丁，会在手机上平白多出一整包的内存峰值。
 */
export async function windowsGameCompatibilityExtras(
  gameSlug: string | undefined,
  executable: string,
  rom: ArrayBuffer,
  extras: readonly ExtraFile[],
): Promise<readonly ExtraFile[]> {
  if (normalizedSlug(gameSlug) !== 'caesar-3') return extras

  const executablePath = executable.trim().replace(/\\/g, '/').replace(/^\/+/, '')
  const slash = executablePath.lastIndexOf('/')
  const infPath = slash >= 0 ? `${executablePath.slice(0, slash)}/c3.inf` : 'c3.inf'
  const existingAt = extras.findIndex((file) => file.path.replace(/\\/g, '/').toLowerCase() === infPath.toLowerCase())
  const fromExtra = existingAt >= 0 ? extras[existingAt] : null
  const source = fromExtra ? { path: fromExtra.path, data: fromExtra.data } : await readZipFile(rom, infPath)
  if (!source) throw new Error(`Caesar III 游戏包缺少分辨率设置文件：${infPath}`)
  if (source.data.byteLength !== CAESAR3_INF_SIZE) {
    throw new Error(`Caesar III 的 c3.inf 长度异常（${source.data.byteLength}，应为 ${CAESAR3_INF_SIZE}）`)
  }

  const current = new DataView(source.data.buffer, source.data.byteOffset, source.data.byteLength)
    .getInt32(CAESAR3_RESOLUTION_OFFSET, true)
  if (current === CAESAR3_RESOLUTION_800) return extras
  if (current < 1 || current > 3) {
    throw new Error(`Caesar III 的分辨率编号异常：${current}`)
  }

  const patched = source.data.slice() as Uint8Array<ArrayBuffer>
  new DataView(patched.buffer, patched.byteOffset, patched.byteLength)
    .setInt32(CAESAR3_RESOLUTION_OFFSET, CAESAR3_RESOLUTION_800, true)
  const replacement: ExtraFile = { path: source.path, data: patched }
  if (existingAt < 0) return [...extras, replacement]
  return extras.map((file, index) => (index === existingAt ? replacement : file))
}
