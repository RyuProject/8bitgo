import { SITE_LANGUAGES } from './site-languages.js'

const SITE_LANGUAGE_CODES = new Set(SITE_LANGUAGES.map(({ code }) => code))
const hasOwn = (value, key) => Boolean(value && Object.prototype.hasOwnProperty.call(value, key))
const present = (value) => Boolean(String(value ?? '').trim())

/**
 * 将数据库聚合出的 `zh-Hans,en`、JSON 数组或前端的 ROM 槽对象统一为语言键。
 *
 * sitemap / 主动收录与详情页不能各自判断一遍，否则最容易出现「sitemap 说日文可玩，
 * 实际打开却退回英文 ROM」的假多语言页。这里不验证对象地址，只负责识别已绑定的槽位；
 * 上传保存时仍由原有的 ROM 校验负责地址有效性。
 */
export function romLanguageKeys(value) {
  if (value === null || value === undefined) return []
  if (typeof value === 'string') {
    const raw = value.trim()
    if (!raw) return []
    if (raw.startsWith('[')) {
      try {
        const parsed = JSON.parse(raw)
        if (Array.isArray(parsed)) return parsed.map((item) => String(item).trim()).filter(Boolean)
      } catch {
        // 不是合法 JSON 时继续按逗号分隔；不能让一条脏记录打断整份 sitemap。
      }
    }
    return raw.split(',').map((item) => item.trim()).filter(Boolean)
  }
  if (Array.isArray(value)) return value.map((item) => String(item).trim()).filter(Boolean)
  if (typeof value !== 'object') return []
  return Object.entries(value)
    .filter(([, key]) => present(key))
    .map(([language]) => String(language).trim())
    .filter(Boolean)
}

/**
 * 判断一份已知 ROM 槽是否能让某个语言页面默认启动对应内容。
 *
 * `undefined` 表示调用方没有查询 ROM 关联表：为了兼容旧数据库迁移窗口和只带正文的
 * 旧调用，保守地维持旧行为；空串 / 空对象才代表「已查到但确实没有可玩的 ROM」，必须拦下。
 */
export function hasRomForLanguage(romLanguages, language) {
  if (romLanguages === undefined) return true
  const keys = new Set(romLanguageKeys(romLanguages))
  return keys.has('*') || keys.has(String(language))
}

/**
 * 从前端 / API 的游戏对象取 ROM 可用性。通用 ROM（`rom`）等价于 `*` 槽。
 * 没有 ROM 字段时返回 undefined，让历史的「只携带正文」调用继续使用原有的收录规则。
 */
export function gameRomLanguages(game) {
  if (!game || typeof game !== 'object') return undefined
  if (hasOwn(game, 'rom_languages')) return game.rom_languages
  if (hasOwn(game, 'romLanguages')) return game.romLanguages
  if (!hasOwn(game, 'rom') && !hasOwn(game, 'roms')) return undefined
  const keys = romLanguageKeys(game.roms)
  if (present(game.rom)) keys.push('*')
  return keys
}

/** 只保留站点真实支持的专属 ROM 语言，用于 VideoGame 的 inLanguage。 */
export function declaredRomLanguages(game) {
  return [...new Set(romLanguageKeys(gameRomLanguages(game)).filter((code) => SITE_LANGUAGE_CODES.has(code)))]
}

export function gameHasRomForLanguage(game, language) {
  return hasRomForLanguage(gameRomLanguages(game), language)
}
