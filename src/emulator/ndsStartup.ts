/**
 * melonDS DS 的浏览器启动修正。
 *
 * 上游桌面前端默认有可写的 system 目录，也能承受一张 4GB 的虚拟 SD 卡；EmulatorJS
 * 两条都不成立：它把 system_directory 留成根目录 `/`，melonDS DS 会把根目录归一成空串，
 * 随后报 `Failed to get system directory`；自制程序又默认创建 4GB SD 镜像，WASM 内存会在
 * 游戏真正启动前耗尽。两种失败最后都只剩 RetroArch 的 `No Items`，玩家看不到真正原因。
 *
 * 修法必须赶在 RetroArch `callMain()` 之前：给它一个真实的 system 子目录，并在首次启动
 * 没有玩家选项文件时写入适合网页的安全默认值。已有选项只补缺项，不覆盖玩家主动选择。
 */

export const NDS_SYSTEM_DIRECTORY = '/home/web_user/retroarch/userdata/system'
export const NDS_CORE_OPTIONS_PATH = '/home/web_user/retroarch/userdata/config/melonDS DS/melonDS DS.opt'

const SYSTEM_DIRECTORY_LINE = /^\s*system_directory\s*=/

/** 就地修正 RetroArch 的 system 目录；其它配置保持原样，重复执行幂等。 */
export function configureNdsSystemDirectory(cfg: string): string {
  const target = `system_directory = "${NDS_SYSTEM_DIRECTORY}"`
  if (!cfg.trim()) return target
  const lines = cfg.split('\n')
  let done = false
  const out = lines.map((line) => {
    if (!SYSTEM_DIRECTORY_LINE.test(line)) return line
    if (done) return ''
    done = true
    return target
  })
  if (!done) {
    if (out.length > 0 && out[out.length - 1].trim() === '') out[out.length - 1] = target
    else out.push(target)
  }
  return out.join('\n')
}

const SAFE_DEFAULTS = {
  // 站内 ROM 已在上传时解密；内置 BIOS 可运行且不要求玩家提供受版权保护的固件。
  melonds_sysfile_mode: 'builtin',
  // 浏览器无法合理创建上游默认的 4GB 虚拟卡；需要 DLDI 的自制程序仍可由玩家主动打开。
  melonds_homebrew_sdcard: 'disabled',
} as const

/**
 * 给 melonDS DS 的 `.opt` 补网页安全默认值。
 *
 * 只补不存在的 key：玩家已经在设置里选过 native BIOS 或启用虚拟 SD 时必须尊重其选择。
 * 选项文件格式由 RetroArch 定义为 `key = "value"`，未知行和注释都原样保留。
 */
export function configureNdsCoreOptions(options: string): string {
  const existing = new Set<string>()
  for (const line of options.split('\n')) {
    const match = line.match(/^\s*([A-Za-z0-9_-]+)\s*=/)
    if (match) existing.add(match[1])
  }
  const additions = Object.entries(SAFE_DEFAULTS)
    .filter(([key]) => !existing.has(key))
    .map(([key, value]) => `${key} = "${value}"`)
  if (!additions.length) return options
  if (!options.trim()) return `${additions.join('\n')}\n`
  return `${options.replace(/\n?$/, '\n')}${additions.join('\n')}\n`
}
