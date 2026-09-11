/**
 * 开放平台的环境配置。集中一处读，**读不到就明说功能没开**（501），
 * 而不是用一个假密钥把接口跑起来 —— 那种「跑起来了但签名谁都能伪造」是最坏的状态。
 */
import { readFileSync } from 'node:fs'
import { createPublicKey } from 'node:crypto'

let cached = null

export function openConfig(env = process.env) {
  if (cached && cached.env === env) return cached.value
  const value = build(env)
  cached = { env, value }
  return value
}

/** 只给测试用：改完 env 重新读 */
export function resetOpenConfig() {
  cached = null
}

function build(env) {
  const privateKey = readKey(env.OPEN_JWT_PRIVATE_KEY_PATH, env.OPEN_JWT_PRIVATE_KEY)
  if (!privateKey) return null
  let publicKey = ''
  try {
    publicKey = createPublicKey(privateKey).export({ type: 'spki', format: 'pem' })
  } catch {
    return null
  }
  /*
    ⚠️ 三把密钥各司其职，**一把都不能复用**：
      · OPEN_JWT_PRIVATE_KEY —— 签 access token（RS256，与站内 JWT_SECRET 无关，见 tokens.js）
      · OPEN_ROM_SECRET      —— 签 ROM 短期凭据（HMAC）
      · OPEN_EMBED_SECRET    —— 签嵌入地址（HMAC）
    复用的话，一把泄露就等于三件事一起失守，而且吊销时没法只废掉其中一件。
  */
  const romSecret = String(env.OPEN_ROM_SECRET || '').trim()
  const embedSecret = String(env.OPEN_EMBED_SECRET || '').trim()
  return {
    privateKey,
    publicKey,
    kid: String(env.OPEN_JWT_KID || 'open-1'),
    issuer: String(env.OPEN_ISSUER || env.PUBLIC_SITE_URL || 'https://8bitgo.com').replace(/\/+$/, ''),
    romSecret,
    embedSecret,
    /** ROM 接口没配密钥就整个关掉：宁可 501，也不能用空密钥签出一张谁都能伪造的票 */
    romEnabled: Boolean(romSecret),
    embedEnabled: Boolean(embedSecret),
  }
}

function readKey(path, inline) {
  const direct = String(inline || '').trim()
  if (direct.includes('BEGIN')) return direct
  const p = String(path || '').trim()
  if (!p) return ''
  try {
    return readFileSync(p, 'utf8')
  } catch {
    return ''
  }
}
