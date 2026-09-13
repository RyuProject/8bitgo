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

/**
 * 为什么 `openConfig()` 是空的 —— **只给启动日志用**，不参与任何鉴权判断。
 *
 * ## 这个函数是被一次真实故障逼出来的（2026-09-13）
 *
 * 当时的顺序是：先把 `OPEN_JWT_PRIVATE_KEY_PATH` 写进 .env 并重启，**之后**才
 * 生成那个 .pem 文件。于是进程启动那一刻文件还不存在 → readKey 拿到空串 →
 * openConfig 返回 null → 整块 501。
 *
 * 而这件事**没有任何症状**：`/v1/games` 正常（公开目录不要密钥）、
 * 日志里一个字都没有（这个文件从头到尾不打日志），`ls` 一看文件明明在。
 * 排查的人会去怀疑路径、权限、密钥格式 —— 而真正的原因是「启动时它还不在」。
 *
 * ⚠️ 返回值里**不含密钥内容**，只有「哪一步断了」和路径。这行日志会进 journald。
 *
 * @returns {{ok:true, romEnabled:boolean, embedEnabled:boolean}
 *          |{ok:false, reason:'not-configured'|'key-unreadable'|'key-malformed'|'key-invalid', path?:string, detail?:string}}
 */
export function openConfigDiagnosis(env = process.env) {
  const inline = String(env.OPEN_JWT_PRIVATE_KEY || '').trim()
  const path = String(env.OPEN_JWT_PRIVATE_KEY_PATH || '').trim()
  if (!inline && !path) return { ok: false, reason: 'not-configured' }

  const key = readKey(path, inline)
  if (!key) {
    // 配了路径却读不出来：文件不在、权限不够、或者启动时它还没被创建
    if (path) return { ok: false, reason: 'key-unreadable', path }
    // 配了 inline 却不含 BEGIN —— 多半是把路径填进了 OPEN_JWT_PRIVATE_KEY
    return { ok: false, reason: 'key-malformed' }
  }
  try {
    createPublicKey(key)
  } catch (e) {
    return { ok: false, reason: 'key-invalid', detail: e instanceof Error ? e.message : String(e) }
  }
  return {
    ok: true,
    romEnabled: Boolean(String(env.OPEN_ROM_SECRET || '').trim()),
    embedEnabled: Boolean(String(env.OPEN_EMBED_SECRET || '').trim()),
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
