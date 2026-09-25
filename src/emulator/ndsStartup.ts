/**
 * melonDS DS 的浏览器启动修正。
 *
 * 上游桌面前端默认有可写的 system 目录，也能承受一张 4GB 的虚拟 SD 卡；EmulatorJS
 * 两条都不成立：它把 system_directory 留成根目录 `/`，melonDS DS 会把根目录归一成空串，
 * 随后报 `Failed to get system directory`；自制程序又默认创建 4GB SD 镜像，WASM 内存会在
 * 游戏真正启动前耗尽。两种失败最后都只剩 RetroArch 的 `No Items`，玩家看不到真正原因。
 *
 * system 目录必须赶在 RetroArch `callMain()` 前修正；核心选项则要包住 callMain 内那次
 * 最终写入（见 installNdsCoreOptionsGuard）。安全默认值只补缺项，不覆盖玩家主动选择；
 * 站点自己管理的布局提示单独强制关闭，避免旧配置每次开局遮住画面。
 */

export const NDS_SYSTEM_DIRECTORY = '/home/web_user/retroarch/userdata/system'
export const NDS_CORE_OPTIONS_PATH = '/home/web_user/retroarch/userdata/config/melonDS DS/melonDS DS.opt'

export interface NdsCoreOptionsFs {
  readFile: (path: string) => Uint8Array | string
  writeFile: (path: string, data: string | Uint8Array) => void
}

export interface NdsCoreSettingsCallbacks {
  setupCoreSettingFile?: (path: string) => void
}

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

const MANAGED_OPTIONS = {
  /*
    站点会按容器横竖方向自动选布局，melonDS DS 随即把 `Layout 1/2` 画进游戏帧。
    这不是玩家需要处理的状态，而且会遮住上屏几秒；关掉的只是当前布局 OSD，
    `melonds_screen_layout*`、布局热键和触控坐标都不受影响。这里必须每次校正而非只补缺项：
    旧浏览器可能已经把上游默认的 enabled 存进 .opt，只补缺项会让老玩家永远看见它。
  */
  melonds_show_current_layout: 'disabled',
} as const

/**
 * 给 melonDS DS 的 `.opt` 补网页安全默认值。
 *
 * SAFE_DEFAULTS 只补不存在的 key：玩家已经选过 native BIOS 或启用虚拟 SD 时尊重其选择。
 * MANAGED_OPTIONS 每次校正：这些是站点已有 UI 的重复提示，不能让旧配置把它重新打开。
 * 选项文件格式由 RetroArch 定义为 `key = "value"`，未知行和注释都原样保留。
 */
export function configureNdsCoreOptions(options: string): string {
  const existing = new Set<string>()
  const managed = MANAGED_OPTIONS as Readonly<Record<string, string>>
  const managedWritten = new Set<string>()
  const lines = options.split('\n').map((line) => {
    const match = line.match(/^\s*([A-Za-z0-9_-]+)\s*=/)
    if (!match) return line
    const key = match[1]
    existing.add(key)
    const value = managed[key]
    if (value === undefined) return line
    // 同一个托管项若被写了多遍，只留一条，避免 RetroArch 的“最后一条赢”把它重新打开。
    if (managedWritten.has(key)) return ''
    managedWritten.add(key)
    return `${key} = "${value}"`
  })
  const additions = [...Object.entries(SAFE_DEFAULTS), ...Object.entries(MANAGED_OPTIONS)]
    .filter(([key]) => !existing.has(key))
    .map(([key, value]) => `${key} = "${value}"`)
  const normalized = lines.join('\n')
  if (!additions.length) return normalized
  if (!options.trim()) return `${additions.join('\n')}\n`
  return `${normalized.replace(/\n?$/, '\n')}${additions.join('\n')}\n`
}

type GuardedSetup = ((path: string) => void) & { __8bitgoNdsOptionsGuard?: boolean }

/**
 * 在 EmulatorJS 最后一次生成核心选项文件之后校正 melonDS DS 的网页安全值。
 *
 * 不能只在 `startGame()` / `callMain()` 前直接写 `.opt`：EmulatorJS 的
 * `setupPreLoadSettings()` 会注册 `Module.callbacks.setupCoreSettingFile`，核心进入
 * `retro_set_environment()` 时才调用它，并用 `getCoreSettings()` **覆盖同一路径**。
 * 也就是说，开局前回读完全正确仍不能证明核心最终吃到的是这份内容。
 *
 * 这里保留引擎原回调（玩家保存在 localStorage 的核心选项仍会先写进去），随后只补
 * 缺失的安全默认值并校正站点托管项。包裹失败只损失网页默认值，不能阻断游戏启动。
 */
export function installNdsCoreOptionsGuard(
  callbacks: NdsCoreSettingsCallbacks | null | undefined,
  fs: NdsCoreOptionsFs,
  onApplied?: (ok: boolean, error?: unknown) => void,
): boolean {
  const original = callbacks?.setupCoreSettingFile as GuardedSetup | undefined
  if (!callbacks || typeof original !== 'function') return false
  if (original.__8bitgoNdsOptionsGuard) return true

  const guarded: GuardedSetup = function (this: unknown, path: string) {
    // 原回调必须先跑：它负责把玩家真正保存过的选项写进文件，不能被站点默认值吞掉。
    original.call(this, path)
    if (path !== NDS_CORE_OPTIONS_PATH) return
    try {
      const raw = fs.readFile(path)
      const before = typeof raw === 'string' ? raw : new TextDecoder().decode(raw)
      const after = configureNdsCoreOptions(before)
      if (after !== before) fs.writeFile(path, after)
      const checkedRaw = fs.readFile(path)
      const checked = typeof checkedRaw === 'string' ? checkedRaw : new TextDecoder().decode(checkedRaw)
      const hasSafeDefaults = Object.keys(SAFE_DEFAULTS).every((key) =>
        new RegExp(`^\\s*${key}\\s*=`, 'm').test(checked),
      )
      const managedOk = Object.entries(MANAGED_OPTIONS).every(([key, value]) =>
        new RegExp(`^\\s*${key}\\s*=\\s*"${value}"\\s*$`, 'm').test(checked),
      )
      onApplied?.(hasSafeDefaults && managedOk)
    } catch (error) {
      onApplied?.(false, error)
    }
  }
  guarded.__8bitgoNdsOptionsGuard = true
  callbacks.setupCoreSettingFile = guarded
  return true
}
