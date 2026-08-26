/**
 * 数据库行 <-> 前端对象 的转换。
 * 前端用 camelCase，数据库用 snake_case；布尔存 TINYINT，genres/tags 存 JSON。
 */

const bool = (v) => v === 1 || v === true || v === '1'
const arr = (v) => (Array.isArray(v) ? v : v == null ? [] : safeParse(v))
function safeObj(v) {
  try {
    const p = JSON.parse(v)
    return p && typeof p === 'object' && !Array.isArray(p) ? p : null
  } catch {
    return null
  }
}
function safeParse(v) {
  try {
    const p = JSON.parse(v)
    return Array.isArray(p) ? p : []
  } catch {
    return []
  }
}

/* ---------------- 游戏 ---------------- */
export function gameRowToApi(r) {
  const g = {
    slug: r.slug,
    title: r.title,
    platform: r.platform,
    genres: arr(r.genres),
    year: Number(r.year),
    developer: r.developer || '',
    rating: Number(r.rating),
    ratingCount: Number(r.rating_count),
    plays: Number(r.plays),
    players: Number(r.players),
    multiplayer: bool(r.multiplayer),
    coinReward: Number(r.coin_reward),
    icon: r.icon || '🎮',
    description: r.description || '',
    addedAt: r.added_at || '',
    bodyControl: bool(r.body_control),
    hidden: bool(r.hidden),
  }
  if (r.title_zh) g.titleZh = r.title_zh
  if (r.cover) g.cover = r.cover
  if (r.video) g.video = r.video
  if (r.rom) g.rom = r.rom
  const roms = typeof r.roms === 'string' ? safeObj(r.roms) : r.roms
  if (roms && typeof roms === 'object' && Object.keys(roms).length) g.roms = roms
  const tags = arr(r.tags)
  if (tags.length) g.tags = tags
  return g
}

/** API 游戏对象 -> 用于 upsert 的字段字典（snake_case） */
export function gameApiToRow(g) {
  return {
    slug: String(g.slug),
    title: String(g.title ?? ''),
    title_zh: g.titleZh ?? null,
    platform: String(g.platform ?? ''),
    genres: JSON.stringify(Array.isArray(g.genres) ? g.genres : []),
    year: Number(g.year) || 0,
    developer: String(g.developer ?? ''),
    rating: Number(g.rating) || 0,
    rating_count: Number(g.ratingCount) || 0,
    plays: Number(g.plays) || 0,
    players: Number(g.players) || 1,
    multiplayer: g.multiplayer ? 1 : 0,
    coin_reward: Number(g.coinReward) || 0,
    icon: String(g.icon ?? '🎮'),
    cover: g.cover ?? null,
    video: g.video ?? null,
    description: String(g.description ?? ''),
    tags: JSON.stringify(Array.isArray(g.tags) ? g.tags : []),
    added_at: String(g.addedAt ?? ''),
    body_control: g.bodyControl ? 1 : 0,
    hidden: g.hidden ? 1 : 0,
    rom: g.rom ?? null,
    roms: JSON.stringify(g.roms && typeof g.roms === 'object' ? g.roms : {}),
  }
}

/* ---------------- 博客 ---------------- */
export function postRowToApi(r) {
  return {
    slug: r.slug,
    title: r.title,
    excerpt: r.excerpt || '',
    content: r.content || '',
    icon: r.icon || '📝',
    tags: arr(r.tags),
    author: r.author || '',
    date: r.date || '',
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
    tags: JSON.stringify(Array.isArray(p.tags) ? p.tags : []),
    author: String(p.author ?? ''),
    date: String(p.date ?? ''),
    published: p.published ? 1 : 0,
  }
}

/* ---------------- 用户 ---------------- */
/** 用户行 -> 对外公开信息（不含密码）。favorites / recent 单独查后传入 */
export function userRowToPublic(r, favorites = [], recent = []) {
  return {
    id: r.id,
    email: r.email,
    nickname: r.nickname,
    avatar: r.avatar || '🕹️',
    coins: Number(r.coins),
    role: r.role,
    status: r.status,
    createdAt: r.created_at || '',
    favorites,
    recent,
  }
}

/** 通用 upsert：INSERT ... ON DUPLICATE KEY UPDATE，覆盖除主键外所有列 */
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
