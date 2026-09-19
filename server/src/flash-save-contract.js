import { flashSaveBridgeOf, flashSaveKnownSlugs, flashSaveProtocolOf } from '../../shared/flash-save-games.js'

export const FLASH_SAVE_SLOT_COUNT = 3
export const FLASH_SAVE_PART_MAX_BYTES = Number(process.env.FLASH_SAVE_PART_MAX_BYTES || 1024 * 1024)
export const FLASH_SAVE_SLOT_MAX_BYTES = Number(process.env.FLASH_SAVE_SLOT_MAX_BYTES || 2 * 1024 * 1024)
export const FLASH_SAVE_TOTAL_MAX_BYTES = Number(process.env.FLASH_SAVE_TOTAL_MAX_BYTES || 32 * 1024 * 1024)

/**
 * 槽键正则从 FLASH_SAVE_SLOT_COUNT 推导，不写死 `[0-2]` / `[1-3]`：
 * 以后真把槽数改成 4，改一处两代都跟着走（写死的话漏一处就是「第 4 个槽永远读不到」）。
 * ⚠️ 两代编号基准不同：AGI1 是 online0~online2，AGI2 是 slot1~slot3。
 */
const slotAlternation = (start) => Array.from({ length: FLASH_SAVE_SLOT_COUNT }, (_, i) => i + start).join('|')
const KEY_RE = new RegExp(`^(profile|data)online(${slotAlternation(0)})$`)
const SLUG_RE = /^[^/\\\u0000-\u001f\u007f]{1,160}$/u
const DANGEROUS_KEYS = new Set(['__proto__', 'prototype', 'constructor'])

/** 只有明确接过兼容桥的游戏才能签会话，避免别的 Armor Games SWF 被半兼容实现接管。 */
export function flashSaveGameEnabled(gameSlug, env = process.env) {
  // 默认白名单直接来自共用接入表：写死一串 slug 会在加游戏时漂移（加了表忘了 env，或反过来）
  const enabled = String(env.FLASH_SAVE_GAMES || flashSaveKnownSlugs().join(','))
    .split(',')
    .map((slug) => slug.trim())
    .filter(Boolean)
  return enabled.includes(String(gameSlug || ''))
}

/**
 * 兼容桥有两代不同的外部 API，逐游戏绑定，不能按请求猜：
 *
 *   agi1（Infectonator 2 那类，方法式）
 *     游戏自己连调两次 submitUserData，先 profileonlineN、后 dataonlineN；
 *     一份档 = 两个 JSON 拼成的「槽」。见本文件上半部分的校验。
 *
 *   agi2（Kingdom Rush Frontiers 那类，对象式）
 *     AGI2.swf 暴露 user / storage / content / quests 四个命名空间；
 *     storage.user.retrieve / submit / erase 按 **key→value** 存取，
 *     key 固定是 slot1 / slot2 / slot3，value 是整份进度对象（见下面 agi2 一节）。
 *
 * ⚠️ 「哪款游戏用哪套方言、加载哪个桥」只写在 shared/flash-save-games.js 一份。
 * 前端也读它，所以不可能再出现「前端指 AGI2、后端按 AGI1 处理」这种静默错配。
 */
export const FLASH_SAVE_BRIDGES = Object.freeze({
  agi1: '/flash-api/armor-games/AGI.swf',
  agi2: '/flash-api/armor-games/AGI2.swf',
})

export function flashSaveProtocol(gameSlug) {
  return flashSaveProtocolOf(gameSlug)
}

export function flashSaveBridgeUrl(gameSlug) {
  // 接入表里每一款都带桥地址；表外 slug 退回该方言的默认桥（会话本身会被白名单挡掉）
  return flashSaveBridgeOf(gameSlug) || FLASH_SAVE_BRIDGES[flashSaveProtocolOf(gameSlug)]
}

/* ---------------- AGI2：key → value ---------------- */

/**
 * AGI2 只认这三个槽键。放开成任意 key 等于让一个账号在同一个游戏下
 * 制造无限多个存档键，配额再大也兜不住。
 * 编号从 1 起（slot1~slot3），和槽数同一份来源，见上面的 slotAlternation。
 */
const AGI2_KEY_RE = new RegExp(`^slot(${slotAlternation(1)})$`)
/** 一个 value 就是一份完整进度，按整槽上限算（见 FLASH_SAVE_SLOT_MAX_BYTES）。 */
export const FLASH_SAVE_VALUE_MAX_BYTES = FLASH_SAVE_SLOT_MAX_BYTES

export function agi2SaveKey(value) {
  const key = String(value || '')
  return AGI2_KEY_RE.test(key) ? key : null
}

export function validateAgi2Value({ key: rawKey, value }) {
  const key = agi2SaveKey(rawKey)
  if (!key) return { ok: false, status: 400, code: 'invalid_request', message: '存档键只能是 slot1、slot2、slot3' }
  const message = objectError(value, 'value')
  if (message) return { ok: false, status: 400, code: 'invalid_request', message }
  const valueJson = JSON.stringify(value)
  const size = Buffer.byteLength(valueJson)
  if (size > FLASH_SAVE_VALUE_MAX_BYTES) {
    return { ok: false, status: 413, code: 'save_too_large', message: '单个在线存档不能超过 2MB' }
  }
  return { ok: true, key, valueJson, size }
}

/**
 * AGI2 的全量读结果。**只出 slot1~3**，其余一律丢掉。
 *
 * 这条过滤不是洁癖：真 Armor 服务在 keys 里塞过 `kingdomRushPremiumContentEnabled`，
 * KRF 见到它等于 2 就解锁付费内容。谁都能写库的时代要防，将来我们自己误写也要防 ——
 * 白名单是唯一不会忘的做法。
 */
export function agi2SaveMap(rows) {
  const keys = Object.create(null)
  for (const row of rows || []) {
    const key = agi2SaveKey(row.save_key)
    const value = parsedJson(row.value_json)
    if (!key || value === null) continue
    keys[key] = value
  }
  return keys
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
