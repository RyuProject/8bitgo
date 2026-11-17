/**
 * 启动诊断包的聚类报警（2026-11-15 系统优化 #10）。
 *
 * 为什么：后台「错误诊断」页要有人去看才有用。2026-11 那几次大面积故障（Chrome 132 的 Blob
 * 存储坏掉、getGamepads 被拦、CheerpJ 起不来）都是玩家反馈之后才在诊断页里翻到 —— 同一个
 * 特征早在一小时里刷了几十次。这里在诊断包入库后顺手看一眼：同一特征一小时内来自足够多的
 * **不同访问**就发一封邮件给运营。
 *
 * 约束：
 * - 没配 DIAG_ALERT_EMAIL 就什么都不做（也不查库）；
 * - 只看不同 visit_id 数：一个玩家狂点重试不该触发报警；
 * - 每个特征最多每 DIAG_ALERT_COOLDOWN_HOURS 小时报一次。冷却记在 site_settings
 *   （`diag.alert.<特征>` = 上次发送的毫秒时间戳），用一条带条件的 UPSERT 抢占：
 *   多进程 / 重启之后都不会重复发；
 * - 同一特征在本进程内每分钟最多查一次库，失败刷屏时不给数据库加压；
 * - 任何错误只记日志：报警是锦上添花，不能拖慢或弄坏漏斗接口（调用方不 await）。
 * - 邮件里只有已经脱敏入库的东西（特征文本、游戏 slug、浏览器 / 系统归类），不含 IP、UA 原文。
 */
import { query } from './db.js'
import { mailProvider, sendRawMail } from './mail.js'

const num = (v, d) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : d)

export function alertConfig(env = process.env) {
  const to = String(env.DIAG_ALERT_EMAIL || '').trim()
  return {
    to: /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to) ? to : '',
    minVisits: num(env.DIAG_ALERT_MIN_VISITS, 10),
    windowMinutes: num(env.DIAG_ALERT_WINDOW_MIN, 60),
    cooldownMs: num(env.DIAG_ALERT_COOLDOWN_HOURS, 6) * 3_600_000,
    siteUrl: String(env.PUBLIC_SITE_URL || env.SITE_URL || 'https://8bitgo.com').replace(/\/+$/, ''),
  }
}

const CHECK_THROTTLE_MS = 60_000
const lastChecked = new Map()

/**
 * 抢占冷却：成功（之前没报过 / 已过冷却）返回 true。
 * ON DUPLICATE KEY UPDATE 只在旧值早于阈值时才改写；affectedRows：1 = 新插入，2 = 改写，0 = 仍在冷却。
 */
async function claimCooldown(run, signature, now, cooldownMs) {
  const result = await run(
    `INSERT INTO site_settings (name, value) VALUES (?, ?)
     ON DUPLICATE KEY UPDATE value = IF(CAST(value AS UNSIGNED) <= ?, VALUES(value), value)`,
    [`diag.alert.${signature}`, String(now), now - cooldownMs],
  )
  return Number(result?.affectedRows ?? 0) > 0
}

export function renderAlert(signature, summary, cfg) {
  const games = summary.games.map((g) => `${g.name}（${g.count}）`).join('、') || '—'
  const envs = summary.envs.map((g) => `${g.name}（${g.count}）`).join('、') || '—'
  const subject = `[8BitGo] 启动故障聚集：${summary.visits} 个访问 / ${cfg.windowMinutes} 分钟 —— ${summary.text.slice(0, 60)}`
  const text = [
    `同一个启动故障特征在最近 ${cfg.windowMinutes} 分钟内来自 ${summary.visits} 个不同访问（共 ${summary.count} 份诊断包）。`,
    '',
    `特征：${summary.text}`,
    `特征 ID：${signature}`,
    `游戏：${games}`,
    `环境：${envs}`,
    '',
    `后台查看：${cfg.siteUrl}/admin/diagnostics`,
    '',
    `同一特征 ${Math.round(cfg.cooldownMs / 3_600_000)} 小时内不再重复报警。阈值由 server/.env 的 DIAG_ALERT_* 调整。`,
  ].join('\n')
  return { subject, text }
}

/**
 * 诊断包入库后调用（不要 await）。deps 只给测试注入。
 * @returns {Promise<'disabled'|'throttled'|'below'|'cooldown'|'sent'|'error'>}
 */
export async function maybeAlertSignature(signature, deps = {}) {
  const cfg = deps.config ?? alertConfig()
  if (!cfg.to || !/^[\da-f]{16}$/.test(String(signature ?? ''))) return 'disabled'
  const run = deps.query ?? query
  const send = deps.send ?? sendRawMail
  const now = deps.now ?? Date.now()
  const checked = lastChecked.get(signature)
  if (checked && now - checked < CHECK_THROTTLE_MS) return 'throttled'
  lastChecked.set(signature, now)
  if (lastChecked.size > 2000) lastChecked.clear()
  let claimedCooldown = false
  try {
    const rows = await run(
      `SELECT d.visit_id AS visitId, d.signature_text AS text, g.slug AS slug, d.browser, d.os
         FROM game_startup_diagnostics d JOIN games g ON g.id = d.game_id
        WHERE d.signature = ? AND d.created_at >= NOW() - INTERVAL ? MINUTE`,
      [signature, cfg.windowMinutes],
    )
    const visits = new Set(rows.map((r) => r.visitId))
    if (visits.size < cfg.minVisits) return 'below'
    if (!(await claimCooldown(run, signature, now, cfg.cooldownMs))) return 'cooldown'
    claimedCooldown = true
    const tally = (key) => {
      const m = new Map()
      for (const r of rows) m.set(key(r), (m.get(key(r)) ?? 0) + 1)
      return [...m].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([name, count]) => ({ name, count }))
    }
    const summary = {
      visits: visits.size,
      count: rows.length,
      text: String(rows[0]?.text || ''),
      games: tally((r) => r.slug),
      envs: tally((r) => `${r.browser} / ${r.os}`),
    }
    const { subject, text } = renderAlert(signature, summary, cfg)
    // 配了 Resend 就固定走它（纯文本告警不需要 SUBMIT_MAIL_PROVIDER 那条 SMTP 附件通路）。
    // 通路判定只问 mail.js，不在这里另读 RESEND_API_KEY：后台配置页按「实际读取位置」列这个密钥。
    await send({ to: cfg.to, subject, text, provider: mailProvider() === 'resend' ? 'resend' : undefined })
    console.log(`[diag-alert] 已报警 ${signature}（${summary.visits} 个访问）`)
    // 冷却记录只需要活过冷却期；顺手清掉一周前的，site_settings 不会被特征越攒越多
    await run(`DELETE FROM site_settings WHERE name LIKE 'diag.alert.%' AND updated_at < NOW() - INTERVAL 7 DAY`).catch(() => {})
    return 'sent'
  } catch (error) {
    // 发信失败不能把这次告警静默压住整个冷却期；仅撤销自己刚写入的那条时间戳，避免覆盖并发的新主张。
    if (claimedCooldown) {
      await run(
        'DELETE FROM site_settings WHERE name = ? AND value = ?',
        [`diag.alert.${signature}`, String(now)],
      ).catch(() => {})
    }
    console.warn('[diag-alert] 报警检查失败：', error?.message || error)
    return 'error'
  }
}

export function resetAlertThrottleForTest() {
  lastChecked.clear()
}
