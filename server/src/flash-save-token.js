import jwt from 'jsonwebtoken'

const ISSUER = '8bitgo'
const AUDIENCE = '8bitgo-flash-save'
const ALGORITHM = 'HS256'
const DEFAULT_TTL_SECONDS = 8 * 60 * 60

/**
 * Flash 会直接运行第三方年代留下来的脚本，不能把站内 30 天登录令牌交给它。
 * 这里用独立密钥签一张只认在线存档接口、只认一款游戏的短期令牌；即使某个 SWF
 * 把它泄露出去，也不能拿去改资料、读别的游戏或调用后台。
 */
function secret(env = process.env) {
  return String(env.FLASH_SAVE_SECRET || '').trim()
}

export function flashSaveConfigurationError(env = process.env) {
  const key = secret(env)
  if (key.length < 32) return 'FLASH_SAVE_SECRET 未配置或短于 32 字符'
  // 令牌的 aud/scope 白名单已经能阻止互相冒用，但独立密钥还能在一边泄漏时保住另一边。
  if (key === String(env.JWT_SECRET || '').trim()) return 'FLASH_SAVE_SECRET 不能与 JWT_SECRET 相同'
  return ''
}

function ttlSeconds(env = process.env) {
  const value = Number(env.FLASH_SAVE_TTL_SECONDS || DEFAULT_TTL_SECONDS)
  if (!Number.isFinite(value)) return DEFAULT_TTL_SECONDS
  // 太短会让长局中途突然存不上；太长又失去“短期令牌”的意义。
  return Math.max(5 * 60, Math.min(24 * 60 * 60, Math.floor(value)))
}

export function flashSaveConfigured(env = process.env) {
  return !flashSaveConfigurationError(env)
}

export function signFlashSaveToken({ userId, gameSlug, tokenVersion }, env = process.env) {
  const key = secret(env)
  const configurationError = flashSaveConfigurationError(env)
  if (configurationError) throw new Error(configurationError)
  const expiresIn = ttlSeconds(env)
  const token = jwt.sign(
    {
      game: String(gameSlug),
      scope: ['save:read', 'save:write'],
      tv: Number(tokenVersion) || 0,
    },
    key,
    {
      algorithm: ALGORITHM,
      issuer: ISSUER,
      audience: AUDIENCE,
      subject: String(userId),
      expiresIn,
    },
  )
  return { token, expiresAt: Date.now() + expiresIn * 1000 }
}

/**
 * 只返回已经过完整 JWT 白名单校验的字段。普通登录令牌没有 audience/game，开放平台
 * 令牌用的又是另一套密钥，因此两者都不能被误当成 Flash 存档会话。
 */
export function verifyFlashSaveToken(token, env = process.env) {
  const key = secret(env)
  if (key.length < 32 || typeof token !== 'string' || !token) return null
  try {
    const payload = jwt.verify(token, key, {
      algorithms: [ALGORITHM],
      issuer: ISSUER,
      audience: AUDIENCE,
    })
    if (!payload || typeof payload !== 'object') return null
    const userId = String(payload.sub || '')
    const gameSlug = String(payload.game || '')
    const scopes = Array.isArray(payload.scope) ? payload.scope.map(String) : []
    if (!userId || !gameSlug || !scopes.includes('save:read') || !scopes.includes('save:write')) return null
    return {
      userId,
      gameSlug,
      tokenVersion: Number(payload.tv) || 0,
      expiresAt: Number(payload.exp) * 1000,
    }
  } catch {
    return null
  }
}
