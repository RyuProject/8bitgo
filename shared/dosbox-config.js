/**
 * DOSBox-X 游戏级配置覆盖。
 *
 * 这份模块同时给浏览器和 Express 使用，规则必须只有一个来源：只在后台校验会让人绕过
 * 前端直接写入危险配置，只在播放器校验又会出现“保存成功、进游戏才报错”的假成功。
 */

export const DOSBOX_CONFIG_MAX_LENGTH = 16 * 1024

/**
 * 只开放硬件与性能相关的配置段。DOSBox-X 还有 [autoexec] / [config] / [4dos] 等能执行
 * 客体命令的段，它们由站点负责挂载游戏盘和启动 Windows，不能交给单款游戏覆盖。
 */
export const DOSBOX_CONFIG_ALLOWED_SECTIONS = Object.freeze([
  'sdl',
  'dosbox',
  'render',
  'cpu',
  'mixer',
  'midi',
  'sblaster',
  'gus',
  'speaker',
  'joystick',
  'serial',
  'ipx',
])

const allowedSections = new Set(DOSBOX_CONFIG_ALLOWED_SECTIONS)
const protectedKeys = new Map([
  // 鼠标相对 / 绝对模式仍由“DOS 射击类”规则控制，不能借高级配置偷偷恢复逐游戏覆盖。
  ['sdl', new Set(['autolock', 'mouse_emulation', 'usesystemcursor'])],
  // 这个值保证动态游戏盘不会被一个小 ZIP 扩成几百 MB；windowsGuest.ts 会强制写入。
  ['dosbox', new Set(['convert fat free space'])],
])

function fail(line, message) {
  throw new Error(`DOSBox-X 配置第 ${line} 行：${message}`)
}

/** 统一换行与行尾空白，避免同一份配置在浏览器和 MySQL 之间反复产生无意义差异。 */
export function normalizeDosboxConfigOverride(input) {
  if (input == null) return ''
  const text = String(input)
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.trimEnd())
    .join('\n')
    .trim()
  if (!text) return ''
  parseDosboxConfigOverride(text)
  return text
}

/**
 * 解析一份只含覆盖项的 INI。返回小写 section / key，合并时大小写不敏感。
 * 注释允许保存在后台文本中，但不会写进最终系统配置；真正生效的只有 key=value。
 */
export function parseDosboxConfigOverride(input) {
  const text = String(input ?? '').replace(/\r\n?/g, '\n')
  if (text.length > DOSBOX_CONFIG_MAX_LENGTH) {
    throw new Error(`DOSBox-X 配置不能超过 ${DOSBOX_CONFIG_MAX_LENGTH / 1024} KB`)
  }

  const entries = []
  const seenSections = new Set()
  const seenKeys = new Map()
  let section = ''
  const lines = text.split('\n')

  for (let i = 0; i < lines.length; i++) {
    const lineNo = i + 1
    const raw = lines[i]
    const line = raw.trim()
    if (!line || line.startsWith('#') || line.startsWith(';')) continue
    // eslint-disable-next-line no-control-regex
    if (/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(raw)) fail(lineNo, '包含控制字符')

    const sectionHit = line.match(/^\[([^\]]+)\]$/)
    if (sectionHit) {
      section = sectionHit[1].trim().toLowerCase()
      if (!/^[a-z0-9][a-z0-9 _.-]{0,63}$/.test(section)) fail(lineNo, '配置段名称格式不正确')
      if (!allowedSections.has(section)) fail(lineNo, `不允许编辑 [${section}] 配置段`)
      if (seenSections.has(section)) fail(lineNo, `配置段 [${section}] 重复出现`)
      seenSections.add(section)
      seenKeys.set(section, new Set())
      continue
    }

    if (!section) fail(lineNo, '配置项必须写在 [配置段] 下面')
    const equalAt = raw.indexOf('=')
    if (equalAt < 1) fail(lineNo, '配置项必须使用 key=value 格式')
    const key = raw.slice(0, equalAt).trim().toLowerCase()
    const value = raw.slice(equalAt + 1).trim()
    if (!/^[a-z0-9][a-z0-9 _.-]{0,79}$/.test(key)) fail(lineNo, '配置项名称格式不正确')
    if (!value) fail(lineNo, `配置项 ${key} 不能为空`)
    if (value.length > 1024) fail(lineNo, `配置项 ${key} 的值过长`)
    const keys = seenKeys.get(section)
    if (keys.has(key)) fail(lineNo, `配置项 ${key} 重复出现`)
    if (protectedKeys.get(section)?.has(key)) fail(lineNo, `配置项 [${section}] ${key} 由站点统一管理`)
    keys.add(key)
    entries.push({ section, key, value, line: lineNo })
  }

  return { entries }
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** 在完整 dosbox.conf 中覆盖一个值；没有对应 section / key 时就补进去。 */
function setOption(lines, section, key, value) {
  const header = `[${section}]`
  const start = lines.findIndex((line) => line.trim().toLowerCase() === header)
  if (start < 0) return [...lines, '', header, `${key}=${value}`]

  let end = lines.length
  for (let i = start + 1; i < lines.length; i++) {
    if (/^\s*\[[^\]]+\]\s*$/.test(lines[i])) {
      end = i
      break
    }
  }
  const option = new RegExp(`^\\s*${escapeRegExp(key)}\\s*=`, 'i')
  const at = lines.findIndex((line, i) => i > start && i < end && option.test(line))
  if (at >= 0) {
    const next = [...lines]
    next[at] = `${key}=${value}`
    return next
  }
  return [...lines.slice(0, end), `${key}=${value}`, ...lines.slice(end)]
}

/** 把安全覆盖应用到系统镜像或 ROM 自带的完整 dosbox.conf。 */
export function mergeDosboxConfigOverride(base, override) {
  const normalizedOverride = normalizeDosboxConfigOverride(override)
  const normalizedBase = String(base ?? '').replace(/\r\n?/g, '\n')
  if (!normalizedOverride) return `${normalizedBase.replace(/\n+$/, '')}\n`

  let lines = normalizedBase.split('\n')
  for (const entry of parseDosboxConfigOverride(normalizedOverride).entries) {
    lines = setOption(lines, entry.section, entry.key, entry.value)
  }
  return `${lines.join('\n').replace(/\n+$/, '')}\n`
}
