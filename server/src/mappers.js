/**
 * 数据库行 <-> 前端对象 的转换（schema v2）。
 *
 * v2 把类型 / 标签 / ROM 拆成了关联表，所以一行 games 已经凑不出一个完整的 Game，
 * 必须把关联数据一起带上。对外接口刻意保持 v1 的 Game 形状不变 ——
 * 前端组件一行都不用改，变的只是数据怎么取。
 *
 * 关联数据一律**批量**装配（attachRelations）：一次列表查询只多打 3 条
 * WHERE game_id IN (...)，不会退化成每款游戏查三次的 N+1。
 */

import { normalizeDosboxConfigOverride } from '../../shared/dosbox-config.js'

const bool = (v) => v === 1 || v === true || v === '1'

/** 入库时统一逗号和空格，否则同一家公司会在开发商统计里被拆成多个名字。 */
function developersText(value) {
  const seen = new Set()
  return String(value ?? '')
    .split(/[,，]/)
    .map((name) => name.trim())
    .filter((name) => {
      if (!name) return false
      const key = name.toLocaleLowerCase()
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
    .join(', ')
}

/** DATE / TIMESTAMP -> 'YYYY-MM-DD'；mysql2 对 DATE 列返回的是 Date 对象 */
export function dateOnly(v) {
  if (!v) return ''
  if (v instanceof Date) {
    if (Number.isNaN(v.getTime())) return ''
    // 用本地时区取年月日：DATE 列没有时区概念，toISOString() 会按 UTC 偏移，
    // 东八区存的 2026-08-27 会被读成 2026-08-26。
    const p = (n) => String(n).padStart(2, '0')
    return `${v.getFullYear()}-${p(v.getMonth() + 1)}-${p(v.getDate())}`
  }
  return String(v).slice(0, 10)
}

/** TIMESTAMP -> 带时区的 ISO 8601，避免把无时区字符串交给搜索引擎猜。 */
export function dateTimeIso(v) {
  if (!v) return ''
  const d = v instanceof Date ? v : new Date(String(v).replace(' ', 'T'))
  return Number.isNaN(d.getTime()) ? '' : d.toISOString()
}

/** 通用 ROM 在 game_roms 里用 lang = '*' 表示 */
export const GENERIC_ROM_LANG = '*'

/* ---------------- 游戏 ---------------- */

/**
 * 一行 games + 它的关联数据 -> 前端的 Game 对象。
 * rel 缺省时当作没有类型 / 标签 / ROM，不会抛错。
 */
/**
 * 首页精选位的排序号。
 *
 * 空串 / null / 0 / 负数 / 非数字一律当「不上首页」。
 * 特别是 0：后台输入框清空后某些浏览器会回 0 而不是空串，
 * 当成有效排序号的话这款游戏会莫名其妙钉在首页第一个。
 */
export function homeRankOf(v) {
  if (v == null || v === '') return null
  const n = Math.trunc(Number(v))
  if (!Number.isFinite(n) || n <= 0) return null
  // SMALLINT UNSIGNED 上限；填个离谱的数不该让写入直接报错
  return Math.min(n, 65535)
}

/**
 * 模拟器核心名。
 *
 * 不做白名单：核心列表是前端配置（src/config/emulators.ts），后端跟着抄一份迟早会走偏，
 * 而且换引擎版本时新核心会先在前端加上。这里只做形状约束 —— 核心名在 libretro 生态里
 * 一律是小写字母 / 数字 / 下划线，把别的字符挡掉就够了，不认识的名字交给引擎自己报错。
 */
export function coreOf(v) {
  if (v == null) return null
  const s = String(v).trim().toLowerCase()
  if (!s) return null
  return /^[a-z0-9_]{1,32}$/.test(s) ? s : null
}

/**
 * DOS 启动程序：zip 内相对路径（如 NFS/TNFS.EXE）。
 * 反斜杠统一成正斜杠（DOS 习惯写法照收），去掉开头的斜杠；
 * 拒绝空段 / . / .. 与控制字符 —— 这个值最终会拼进 dosbox.conf 的 autoexec，
 * 换行混进去等于让后台能注入任意 DOSBox 命令，必须在这里挡死。
 */
export function dosExecutableOf(v) {
  if (v == null) return null
  const s = String(v).trim().replace(/\\/g, '/').replace(/^\/+/, '')
  if (!s || s.length > 200) return null
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1f]/.test(s)) return null
  if (s.split('/').some((seg) => !seg || seg === '.' || seg === '..')) return null
  return s
}

/**
 * DOSBox 是默认核心，不必占一列值；只有 Windows 客体游戏需要明确保存 DOSBox-X。
 * 用白名单而不是照抄请求，避免拼错的核心名一路存进库、直到玩家点开才报错。
 */
export function dosBackendOf(v) {
  return v === 'dosboxX' ? 'dosboxX' : null
}

/**
 * 可复用的 Windows 客体系统镜像。
 *
 * 允许对象存储 key、站内绝对路径和 http(s) URL；只拦长度与控制字符。
 * 它最终会进入 fetch，换行等控制字符既没有合法用途，也会让日志与错误信息变得含混。
 */
export function dosSystemOf(v) {
  if (v == null) return null
  const s = String(v).trim()
  if (!s || s.length > 500) return null
  // eslint-disable-next-line no-control-regex
  return /[\x00-\x1f]/.test(s) ? null : s
}

/**
 * 这款 DOS 游戏怎么存档，一句话（如「按 F2 存档、F3 读档」）。
 *
 * 它只被前端当纯文本渲染，不进 dosbox.conf、不拼 SQL，所以不必像 dos_executable 那样
 * 挑剔路径形状；只砍长度、去掉控制字符 —— 换行会把说明面板的排版撑乱，且没有任何合法用途。
 */
export function dosSaveHintOf(v) {
  if (v == null) return null
  // eslint-disable-next-line no-control-regex
  const s = String(v).replace(/[\x00-\x1f]/g, ' ').trim()
  if (!s) return null
  return s.slice(0, 120)
}

/**
 * Windows 3.x 的 Program Manager 与 Windows 9x 的开始菜单使用不同的“运行”快捷键。
 * 旧数据没有这列值时前端按 9x 处理；这里只接受后台下拉框会发送的两个代次。
 */
export function dosWindowsVersionOf(v) {
  return v === '3x' || v === '9x' ? v : null
}

/**
 * 客体 Windows 进入图形模式后的自启动等待秒数。5 秒以下可能打在仍未就绪的桌面服务上；
 * 120 秒以上只会让坏镜像把玩家长期困在遮罩后，所以把可配置范围收在这里。
 */
export function dosLaunchDelayOf(v) {
  if (v == null || v === '') return null
  const n = Math.round(Number(v))
  if (!Number.isFinite(n)) return null
  return Math.max(5, Math.min(120, n))
}

/**
 * DOSBox-X 覆盖配置必须和浏览器端使用同一套规则；否则 API 能存进去、播放器却拒绝运行。
 * 错误标成可公开的 400，只包含配置行号和规则，不会泄露数据库或服务器路径。
 */
export function dosboxConfigOf(v) {
  if (v == null) return null
  try {
    return normalizeDosboxConfigOverride(v) || null
  } catch (cause) {
    const error = new Error(cause instanceof Error ? cause.message : 'DOSBox-X 配置格式不正确')
    error.status = 400
    error.expose = true
    throw error
  }
}

export function gameRowToApi(r, rel = {}) {
  const g = {
    slug: r.slug,
    title: r.title,
    platform: r.platform,
    genres: rel.genres ?? [],
    year: Number(r.year) || 0,
    developer: r.developer || '',
    plays: Number(r.plays) || 0,
    players: Number(r.players) || 1,
    multiplayer: bool(r.multiplayer),
    coinReward: Number(r.coin_reward) || 0,
    icon: r.icon || '🎮',
    description: r.description || '',
    // 后台没填上线日期时用真实入库时间兜底，不用人工编日期
    addedAt: dateOnly(r.added_at) || dateOnly(r.created_at),
    updatedAt: dateTimeIso(r.updated_at),
    bodyControl: bool(r.body_control),
    adult: bool(r.adult),
    hidden: bool(r.hidden),
  }
  // 不上首页的游戏干脆不带这个字段，前台拿到的形状和以前一样
  if (r.home_rank != null) g.homeRank = Number(r.home_rank)
  // 没覆盖核心的游戏同样不带这个字段，前台自己回落到平台默认
  if (r.core) g.core = r.core
  // 只有 DOS 游戏会填；不带字段 = 前端启发式自己猜
  if (r.dos_executable) g.dosExecutable = r.dos_executable
  if (r.dos_backend === 'dosboxX') g.dosBackend = 'dosboxX'
  if (r.dos_system) g.dosSystem = r.dos_system
  if (r.dos_windows_version === '3x' || r.dos_windows_version === '9x') g.dosWindowsVersion = r.dos_windows_version
  if (r.dos_launch_delay != null) g.dosLaunchDelay = Number(r.dos_launch_delay)
  if (r.dosbox_config_override) g.dosboxConfig = r.dosbox_config_override
  if (r.dos_save_hint) g.dosSaveHint = r.dos_save_hint
  if (r.title_zh) g.titleZh = r.title_zh
  // 没写英文简介的游戏不带这个字段，前台自己回落到基准简介
  if (r.description_en) g.descriptionEn = r.description_en
  if (r.cover) g.cover = r.cover
  if (r.video) g.video = r.video

  const roms = rel.roms ?? {}
  // 通用 ROM 对外仍然叫 rom，按语言的仍然叫 roms —— 保持 v1 的对外形状
  if (roms[GENERIC_ROM_LANG]) g.rom = roms[GENERIC_ROM_LANG]
  const byLang = { ...roms }
  delete byLang[GENERIC_ROM_LANG]
  if (Object.keys(byLang).length) g.roms = byLang

  const tags = rel.tags ?? []
  if (tags.length) g.tags = tags
  return g
}

/** API 游戏对象 -> games 表的字段字典（不含关联表） */
export function gameApiToRow(g) {
  return {
    slug: String(g.slug),
    title: String(g.title ?? ''),
    title_zh: g.titleZh ?? null,
    platform: String(g.platform ?? ''),
    year: Number(g.year) || 0,
    developer: developersText(g.developer),
    players: Number(g.players) || 1,
    multiplayer: g.multiplayer ? 1 : 0,
    coin_reward: Number(g.coinReward) || 0,
    icon: String(g.icon ?? '🎮'),
    cover: g.cover || null,
    video: g.video || null,
    description: String(g.description ?? ''),
    description_en: g.descriptionEn ? String(g.descriptionEn) : null,
    body_control: g.bodyControl ? 1 : 0,
    adult: g.adult ? 1 : 0,
    hidden: g.hidden ? 1 : 0,
    // 空字符串要写成 NULL，否则 DATE 列会存成 '0000-00-00'
    added_at: g.addedAt ? String(g.addedAt).slice(0, 10) : null,
    home_rank: homeRankOf(g.homeRank),
    core: coreOf(g.core),
    dos_executable: dosExecutableOf(g.dosExecutable),
    dos_backend: dosBackendOf(g.dosBackend),
    dos_system: dosSystemOf(g.dosSystem),
    dos_windows_version: dosWindowsVersionOf(g.dosWindowsVersion),
    dos_launch_delay: dosLaunchDelayOf(g.dosLaunchDelay),
    dosbox_config_override: dosboxConfigOf(g.dosboxConfig),
    dos_save_hint: dosSaveHintOf(g.dosSaveHint),
  }
}

/**
 * PATCH 用：只把请求里**确实带了**的字段翻成数据库列。
 * plays 不在这里 —— 它由游玩计数接口自增，不接受整体覆盖。
 */
const FIELD_TO_COLUMN = {
  title: ['title', (v) => String(v ?? '')],
  titleZh: ['title_zh', (v) => (v == null || v === '' ? null : String(v))],
  platform: ['platform', (v) => String(v ?? '')],
  year: ['year', (v) => Number(v) || 0],
  developer: ['developer', developersText],
  players: ['players', (v) => Number(v) || 1],
  multiplayer: ['multiplayer', (v) => (v ? 1 : 0)],
  coinReward: ['coin_reward', (v) => Number(v) || 0],
  icon: ['icon', (v) => String(v ?? '🎮')],
  cover: ['cover', (v) => (v == null || v === '' ? null : String(v))],
  video: ['video', (v) => (v == null || v === '' ? null : String(v))],
  description: ['description', (v) => String(v ?? '')],
  descriptionEn: ['description_en', (v) => (v == null || v === '' ? null : String(v))],
  bodyControl: ['body_control', (v) => (v ? 1 : 0)],
  adult: ['adult', (v) => (v ? 1 : 0)],
  hidden: ['hidden', (v) => (v ? 1 : 0)],
  addedAt: ['added_at', (v) => (v ? String(v).slice(0, 10) : null)],
  homeRank: ['home_rank', homeRankOf],
  core: ['core', coreOf],
  dosExecutable: ['dos_executable', dosExecutableOf],
  dosBackend: ['dos_backend', dosBackendOf],
  dosSystem: ['dos_system', dosSystemOf],
  dosWindowsVersion: ['dos_windows_version', dosWindowsVersionOf],
  dosLaunchDelay: ['dos_launch_delay', dosLaunchDelayOf],
  dosboxConfig: ['dosbox_config_override', dosboxConfigOf],
  dosSaveHint: ['dos_save_hint', dosSaveHintOf],
}

export function gameApiToPartialRow(patch) {
  const row = {}
  if (!patch || typeof patch !== 'object') return row
  for (const [field, [column, cast]] of Object.entries(FIELD_TO_COLUMN)) {
    // 用 hasOwnProperty 而不是取值真假：{ hidden: false } 是「上架」，
    // { cover: null } 是「清空封面」，两者都必须写进去
    if (Object.prototype.hasOwnProperty.call(patch, field)) row[column] = cast(patch[field])
  }
  return row
}

/** 请求体里带了关联字段吗（决定 PATCH 要不要动关联表） */
export function relationsInPatch(patch) {
  const has = (k) => Object.prototype.hasOwnProperty.call(patch ?? {}, k)
  return { genres: has('genres'), tags: has('tags'), roms: has('rom') || has('roms') }
}

/** 把 API 对象里的 rom / roms 归一成 { lang: key } 的形式（通用 ROM 用 '*'） */
export function romsOf(g) {
  const out = {}
  if (g?.rom) out[GENERIC_ROM_LANG] = String(g.rom).trim()
  for (const [lang, key] of Object.entries(g?.roms ?? {})) {
    if (typeof key === 'string' && key.trim()) out[lang] = key.trim()
  }
  return out
}

/* ---------------- 博客 ---------------- */

export function postRowToApi(r, rel = {}) {
  return {
    slug: r.slug,
    title: r.title,
    excerpt: r.excerpt || '',
    content: r.content || '',
    icon: r.icon || '📝',
    tags: rel.tags ?? [],
    author: r.author || '',
    date: dateOnly(r.date) || dateOnly(r.created_at),
    updatedAt: dateTimeIso(r.updated_at),
    published: bool(r.published),
  }
}

export function postApiToRow(p) {
  return {
    slug: String(p.slug),
    title: String(p.title ?? ''),
    excerpt: String(p.excerpt ?? ''),
    content: String(p.content ?? ''),
    icon: String(p.icon ?? '📝'),
    author: String(p.author ?? ''),
    date: p.date ? String(p.date).slice(0, 10) : null,
    published: p.published ? 1 : 0,
  }
}

/* ---------------- 用户 ---------------- */

/** 用户行 -> 对外公开信息（不含密码）。favorites / recents 单独查后传入 */
export function userRowToPublic(r, favorites = [], recent = []) {
  return {
    id: r.id,
    email: r.email,
    nickname: r.nickname,
    avatar: r.avatar || '🕹️',
    coins: Number(r.coins),
    role: r.role,
    status: r.status,
    createdAt: dateOnly(r.created_at),
    /**
     * 只回「有没有密码」，不回哈希。
     * 前端要靠它决定改密码时是否需要先问旧密码：验证码登录的账号从来没设过密码，
     * 逼他填一个填不出来的「当前密码」等于这个功能不可用。
     * 哈希本身是能离线爆破的，没有任何理由发到浏览器。
     */
    hasPassword: Boolean(r.password_hash),
    favorites,
    recent,
  }
}

/* ---------------- SQL 小工具 ---------------- */

/** INSERT ... ON DUPLICATE KEY UPDATE，覆盖除唯一键外的所有列 */
export function buildUpsert(table, row, pk) {
  const cols = Object.keys(row)
  const placeholders = cols.map(() => '?').join(', ')
  const updates = cols
    .filter((c) => c !== pk)
    .map((c) => `\`${c}\` = VALUES(\`${c}\`)`)
    .join(', ')
  const sql = `INSERT INTO \`${table}\` (${cols.map((c) => `\`${c}\``).join(', ')}) VALUES (${placeholders}) ON DUPLICATE KEY UPDATE ${updates}`
  return { sql, values: cols.map((c) => row[c]) }
}
