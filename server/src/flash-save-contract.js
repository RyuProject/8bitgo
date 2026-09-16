const KEY_RE = /^(profile|data)online([0-2])$/
const SLUG_RE = /^[^/\\\u0000-\u001f\u007f]{1,160}$/u
const DANGEROUS_KEYS = new Set(['__proto__', 'prototype', 'constructor'])

export const FLASH_SAVE_SLOT_COUNT = 3
export const FLASH_SAVE_PART_MAX_BYTES = Number(process.env.FLASH_SAVE_PART_MAX_BYTES || 1024 * 1024)
export const FLASH_SAVE_SLOT_MAX_BYTES = Number(process.env.FLASH_SAVE_SLOT_MAX_BYTES || 2 * 1024 * 1024)
export const FLASH_SAVE_TOTAL_MAX_BYTES = Number(process.env.FLASH_SAVE_TOTAL_MAX_BYTES || 32 * 1024 * 1024)

/** 只有明确接过兼容桥的游戏才能签会话，避免别的 Armor Games SWF 被半兼容实现接管。 */
export function flashSaveGameEnabled(gameSlug, env = process.env) {
  const enabled = String(env.FLASH_SAVE_GAMES || 'infectonator-2')
    .split(',')
    .map((slug) => slug.trim())
    .filter(Boolean)
  return enabled.includes(String(gameSlug || ''))
}

export function flashGameSlugOk(value) {
  const slug = String(value || '')
  return SLUG_RE.test(slug) && slug === slug.trim()
}

export function flashSaveKey(value) {
  const match = KEY_RE.exec(String(value || ''))
  if (!match) return null
  return { kind: match[1], slot: Number(match[2]) }
}

export function flashSaveSlot(value) {
  // JSON 请求和数据库都给 number；不接收 null/''，否则 Number(null) 会悄悄变成 0。
  if (typeof value !== 'number') return null
  const slot = value
  return Number.isInteger(slot) && slot >= 0 && slot < FLASH_SAVE_SLOT_COUNT ? slot : null
}

/**
 * AS3 对象最终会经过 JSON.stringify，但仍不能只信 express.json 的结果：超深对象会让
 * 后续 stringify/读取压爆调用栈，危险键则会在以后有人做对象合并时变成原型污染入口。
 */
function jsonTreeError(value, depth = 0) {
  if (depth > 32) return 'JSON 嵌套不能超过 32 层'
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return ''
  if (typeof value === 'number') return Number.isFinite(value) ? '' : '数字必须是有限值'
  if (Array.isArray(value)) {
    for (const item of value) {
      const error = jsonTreeError(item, depth + 1)
      if (error) return error
    }
    return ''
  }
  if (typeof value !== 'object') return '只允许 JSON 数据类型'
  const proto = Object.getPrototypeOf(value)
  if (proto !== Object.prototype && proto !== null) return '只允许普通 JSON 对象'
  for (const [key, item] of Object.entries(value)) {
    if (DANGEROUS_KEYS.has(key)) return `不允许字段 ${key}`
    const error = jsonTreeError(item, depth + 1)
    if (error) return error
  }
  return ''
}

function objectError(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return `${label} 必须是 JSON 对象`
  return jsonTreeError(value)
}

export function validateFlashSavePair({ slot: rawSlot, profile, data }) {
  const slot = flashSaveSlot(rawSlot)
  if (slot === null) return { ok: false, status: 400, code: 'invalid_request', message: '存档位只能是 0、1、2' }
  for (const [label, value] of [['profile', profile], ['data', data]]) {
    const message = objectError(value, label)
    if (message) return { ok: false, status: 400, code: 'invalid_request', message }
  }
  const index = `online${slot}`
  if (profile.index !== index || data.index !== index || Number(profile.saved) !== 1) {
    return { ok: false, status: 400, code: 'invalid_request', message: '存档内容与存档位不匹配' }
  }
  const profileJson = JSON.stringify(profile)
  const dataJson = JSON.stringify(data)
  const profileBytes = Buffer.byteLength(profileJson)
  const dataBytes = Buffer.byteLength(dataJson)
  const size = profileBytes + dataBytes
  if (profileBytes > FLASH_SAVE_PART_MAX_BYTES || dataBytes > FLASH_SAVE_PART_MAX_BYTES || size > FLASH_SAVE_SLOT_MAX_BYTES) {
    return { ok: false, status: 413, code: 'save_too_large', message: '单个在线存档不能超过 2MB' }
  }
  return { ok: true, slot, profileJson, dataJson, size }
}

export function flashSaveQuotaError(usedBytes, oldSize, newSize) {
  // 缩小或等大永远允许，避免玩家已经顶到配额后连“覆盖成更小的档”也做不到。
  if (newSize <= oldSize) return null
  if (usedBytes - oldSize + newSize <= FLASH_SAVE_TOTAL_MAX_BYTES) return null
  return {
    status: 409,
    code: 'quota_exceeded',
    message: `Flash 在线存档总共最多 ${Math.round(FLASH_SAVE_TOTAL_MAX_BYTES / 1024 / 1024)}MB，请先删除一些存档`,
  }
}

function parsedJson(value) {
  if (value && typeof value === 'object') return value
  try {
    return JSON.parse(String(value))
  } catch {
    return null
  }
}

/** 旧游戏拿到的是一个按原始 AGI key 编排的对象；不完整的行绝不能暴露给它。 */
export function legacyFlashSaveMap(rows, premiumEnabled = 0, premiumPrice = 0) {
  const data = Object.create(null)
  for (const row of rows || []) {
    const slot = flashSaveSlot(row.slot)
    const profile = parsedJson(row.profile_json)
    const save = parsedJson(row.data_json)
    if (slot === null || !profile || !save) continue
    data[`profileonline${slot}`] = profile
    data[`dataonline${slot}`] = save
  }
  // 权益字段由服务端产生，不能从玩家可写的 JSON 中读取。
  data.PremiumEnabled = Number(premiumEnabled) || 0
  data.PremiumEnabled_Price = Number(premiumPrice) || 0
  return data
}
