import { readZipFile, type ExtraFile } from '@/lib/jsdosBundle'

/** 原版 Caesar III 的 c3.inf 结构：resolutionId 是从 1 开始的 640/800/1024 三档。 */
const CAESAR3_RESOLUTION_OFFSET = 16
const CAESAR3_RESOLUTION_800 = 2
const CAESAR3_INF_SIZE = 560

const normalizedSlug = (slug?: string): string => slug?.trim().toLowerCase() ?? ''

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
