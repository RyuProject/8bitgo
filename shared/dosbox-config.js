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

/**
 * 选项名的规范形式：小写、下划线/连字符/连续空格一律折叠成一个空格。
 *
 * DOSBox-X 两种命名风格混着用 —— `mouse_emulation` 是下划线，
 * `convert fat free space` / `integration device` 是空格。下面那张保护表要是按字面比，
 * 换一种写法就绕过去了；就算今天 DOSBox-X 只认其中一种，也不该让保护依赖这件事。
 *
 * ⚠️ 只用来判断「拦不拦」和「重不重复」。真正写进配置的仍然是管理员原样敲的那串 ——
 * 哪个拼法有效是 DOSBox 自己的事，我们不替它改。
 */
function canonicalKey(key) {
  return String(key).replace(/[\s_-]+/g, ' ').trim()
}

/** 键名（已规范化）→ 由站点统一管理，逐游戏配置不许碰 */
const protectedKeys = new Map([
  // 鼠标相对 / 绝对模式仍由“DOS 射击类”规则控制，不能借高级配置偷偷恢复逐游戏覆盖。
  ['sdl', new Set(['autolock', 'mouse emulation', 'usesystemcursor'])],
  // 这个值保证动态游戏盘不会被一个小 ZIP 扩成几百 MB；windowsGuest.ts 会强制写入。
  ['dosbox', new Set(['convert fat free space'])],
  /*
    集成设备是 Windows 客体那条路的硬前提：共享镜像的 SYSTEM.INI 里
    `mouse.drv=dboxmpi.drv`（DOSBox-X Mouse Pointer Integration）就指着它。
    关掉之后鼠标会退回相对模式，Windows 里的指针跟手不一致 —— 而且是**静默**的，
    没有任何报错，只有玩家觉得“这游戏鼠标很飘”。逐游戏没有任何正当理由关它。
  */
  ['cpu', new Set(['integration device'])],
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
    if (keys.has(canonicalKey(key))) fail(lineNo, `配置项 ${key} 重复出现`)
    if (protectedKeys.get(section)?.has(canonicalKey(key))) fail(lineNo, `配置项 [${section}] ${key} 由站点统一管理`)
    keys.add(canonicalKey(key))
    entries.push({ section, key, value, line: lineNo })
  }

  return { entries }
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
  /*
    ⚠️ 按规范形式比，不按字面比。基础配置里写的是 `hard drive data rate limit=0`，
    管理员要是敲成 `hard_drive_data_rate_limit=0`，字面匹配找不到那一行，就会在同一个
    section 里**再追加一行**：两行同名、DOSBox 只认其中一种，看起来配置生效了其实没有。
  */
  const wanted = canonicalKey(key)
  const at = lines.findIndex((line, i) => {
    if (i <= start || i >= end) return false
    const eq = line.indexOf('=')
    return eq > 0 && canonicalKey(line.slice(0, eq).trim().toLowerCase()) === wanted
  })
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
