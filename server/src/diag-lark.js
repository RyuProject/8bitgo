/**
 * 新增的加载失败诊断即时通知到 Lark 自定义机器人。
 *
 * 为什么不沿用聚类邮件：单条加载失败也需要及时看到；同一错误会被重试或多人重复遇到，
 * 所以用数据库冷却键跨进程限频。通知失败不能影响诊断接口，调用方不 await。
 */
import { query } from './db.js'

const DEFAULT_WEBHOOK_PATTERN = /^https:\/\/open\.(?:larksuite\.com|feishu\.cn)\/open-apis\/bot\/v2\/hook\/[A-Za-z0-9-]+$/
const GLOBAL_COOLDOWN_MS = 60_000

function positiveNumber(value, fallback) {
  const n = Number(value)
  return Number.isFinite(n) && n > 0 ? n : fallback
}

export function larkConfig(env = process.env) {
  const webhook = String(env.DIAG_LARK_WEBHOOK_URL || '').trim()
  return {
    webhook: DEFAULT_WEBHOOK_PATTERN.test(webhook) ? webhook : '',
    cooldownMs: positiveNumber(env.DIAG_LARK_COOLDOWN_MINUTES, 10) * 60_000,
    siteUrl: String(env.PUBLIC_SITE_URL || env.SITE_URL || 'https://8bitgo.com').replace(/\/+$/, ''),
  }
}

function safeText(value, max = 240) {
  return String(value ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max) || '未知'
}

export function renderLarkFailure(failure, cfg) {
  const title = failure.event === 'timeout' ? '启动超时' : '加载失败'
  const lines = [
    '【8BitGo ' + title + '】',
    '游戏：' + safeText(failure.slug, 100),
    '错误：' + safeText(failure.signatureText, 400),
    '运行环境：' + safeText(failure.platform, 40) + ' / ' + safeText(failure.runtime, 60),
    '浏览器：' + safeText(failure.browser, 60) + '；系统：' + safeText(failure.os, 40) + '；设备：' + safeText(failure.device, 30),
    '地区：' + safeText(failure.country, 8) + '；启动耗时：' + safeText(failure.elapsedMs, 24) + ' ms',
    '诊断详情：' + cfg.siteUrl + '/admin/diagnostics',
  ]
  return lines.join('\n')
}

async function claimCooldown(run, key, now, cooldownMs) {
  const result = await run(
    'INSERT INTO site_settings (name, value) VALUES (?, ?) ' +
      'ON DUPLICATE KEY UPDATE value = IF(CAST(value AS UNSIGNED) <= ?, VALUES(value), value)',
    ['diag.lark.' + key, String(now), now - cooldownMs],
  )
  return Number(result?.affectedRows ?? 0) > 0
}

/**
 * 诊断记录成功入库后调用。只通知新加载失败 / 启动超时记录；慢启动不发通知。
 * deps 只用于本地测试注入。
 */
export async function notifyLarkFailure(failure, deps = {}) {
  const cfg = deps.config ?? larkConfig()
  if (!cfg.webhook) return 'disabled'
  if (!failure || !['failed', 'timeout'].includes(failure.event)) return 'ignored'

  const run = deps.query ?? query
  const sendFetch = deps.fetch ?? globalThis.fetch
  if (typeof sendFetch !== 'function') return 'error'
  const signature = String(failure.signature ?? '')
  if (!/^[\da-f]{16}$/.test(signature)) return 'ignored'
  const now = deps.now ?? Date.now()
  let signatureClaimed = false
  let globalClaimed = false

  try {
    if (!(await claimCooldown(run, signature, now, cfg.cooldownMs))) return 'cooldown'
    signatureClaimed = true
    if (!(await claimCooldown(run, 'global', now, GLOBAL_COOLDOWN_MS))) {
      await run('DELETE FROM site_settings WHERE name = ? AND value = ?', ['diag.lark.' + signature, String(now)])
        .catch(() => {})
      return 'global-cap'
    }
    globalClaimed = true

    const response = await sendFetch(cfg.webhook, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ msg_type: 'text', content: { text: renderLarkFailure(failure, cfg) } }),
      redirect: 'error',
      signal: AbortSignal.timeout(5_000),
    })
    let body = null
    try { body = await response.json() } catch { /* 非 JSON 响应作为发送失败处理 */ }
    if (!response.ok || Number(body?.code) !== 0) {
      throw new Error('Lark webhook rejected the notification (HTTP ' + response.status + ')')
    }

    await run("DELETE FROM site_settings WHERE name LIKE 'diag.lark.%' AND updated_at < UTC_TIMESTAMP() - INTERVAL 7 DAY")
      .catch(() => {})
    console.log('[diag-lark] 已发送加载失败通知 ' + signature)
    return 'sent'
  } catch (error) {
    if (signatureClaimed) {
      await run('DELETE FROM site_settings WHERE name = ? AND value = ?', ['diag.lark.' + signature, String(now)])
        .catch(() => {})
    }
    if (globalClaimed) {
      await run('DELETE FROM site_settings WHERE name = ? AND value = ?', ['diag.lark.global', String(now)])
        .catch(() => {})
    }
    // 网络异常文本可能包含请求 URL；只记录错误类型，绝不把 webhook token 写进日志。
    console.warn('[diag-lark] 通知发送失败 ' + signature + '（' + safeText(error?.name, 40) + '）')
    return 'error'
  }
}
