import { dosBackendOf, dosExecutableOf, dosExtrasOf, dosSockdriveOf, dosSystemOf, romsOf } from './mappers.js'
import { isVersionedSockdriveDirectory } from '../../shared/sockdrive-url.js'

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
  const rawSockdrives = game?.dosSockdrives && typeof game.dosSockdrives === 'object'
    ? Object.entries(game.dosSockdrives).filter(([, value]) => String(value || '').trim())
    : []
  const hasAnySockdrive = Boolean(rawSockdrive || rawSockdrives.length)
  const windowsGuest =
    String(game?.platform ?? '') === 'dos' &&
    dosBackendOf(game?.dosBackend) === 'dosboxX' &&
    Boolean(rawSystem)
  if (hasAnySockdrive && !windowsGuest) {
    return 'Sockdrive 只能用于已配置共享系统镜像的 DOSBox-X Windows 游戏'
  }
  if (!windowsGuest) return null

  const system = dosSystemOf(rawSystem)
  if (!system || !/\.jsdos(?:[?#].*)?$/i.test(system)) {
    return 'Windows 系统镜像必须是 .jsdos 文件、对象 key 或 URL'
  }

  const validateSockdrive = (raw, label = '') => {
    // 先报出可以直接修正的原因；mapper 也会拒绝这些值，但只返回“非法”会让后台很难定位。
    if (raw.startsWith('//')) return `${label}Sockdrive 目录不能使用 // 开头的协议相对地址`
    if (/^[a-z][a-z0-9+.-]*:/i.test(raw) && !/^https?:\/\//i.test(raw)) {
      return `${label}Sockdrive 完整地址只支持 HTTP 或 HTTPS`
    }
    if (/[?#]/.test(raw)) return `${label}Sockdrive 目录不能带查询参数或锚点`
    const sockdrive = dosSockdriveOf(raw)
    if (!sockdrive) return `${label}Sockdrive 目录不合法或超过 500 字符`
    if (/(?:^|\/)sockdrive\.metaj$/i.test(sockdrive) || /\.raw$/i.test(sockdrive)) {
      return `${label}Sockdrive 必须填写包含 sockdrive.metaj 的目录，不能填写某个文件`
    }
    if (!isVersionedSockdriveDirectory(sockdrive)) {
      return `${label}Sockdrive 目录必须以版本号或内容哈希结尾，且新版本必须使用新目录`
    }
    return null
  }
  if (rawSockdrive) {
    const problem = validateSockdrive(rawSockdrive)
    if (problem) return problem
  }

  const roms = romsOf(game)
  const slots = Object.entries(roms)
  if (!slots.length) return '共享 Windows 系统模式必须绑定游戏 ZIP'
  const perLanguageSockdrives = {}
  for (const [lang, rawValue] of rawSockdrives) {
    if (!Object.prototype.hasOwnProperty.call(roms, lang) || lang === '*') {
      return `${lang} 填了 Sockdrive，但没有对应语言的 ROM 完整回退包`
    }
    const raw = String(rawValue).trim()
    const problem = validateSockdrive(raw, `${lang}：`)
    if (problem) return problem
    perLanguageSockdrives[lang] = dosSockdriveOf(raw)
  }
  if (hasAnySockdrive && dosExtrasOf(game?.dosExtras)) {
    return '流式游戏盘不能现场合并 DOS 附加文件；请先把补丁写入磁盘再重新生成 Sockdrive'
  }
  // 逐语言配置一旦启用，未配置的语言必须走完整包；不能再偷偷落回可能属于另一语言的旧全局盘。
  const legacyGlobalActive = Boolean(rawSockdrive && Object.keys(perLanguageSockdrives).length === 0)
  const slotIsStreamed = (lang) => Boolean(
    lang === '*' ? rawSockdrive : perLanguageSockdrives[lang] || legacyGlobalActive
  )
  const streamedExecutableProblem = (value, streamed) => {
    const executable = dosExecutableOf(value)
    if (!streamed || !executable) return null
    if (!/\.exe$/i.test(executable) || /[:"<>|?*]/.test(executable)) {
      return `流式游戏盘的自启动程序必须是盘内安全的 .exe 相对路径：${executable}`
    }
    return null
  }
  const defaultExecutable = dosExecutableOf(game.dosExecutable)
  const perLanguage = game?.dosExecutables && typeof game.dosExecutables === 'object'
    ? game.dosExecutables
    : {}
  for (const [lang] of slots) {
    // 逐语言入口在播放器里优先于默认值；校验同样必须看最终真正会执行的那一条。
    const effective = lang === '*' ? defaultExecutable : dosExecutableOf(perLanguage[lang]) || defaultExecutable
    const problem = streamedExecutableProblem(effective, slotIsStreamed(lang))
    if (problem) return `${lang}：${problem}`
  }
  const missing = slots
    .filter(([lang]) => !(lang === '*' ? defaultExecutable : dosExecutableOf(perLanguage[lang]) || defaultExecutable))
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
  if (own(patch, 'dosExecutables') && own(patch, 'dosSockdrives')) return merged

  const before = romsOf(current)
  const after = romsOf(merged)
  const kept = {}
  const keptSockdrives = {}
  for (const [lang, key] of Object.entries(after)) {
    if (before[lang] !== key) continue
    const executable = current?.dosExecutables?.[lang]
    if (dosExecutableOf(executable)) kept[lang] = executable
    const sockdrive = current?.dosSockdrives?.[lang]
    if (dosSockdriveOf(sockdrive)) keptSockdrives[lang] = sockdrive
  }
  if (!own(patch, 'dosExecutables')) merged.dosExecutables = kept
  if (!own(patch, 'dosSockdrives')) merged.dosSockdrives = keptSockdrives
  return merged
}
