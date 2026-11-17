/**
 * AI 临时修补的配置（后台「AI 修补」页）。存 site_settings 的 `ai.minimax` 一格（JSON 文本）。
 *
 * 和公告条同一个原则：**env 提供默认、库只做覆盖**（见 site-settings.js 文件头）。
 *   MINIMAX_API_KEY / MINIMAX_REGION / MINIMAX_MODEL 写在 server/.env 时，后台不填也能用；
 *   后台填了就以后台为准。API Key 进库前用 secret-box.js 加密，后台只能看到末四位。
 *
 * 读配置有 30 秒进程内缓存：每份诊断包入库都要问一次「AI 开着吗」，不能每次都查库。
 * 后台保存时立刻作废缓存。
 */
import { getSiteSetting, setSiteSetting } from './site-settings.js'
import { openSecret, sealSecret, secretBoxAvailable, secretHint } from './secret-box.js'
import { HOTFIX_DEFAULT_TTL_HOURS, HOTFIX_MAX_TTL_HOURS } from '../../shared/hotfix.js'

export const AI_CONFIG_KEY = 'ai.minimax'

/**
 * 只允许两个官方入口。不收任意 URL：Key 会随请求发出去，后台一个手滑（或被盗的后台账号）
 * 就能把 Key 和诊断数据送到别人的服务器上。
 * 国际站与国内站的 Key 不通用（platform.minimax.io / platform.minimaxi.com 各自签发）。
 */
export const MINIMAX_REGIONS = Object.freeze({
  global: 'https://api.minimax.io/v1',
  cn: 'https://api.minimaxi.com/v1',
})

/** 2026-11 官方文档的 OpenAI 兼容示例用的是 MiniMax-M3.1-Flash；后台可以改成别的模型 ID */
export const MINIMAX_DEFAULT_MODEL = 'MiniMax-M3.1-Flash'

export const AUTO_APPLY_MODES = Object.freeze(['off', 'safe', 'all'])

const DEFAULTS = Object.freeze({
  enabled: false,
  autoApply: 'safe',
  minVisits: 2,
  windowMinutes: 30,
  ttlHours: HOTFIX_DEFAULT_TTL_HOURS,
  maxCallsPerHour: 12,
  minConfidence: 0.6,
  revokeAfterVisits: 5,
  includeSlow: false,
})

const clampInt = (v, min, max, d) => {
  const n = Math.round(Number(v))
  return Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : d
}
const clampNum = (v, min, max, d) => {
  const n = Number(v)
  return Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : d
}

/** 归一可调参数（不含 Key）。前端传什么都过这一层 */
export function sanitizeAiSettings(raw = {}, base = DEFAULTS) {
  const src = raw && typeof raw === 'object' ? raw : {}
  const model = String(src.model ?? base.model ?? '').trim()
  return {
    enabled: src.enabled === undefined ? Boolean(base.enabled) : src.enabled === true,
    region: Object.hasOwn(MINIMAX_REGIONS, src.region) ? src.region : (base.region ?? 'global'),
    // 模型 ID 只收字母数字和 . _ -：它会原样放进请求体
    model: /^[\w.-]{1,64}$/.test(model) ? model : (base.model || MINIMAX_DEFAULT_MODEL),
    autoApply: AUTO_APPLY_MODES.includes(src.autoApply) ? src.autoApply : (base.autoApply ?? DEFAULTS.autoApply),
    minVisits: clampInt(src.minVisits, 1, 100, base.minVisits ?? DEFAULTS.minVisits),
    windowMinutes: clampInt(src.windowMinutes, 5, 24 * 60, base.windowMinutes ?? DEFAULTS.windowMinutes),
    ttlHours: clampInt(src.ttlHours, 1, HOTFIX_MAX_TTL_HOURS, base.ttlHours ?? DEFAULTS.ttlHours),
    maxCallsPerHour: clampInt(src.maxCallsPerHour, 1, 120, base.maxCallsPerHour ?? DEFAULTS.maxCallsPerHour),
    minConfidence: clampNum(src.minConfidence, 0, 1, base.minConfidence ?? DEFAULTS.minConfidence),
    revokeAfterVisits: clampInt(src.revokeAfterVisits, 0, 1000, base.revokeAfterVisits ?? DEFAULTS.revokeAfterVisits),
    includeSlow: src.includeSlow === undefined ? Boolean(base.includeSlow) : src.includeSlow === true,
  }
}

function envDefaults(env = process.env) {
  const region = String(env.MINIMAX_REGION || '').trim()
  return sanitizeAiSettings({
    ...DEFAULTS,
    region: Object.hasOwn(MINIMAX_REGIONS, region) ? region : 'global',
    model: String(env.MINIMAX_MODEL || '').trim() || MINIMAX_DEFAULT_MODEL,
  })
}

async function readStored() {
  const raw = await getSiteSetting(AI_CONFIG_KEY)
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === 'object' ? parsed : null
  } catch {
    console.warn(`[ai] ${AI_CONFIG_KEY} 不是合法 JSON，按未配置处理`)
    return null
  }
}

let cache = null
let cacheAt = 0
const CACHE_MS = 30_000

/**
 * 运行时用的完整配置（含明文 Key）。**只在服务端内部用，绝不能 res.json 出去**。
 * 表不存在 / 查询失败时返回 env 那一份（读要宽容，见 site-notice.js 的 readStoredNoticeSoft）。
 */
export async function loadAiConfig({ fresh = false, env = process.env } = {}) {
  if (!fresh && cache && Date.now() - cacheAt < CACHE_MS) return cache
  let stored = null
  try {
    stored = await readStored()
  } catch (error) {
    if (error?.code !== 'ER_NO_SUCH_TABLE') console.warn('[ai] 读取配置失败：', error?.message || error)
  }
  const settings = sanitizeAiSettings(stored ?? {}, envDefaults(env))
  let apiKey = ''
  let keySource = null
  let keyBroken = false
  if (stored?.apiKeySealed) {
    const opened = openSecret(stored.apiKeySealed, env)
    if (opened) {
      apiKey = opened
      keySource = 'db'
    } else {
      keyBroken = true
    }
  }
  if (!apiKey && env.MINIMAX_API_KEY) {
    apiKey = String(env.MINIMAX_API_KEY).trim()
    keySource = 'env'
  }
  cache = { ...settings, apiKey, keySource, keyBroken, baseUrl: MINIMAX_REGIONS[settings.region] }
  cacheAt = Date.now()
  return cache
}

export function invalidateAiConfig() {
  cache = null
  cacheAt = 0
}

/** 给后台看的那一份：没有 Key 本身，只有「有没有、从哪来、末四位」 */
export function publicAiConfig(cfg) {
  const { apiKey, baseUrl: _baseUrl, keySource: _source, keyBroken: _broken, ...rest } = cfg
  return {
    ...rest,
    key: {
      configured: Boolean(apiKey),
      source: cfg.keySource,
      hint: secretHint(apiKey),
      broken: cfg.keyBroken,
    },
    canStoreKey: secretBoxAvailable(),
  }
}

/**
 * 后台保存。apiKey：
 *   - 不传 / undefined：保留库里原来那一份；
 *   - 非空字符串：加密后替换；
 *   - clearKey: true：删掉库里那一份（之后回落 env）。
 */
export async function saveAiConfig(input = {}, env = process.env) {
  const stored = (await readStored()) ?? {}
  const settings = sanitizeAiSettings(input, sanitizeAiSettings(stored, envDefaults(env)))
  const next = { ...settings, apiKeySealed: stored.apiKeySealed ?? null }
  if (input.clearKey === true) next.apiKeySealed = null
  const key = typeof input.apiKey === 'string' ? input.apiKey.trim() : ''
  if (key) {
    if (key.length < 16 || key.length > 4096 || /\s/.test(key)) throw Object.assign(new Error('API Key 格式不对（应是一整串、不含空格）'), { status: 400 })
    next.apiKeySealed = sealSecret(key, env)
  }
  await setSiteSetting(AI_CONFIG_KEY, JSON.stringify(next))
  invalidateAiConfig()
  return loadAiConfig({ fresh: true, env })
}
