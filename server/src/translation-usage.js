/**
 * 火山翻译字符额度的持久计数器。
 *
 * 计数写入现有 site_settings 表，避免进程重启或多实例部署把额度清零。每次实际发起
 * 火山请求前用带上限条件的 UPDATE 原子预留；并发请求中只有仍在额度内的请求能获准。
 * 请求发出后即计入（包括超时/失败），这是为了宁可保守切换备用，也不因未知的上游
 * 计费时点而把 200 万字符上限冲穿。初始用量可从火山控制台填入环境变量。
 */
import { query, queryOne } from './db.js'

const USAGE_SETTING = 'translation.volc.used_chars'
const DEFAULT_LIMIT = 2_000_000

let testAdapter = null

function parseIntegerSetting(rawValue, fallback, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  const raw = String(rawValue ?? '').trim()
  if (!raw) return fallback
  const parsed = Number(raw)
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) return fallback
  return parsed
}

export function volcTranslationCharacterLimit() {
  return parseIntegerSetting(process.env.VOLC_TRANSLATE_CHAR_LIMIT, DEFAULT_LIMIT, { min: 1 })
}

function initialUsage(limit) {
  const raw = String(process.env.VOLC_TRANSLATE_INITIAL_USED_CHARS ?? '').trim()
  if (!raw) return { usedChars: 0, trackingError: false }
  const parsed = Number(raw)
  // 错误的历史基线按“已满”处理，避免配置手滑后又从 0 计数。
  if (!Number.isSafeInteger(parsed) || parsed < 0) return { usedChars: limit, trackingError: true }
  return { usedChars: parsed, trackingError: false }
}

/** 按 Unicode 码点计数，避免 emoji 等代理对被误算成两个字符。 */
export function countTranslationCharacters(texts) {
  return (texts ?? []).reduce((total, text) => total + Array.from(String(text ?? '')).length, 0)
}

async function ensureCounter(limit) {
  await query(
    'INSERT IGNORE INTO site_settings (name, value) VALUES (?, ?)',
    [USAGE_SETTING, String(initialUsage(limit).usedChars)],
  )
}

/**
 * 预留实际要发往火山的字符数。返回 false 表示当前计数已达上限、预留会越线，或计数
 * 行损坏；这些情况全部 fail closed，由调用方停止调用火山并返回安全错误。
 */
export async function reserveVolcTranslationCharacters(characters, limit = volcTranslationCharacterLimit()) {
  const count = Math.max(0, Math.floor(Number(characters) || 0))
  if (!count) return true
  if (testAdapter) return Boolean(await testAdapter.reserve(count, limit))

  await ensureCounter(limit)
  const result = await query(
    `UPDATE site_settings
        SET value = CAST(CAST(value AS UNSIGNED) + ? AS CHAR)
      WHERE name = ?
        AND value REGEXP '^[0-9]{1,16}$'
        AND CAST(value AS UNSIGNED) + ? <= ?`,
    [count, USAGE_SETTING, count, limit],
  )
  return Number(result?.affectedRows ?? 0) === 1
}

export async function getVolcTranslationUsage() {
  const limit = volcTranslationCharacterLimit()
  if (testAdapter) return testAdapter.getUsage(limit)
  const row = await queryOne('SELECT value FROM site_settings WHERE name = ? LIMIT 1', [USAGE_SETTING])
  // 只读展示不能抢先固定环境基线；首次真正预留字符时才创建数据库计数行。
  if (!row) {
    const initial = initialUsage(limit)
    return {
      usedChars: initial.usedChars,
      limitChars: limit,
      remainingChars: Math.max(0, limit - initial.usedChars),
      exhausted: initial.trackingError || initial.usedChars >= limit,
      trackingError: initial.trackingError,
    }
  }
  const raw = String(row?.value ?? '')
  const parsed = /^\d{1,16}$/.test(raw) ? Number(raw) : Number.NaN
  // 读到损坏计数时按“额度已满”展示；绝不把坏值当 0 继续烧火山额度。
  const trackingError = !Number.isSafeInteger(parsed) || parsed < 0
  const usedChars = trackingError ? limit : parsed
  return {
    usedChars,
    limitChars: limit,
    remainingChars: Math.max(0, limit - usedChars),
    exhausted: trackingError || usedChars >= limit,
    trackingError,
  }
}

/** 测试注入点：让翻译回归不依赖 MySQL；线上默认路径始终走 site_settings。 */
export function setTranslationUsageAdapterForTests(adapter = null) {
  testAdapter = adapter
}
