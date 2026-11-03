import { timingSafeEqual } from 'node:crypto'
import { SITE_LANGUAGES } from '../../shared/site-languages.js'

const TARGET_LANGUAGES = new Set(
  SITE_LANGUAGES.map(({ code }) => code).filter((code) => code !== 'zh-Hans' && code !== 'en'),
)

/**
 * 这把密钥只允许写游戏的单个本地化简介，不能复用后台万能口令或 JWT 密钥。
 * 不配置 / 配置过短时接口保持关闭，避免开发环境占位值意外变成线上写入口。
 */
export function gameDescriptionPushConfig(env = process.env) {
  const token = String(env.GAME_DESCRIPTION_PUSH_TOKEN ?? '').trim()
  if (!token) return { enabled: false, reason: 'GAME_DESCRIPTION_PUSH_TOKEN 未配置' }
  if (Buffer.byteLength(token, 'utf8') < 32) {
    return { enabled: false, reason: 'GAME_DESCRIPTION_PUSH_TOKEN 至少需要 32 个 UTF-8 字节' }
  }
  if (token === String(env.JWT_SECRET ?? '') || token === String(env.ADMIN_TOKEN ?? '')) {
    return { enabled: false, reason: '简介写入密钥不能复用 JWT_SECRET 或 ADMIN_TOKEN' }
  }
  return { enabled: true, token }
}

/** Bearer token 用定长、常量时间比较；不接受 query 参数，避免密钥进入访问日志。 */
export function isGameDescriptionPushAuthorized(header, token) {
  const expected = String(token ?? '')
  const match = /^Bearer\s+(\S+)$/i.exec(String(header ?? '').trim())
  if (!expected || !match) return false
  const actualBytes = Buffer.from(match[1], 'utf8')
  const expectedBytes = Buffer.from(expected, 'utf8')
  return actualBytes.length === expectedBytes.length && timingSafeEqual(actualBytes, expectedBytes)
}

/** 校验 API 的最小写入单元，其他游戏字段不进入此接口。 */
export function validateGameDescriptionPush(body) {
  const slug = String(body?.slug ?? '').trim()
  const lang = String(body?.lang ?? '').trim()
  const rawText = body?.text
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug) || slug.length > 120) {
    return { error: 'slug 必须是有效的游戏 slug（小写字母、数字和连字符，最多 120 字符）' }
  }
  if (!TARGET_LANGUAGES.has(lang)) {
    return { error: `不支持的目标语言：${lang || '（空）'}；可用语言：${[...TARGET_LANGUAGES].join('、')}` }
  }
  if (typeof rawText !== 'string') return { error: 'text 必须是字符串' }
  const text = rawText.trim()
  if (!text) return { error: '简介不能为空；如需删除请在后台编辑游戏' }
  if (text.length > 4000) return { error: '简介不能超过 4000 个字符' }
  return { value: { slug, lang, text } }
}

/** 列表默认只展示缺简介的 ROM 语言槽，避免 AI 工具先吞下整份目录。 */
export function validateGameDescriptionListQuery(query = {}) {
  const status = String(query.status ?? 'missing').trim() || 'missing'
  const lang = String(query.lang ?? '').trim()
  const rawLimit = query.limit == null || query.limit === '' ? 100 : Number(query.limit)
  if (!['missing', 'filled', 'all'].includes(status)) {
    return { error: 'status 只能是 missing、filled 或 all' }
  }
  if (lang && !TARGET_LANGUAGES.has(lang)) {
    return { error: `不支持的目标语言：${lang}；可用语言：${[...TARGET_LANGUAGES].join('、')}` }
  }
  if (!Number.isInteger(rawLimit) || rawLimit < 1 || rawLimit > 200) {
    return { error: 'limit 必须是 1～200 的整数' }
  }
  const cursor = String(query.cursor ?? '').trim()
  if (cursor.length > 512) return { error: 'cursor 无效' }
  return { value: { status, lang: lang || null, limit: rawLimit, cursor } }
}

/** 游标绑定筛选条件，避免换语言 / 状态后误用旧页位置。 */
export function encodeGameDescriptionCursor({ id, lang }, { status, filterLang }) {
  return Buffer.from(JSON.stringify({ v: 1, id: String(id), lang, status, filterLang: filterLang || null }), 'utf8').toString('base64url')
}

export function decodeGameDescriptionCursor(raw, { status, filterLang }) {
  if (!raw) return { value: null }
  try {
    const cursor = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'))
    if (
      cursor?.v !== 1
      || !/^[1-9]\d{0,18}$/.test(String(cursor.id ?? ''))
      || !TARGET_LANGUAGES.has(cursor.lang)
      || cursor.status !== status
      || (cursor.filterLang || null) !== (filterLang || null)
    ) return { error: 'cursor 无效或与当前筛选条件不匹配' }
    return { value: { id: String(cursor.id), lang: cursor.lang } }
  } catch {
    return { error: 'cursor 无效' }
  }
}

export const GAME_DESCRIPTION_TARGET_LANGUAGES = Object.freeze([...TARGET_LANGUAGES])
