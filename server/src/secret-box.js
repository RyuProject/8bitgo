/**
 * 后台填进数据库的第三方密钥（目前只有 MiniMax API Key）用它加密后再存。
 *
 * 为什么不明文存 site_settings：那张表会跟着每 6 小时一次的备份进 R2（deploy/backup），
 * 一份 dump 泄露就等于 Key 泄露；而服务器 .env 不进备份。所以密钥根仍在 .env（AI_SETTINGS_SECRET，
 * 没配就用 JWT_SECRET），库里只有密文。
 *
 * 代价要知道：换了 JWT_SECRET（而且没单独配 AI_SETTINGS_SECRET）之后旧密文解不开，
 * 后台会显示「需要重新填写」—— 宁可重填一次，也不在备份里留明文。
 */
import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto'

const SALT = '8bitgo-site-secret-box'
const INFO = 'v1'

function rootSecret(env = process.env) {
  return String(env.AI_SETTINGS_SECRET || env.JWT_SECRET || '')
}

export function secretBoxAvailable(env = process.env) {
  return rootSecret(env).length >= 16
}

function keyFor(env) {
  const root = rootSecret(env)
  if (root.length < 16) throw new Error('服务器没有配置 AI_SETTINGS_SECRET 或 JWT_SECRET（至少 16 字符），不能保存密钥')
  return Buffer.from(hkdfSync('sha256', root, SALT, INFO, 32))
}

/** 明文 → `v1:<iv>:<tag>:<密文>`（base64url） */
export function sealSecret(plain, env = process.env) {
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', keyFor(env), iv)
  const ct = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()])
  return ['v1', iv.toString('base64url'), cipher.getAuthTag().toString('base64url'), ct.toString('base64url')].join(':')
}

/** 解不开（密钥根换了 / 格式坏了）返回 null，不抛错 */
export function openSecret(sealed, env = process.env) {
  try {
    const [v, iv, tag, ct] = String(sealed ?? '').split(':')
    if (v !== 'v1' || !iv || !tag || !ct) return null
    const decipher = createDecipheriv('aes-256-gcm', keyFor(env), Buffer.from(iv, 'base64url'))
    decipher.setAuthTag(Buffer.from(tag, 'base64url'))
    return Buffer.concat([decipher.update(Buffer.from(ct, 'base64url')), decipher.final()]).toString('utf8')
  } catch {
    return null
  }
}

/** 后台只给看「…末四位」，完整 Key 永远不回给浏览器 */
export function secretHint(plain) {
  const s = String(plain ?? '')
  return s.length >= 8 ? `…${s.slice(-4)}` : s ? '…' : ''
}
