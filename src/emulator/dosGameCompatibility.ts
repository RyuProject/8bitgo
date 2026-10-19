import { readZipEntries, readZipFile, type ExtraFile } from '@/lib/jsdosBundle'

const DAGGERFALL_SLUG = 'the-elder-scrolls-ii-daggerfall'
const DAGGERFALL_CFG = 'Z.CFG'
const DAGGERFALL_DATA_PATH = 'c:\\arena2\\'
const DAGGERFALL_CD_PATH = 'd:\\dagger\\arena2\\'

/** 后台明确指定的入口优先；FALL.EXE 必须带 Z.CFG 参数才能读取原版安装配置。 */
export function dosGameCompatibilityExecutable(slug: string | undefined, executable: string | undefined): string | undefined {
  if (executable?.trim()) return executable
  return slug?.trim().toLowerCase() === DAGGERFALL_SLUG ? 'FALL.EXE' : executable
}

/** 不把参数塞进 EXE 路径，否则打包器找不到真正存在于 ZIP 的启动文件。 */
export function dosGameCompatibilityLaunchArguments(slug: string | undefined, configuredExecutable: string | undefined): readonly string[] {
  if (slug?.trim().toLowerCase() !== DAGGERFALL_SLUG) return []
  const configured = configuredExecutable?.trim().toLowerCase()
  return !configured || configured === 'fall.exe' ? ['Z.CFG'] : []
}

/** 包内已带原版 DFCD.iso；挂真实 ISO 才能读到安装目录没有的光盘素材。 */
export function dosGameCompatibilityStartupCommands(slug: string | undefined, commands: string | undefined): string | undefined {
  if (commands?.trim()) return commands
  return slug?.trim().toLowerCase() === DAGGERFALL_SLUG ? 'imgmount d DFCD.iso -t iso' : commands
}

/**
 * 《匕首雨》原包按 C:\DAGGER 与 D: 光盘安装，本站普通 DOS 包却直接挂在 C: 根。
 * FALL.EXE Z.CFG 会从配置指定的路径读取文件；安装目录仅 110 MB，原版 ISO 的 1500 多项
 * 光盘素材不能省。开局前用几百字节的附加文件覆盖旧安装路径，不解压重压游戏包。
 */
export async function dosGameCompatibilityExtras(
  slug: string | undefined,
  rom: ArrayBuffer,
  extras: readonly ExtraFile[],
): Promise<readonly ExtraFile[]> {
  if (slug?.trim().toLowerCase() !== DAGGERFALL_SLUG) return extras
  // 站长若已在后台放了自己验证过的 Z.CFG，不能再用内置兼容值盖掉它。
  if (extras.some((extra) => extra.path.replace(/\\/g, '/').toLowerCase() === DAGGERFALL_CFG.toLowerCase())) {
    return extras
  }

  if (!readZipEntries(rom)?.some((entry) => entry.name.toLowerCase() === 'dfcd.iso')) {
    throw new Error('Daggerfall 游戏包缺少 DFCD.iso 原版光盘镜像')
  }

  const source = await readZipFile(rom, DAGGERFALL_CFG)
  if (!source) throw new Error('Daggerfall 游戏包缺少 Z.CFG，无法定位 ARENA2 数据')
  if (source.data.byteLength > 4096) throw new Error('Daggerfall 的 Z.CFG 长度异常')
  const original = new TextDecoder().decode(source.data)
  const pathLine = /^path[ \t]+[^\r\n]*$/gim
  const cdLine = /^pathcd[ \t]+[^\r\n]*$/gim
  if ([...original.matchAll(pathLine)].length !== 1 || [...original.matchAll(cdLine)].length !== 1) {
    throw new Error('Daggerfall 的 Z.CFG 缺少唯一的 path / pathcd 设置')
  }
  const patched = original
    .replace(pathLine, `path ${DAGGERFALL_DATA_PATH}`)
    .replace(cdLine, `pathcd ${DAGGERFALL_CD_PATH}`)
  if (patched === original) return extras
  return [...extras, { path: source.path, data: new TextEncoder().encode(patched) }]
}
