import { dosBackendOf, dosExecutableOf, dosSystemOf, romsOf } from './mappers.js'

const own = (value, key) => Object.prototype.hasOwnProperty.call(value ?? {}, key)

/**
 * 检查一款游戏能否按「共享 Windows 系统镜像 + 游戏 ZIP」启动。
 *
 * 这道校验必须放在服务端：后台表单虽然也会拦，但批量导入、旧脚本和直接 API 写入都能绕过表单。
 * 坏数据保存成功后，播放器要等系统镜像和游戏包都下载完才发现没有 EXE，代价是一次完整大文件下载。
 */
export function dosGameConfigError(game) {
  const rawSystem = String(game?.dosSystem ?? '').trim()
  const windowsGuest =
    String(game?.platform ?? '') === 'dos' &&
    dosBackendOf(game?.dosBackend) === 'dosboxX' &&
    Boolean(rawSystem)
  if (!windowsGuest) return null

  const system = dosSystemOf(rawSystem)
  if (!system || !/\.jsdos(?:[?#].*)?$/i.test(system)) {
    return 'Windows 系统镜像必须是 .jsdos 文件、对象 key 或 URL'
  }

  const roms = romsOf(game)
  const slots = Object.entries(roms)
  if (!slots.length) return '共享 Windows 系统模式必须绑定游戏 ZIP'
  if (dosExecutableOf(game.dosExecutable)) return null

  const perLanguage = game?.dosExecutables && typeof game.dosExecutables === 'object'
    ? game.dosExecutables
    : {}
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
