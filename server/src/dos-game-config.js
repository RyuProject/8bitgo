import { dosBackendOf, dosExecutableOf, dosExtrasOf, dosSockdriveOf, dosSystemOf, romsOf } from './mappers.js'

const own = (value, key) => Object.prototype.hasOwnProperty.call(value ?? {}, key)

/**
 * 检查一款游戏能否按「共享 Windows 系统镜像 + 游戏 ZIP」启动。
 *
 * 这道校验必须放在服务端：后台表单虽然也会拦，但批量导入、旧脚本和直接 API 写入都能绕过表单。
 * 坏数据保存成功后，播放器要等系统镜像和游戏包都下载完才发现没有 EXE，代价是一次完整大文件下载。
 */
export function dosGameConfigError(game) {
  const rawSystem = String(game?.dosSystem ?? '').trim()
  const rawSockdrive = String(game?.dosSockdrive ?? '').trim()
  const windowsGuest =
    String(game?.platform ?? '') === 'dos' &&
    dosBackendOf(game?.dosBackend) === 'dosboxX' &&
    Boolean(rawSystem)
  if (rawSockdrive && !windowsGuest) {
    return 'Sockdrive 只能用于已配置共享系统镜像的 DOSBox-X Windows 游戏'
  }
  if (!windowsGuest) return null

  const system = dosSystemOf(rawSystem)
  if (!system || !/\.jsdos(?:[?#].*)?$/i.test(system)) {
    return 'Windows 系统镜像必须是 .jsdos 文件、对象 key 或 URL'
  }

  if (rawSockdrive) {
    // 先报出可以直接修正的原因；mapper 也会拒绝这些值，但只返回“非法”会让后台很难定位。
    if (rawSockdrive.startsWith('//')) return 'Sockdrive 目录不能使用 // 开头的协议相对地址'
    if (/^[a-z][a-z0-9+.-]*:/i.test(rawSockdrive) && !/^https?:\/\//i.test(rawSockdrive)) {
      return 'Sockdrive 完整地址只支持 HTTP 或 HTTPS'
    }
    if (/[?#]/.test(rawSockdrive)) return 'Sockdrive 目录不能带查询参数或锚点'
    const sockdrive = dosSockdriveOf(rawSockdrive)
    if (!sockdrive) return 'Sockdrive 目录不合法或超过 500 字符'
    if (/(?:^|\/)sockdrive\.metaj$/i.test(sockdrive) || /\.raw$/i.test(sockdrive)) {
      return 'Sockdrive 必须填写包含 sockdrive.metaj 的目录，不能填写某个文件'
    }
    if (dosExtrasOf(game?.dosExtras)) {
      return '流式游戏盘不能现场合并 DOS 附加文件；请先把补丁写入磁盘再重新生成 Sockdrive'
    }
  }

  const roms = romsOf(game)
  const slots = Object.entries(roms)
  if (!slots.length) return '共享 Windows 系统模式必须绑定游戏 ZIP'
  const streamedExecutableProblem = (value) => {
    const executable = dosExecutableOf(value)
    if (!rawSockdrive || !executable) return null
    if (!/\.exe$/i.test(executable) || /[:"<>|?*]/.test(executable)) {
      return `流式游戏盘的自启动程序必须是盘内安全的 .exe 相对路径：${executable}`
    }
    return null
  }
  const defaultExecutable = dosExecutableOf(game.dosExecutable)
  if (defaultExecutable) return streamedExecutableProblem(defaultExecutable)

  const perLanguage = game?.dosExecutables && typeof game.dosExecutables === 'object'
    ? game.dosExecutables
    : {}
  if (rawSockdrive) {
    for (const [lang] of slots) {
      const problem = streamedExecutableProblem(perLanguage[lang])
      if (problem) return `${lang}：${problem}`
    }
  }
  const missing = slots
    .filter(([lang]) => lang === '*' || !dosExecutableOf(perLanguage[lang]))
    .map(([lang]) => lang)
  if (!missing.length) return null

  return missing.includes('*')
    ? '共享 Windows 系统模式的通用 ROM 必须填写默认自启动 EXE'
    : `共享 Windows 系统模式缺少自启动 EXE：${missing.join('、')}`
}

/**
 * PATCH 的关联表语义不是普通对象合并：一旦请求带 rom / roms，就会整组重写语言槽；
 * 没带 dosExecutables 时，只有「对象 key 没变」的旧 EXE 才会保留。校验候选值必须模拟同一规则，
 * 否则换了 ZIP、旧 EXE 被仓储层清掉，路由却会拿旧对象误判为仍然完整。
 */
export function mergeGamePatchForDosValidation(current, patch) {
  const merged = { ...current, ...patch }
  const touchesRoms = own(patch, 'rom') || own(patch, 'roms')
  if (!touchesRoms) return merged

  delete merged.rom
  delete merged.roms
  if (own(patch, 'rom')) merged.rom = patch.rom
  if (own(patch, 'roms')) merged.roms = patch.roms
  if (own(patch, 'dosExecutables')) return merged

  const before = romsOf(current)
  const after = romsOf(merged)
  const kept = {}
  for (const [lang, key] of Object.entries(after)) {
    const executable = current?.dosExecutables?.[lang]
    if (before[lang] === key && dosExecutableOf(executable)) kept[lang] = executable
  }
  merged.dosExecutables = kept
  return merged
}
