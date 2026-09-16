import { createHmac } from 'node:crypto'

const PACKAGE_ID = /^[a-f0-9]{32}$/i
const KEY_ID = /^[A-Za-z0-9._-]{1,32}$/

/**
 * keyId 是容器格式的一部分，不能把密钥轮换做成「覆盖一个环境变量」。
 * v1 默认读 ROM_PACK_SECRET；以后切 v2 时新增 ROM_PACK_SECRET_V2，老包继续读旧密钥，
 * 新包只改 ROM_PACK_KEY_ID=v2。这样换 codec 或换密钥都不需要全库同步迁移。
 */
export function romPackSecret(keyId, env = process.env) {
  if (!KEY_ID.test(String(keyId || ''))) return ''
  const named = env[`ROM_PACK_SECRET_${String(keyId).toUpperCase().replace(/[^A-Z0-9]/g, '_')}`]
  // ROM_PACK_SECRET 只代表“当前代”。轮换到 v2 后若忘了保留 ROM_PACK_SECRET_V1，绝不能拿
  // v2 的根密钥悄悄派生 v1 数据密钥 —— 那只会让所有旧包报“文件损坏”，把配置错误藏起来。
  const fallback = keyId === activeRomPackKeyId(env) ? env.ROM_PACK_SECRET : ''
  return String(named || fallback || '').trim()
}

export function activeRomPackKeyId(env = process.env) {
  const id = String(env.ROM_PACK_KEY_ID || 'v1').trim()
  return KEY_ID.test(id) ? id : 'v1'
}

export function isRomPackConfigured(env = process.env) {
  return validSecret(romPackSecret(activeRomPackKeyId(env), env))
}

/** HMAC 本身就是伪随机函数；每个 packageId 得到独立的 256 位数据密钥。 */
export function deriveRomPackKey(packageId, keyId, env = process.env) {
  if (!PACKAGE_ID.test(String(packageId || ''))) throw new Error('packageId 无效')
  if (!KEY_ID.test(String(keyId || ''))) throw new Error('keyId 无效')
  const secret = romPackSecret(keyId, env)
  if (!validSecret(secret)) throw new Error(`ROM_PACK_SECRET_${String(keyId).toUpperCase()} 未配置或长度不足`)
  return createHmac('sha256', secret).update(`8bitgo-rom-pack\0${keyId}\0${packageId}`).digest()
}

function validSecret(secret) {
  // 不限定 hex/base64：运维可以直接用密码管理器生成的长随机串；只要求至少 32 个 UTF-8 字节。
  return Buffer.byteLength(String(secret || ''), 'utf8') >= 32
}
