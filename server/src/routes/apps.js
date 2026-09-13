/**
 * 应用中心前台接口。`/api/apps` 是站内接口（登录态也能调，但不强制），
 * `/api/apps/community-submit` 让登录用户把自建 APP 的提交发邮件给站长。
 *
 * 社区提交的设计：访客填的**不落库**，只转成一封邮件发给 yeahcore@yeah.net
 * （收件地址可经 APPS_SUBMIT_TO_EMAIL 覆盖）。后台看到邮件后，自己决定要不要
 * 在 /admin/apps 里加一条 kind=community 的上架条目。这样既能收集需求，
 * 又不会有人能不经过审核就把东西摆上架。
 *
 * 邮件这条通路的三道坎，和「提交游戏」是同一套（见 routes/submit-game.js）：
 *   1. 登录用户就能替站长发信 —— 必须限流；
 *   2. 用户字符串要进邮件头（主题）—— 必须清控制字符，防邮件头注入；
 *   3. 不落盘、不传附件，最省事也不会 OOM。
 */
import { Router } from 'express'
import { requireUser } from '../auth.js'
import { take, clientKey, isMeaningfulIp } from '../rateLimit.js'
import { sendRawMail, MailError, FROM_EMAIL } from '../mail.js'
import { listApps } from '../apps-repo.js'

export const appsRouter = Router()

appsRouter.get('/', async (_req, res, next) => {
  try {
    const rows = await listApps()
    const grouped = { sdk: [], app: [], community: [] }
    for (const r of rows) {
      const item = {
        id: r.id,
        name: r.name,
        platform: r.platform,
        version: r.version,
        description: r.description,
        downloadUrl: r.download_url,
        icon: r.icon,
        submitterName: r.submitter_name,
        updatedAt: r.updated_at,
      }
      if (r.kind === 'sdk') grouped.sdk.push(item)
      else if (r.kind === 'app') grouped.app.push(item)
      else if (r.kind === 'community') grouped.community.push(item)
    }
    res.json(grouped)
  } catch (e) {
    next(e)
  }
})

/* ---------------- 工具：清控制字符，防邮件头注入 ---------------- */

function stripControl(value, keepNewline) {
  let out = ''
  for (const ch of String(value ?? '')) {
    const code = ch.codePointAt(0)
    if (code < 32 || code === 127) {
      if (keepNewline && code === 10) out += '\n'
      else if (!keepNewline) out += ' '
      continue
    }
    out += ch
  }
  return out
}

/** 进邮件头（主题）的字符串：去控制字符、压成单空格、截断 */
function headerSafe(value, max) {
  return stripControl(value, false).replace(/\s+/g, ' ').trim().slice(0, max)
}

/** 正文多行文本：留换行、清别的控制字符 */
function bodySafe(value, max) {
  return stripControl(String(value ?? '').split('\r\n').join('\n').split('\r').join('\n'), true).trim().slice(0, max)
}

/* ---------------- 社区自建 APP 提交（发邮件） ---------------- */

function rateLimitSubmit(req, res, next) {
  const uid = req.user.id
  const perUser = take(`apps-submit:user:${uid}`, 5, 10 * 60_000)
  if (!perUser.ok) return res.status(429).json({ error: '提交太频繁了，请稍后再试', retryAfter: perUser.retryAfter })
  const ip = clientKey(req)
  if (isMeaningfulIp(ip)) {
    const perIp = take(`apps-submit:ip:${ip}`, 20, 3_600_000)
    if (!perIp.ok) return res.status(429).json({ error: '提交太频繁了，请稍后再试', retryAfter: perIp.retryAfter })
  }
  next()
}

appsRouter.post('/community-submit', requireUser, rateLimitSubmit, async (req, res, next) => {
  try {
    const name = headerSafe(req.body.name, 120)
    const platform = headerSafe(req.body.platform, 40)
    const description = bodySafe(req.body.description, 2000)
    const link = headerSafe(req.body.link, 500)
    const contact = headerSafe(req.body.contact, 200)

    if (!name) return res.status(400).json({ error: '请填写应用名称' })
    if (!description) return res.status(400).json({ error: '请填写应用简介' })
    if (link && !/^https?:\/\/\S+$/i.test(link)) return res.status(400).json({ error: '主页 / 下载链接必须是 http(s) 地址' })

    const ownerEmail = headerSafe(process.env.APPS_SUBMIT_TO_EMAIL || 'yeahcore@yeah.net', 200)
    if (!ownerEmail) {
      console.error('[apps] 未配置接收邮箱：APPS_SUBMIT_TO_EMAIL / MAIL_FROM 都是空的')
      return res.status(500).json({ error: '站点未配置接收邮箱，暂时无法提交' })
    }
    if (!FROM_EMAIL) {
      return res.status(500).json({ error: '站点未配置发件地址（MAIL_FROM），暂时无法提交' })
    }

    const user = req.user
    const text =
      `【8BitGo 社区应用提交】\n\n` +
      `提交人：${user.nickname} <${user.email}>（用户 ID ${user.id}）\n` +
      `应用名称：${name}\n` +
      `适用平台：${platform || '（未填）'}\n` +
      `提交时间：${new Date().toISOString()}\n` +
      (link ? `主页 / 下载：${link}\n` : '') +
      (contact ? `联系方式：${contact}\n` : '') +
      `\n应用简介：\n${description}\n`

    const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    const nl2br = (s) => esc(s).replace(/\n/g, '<br>')
    const html =
      `<div style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;line-height:1.7;color:#222">` +
      `<h2 style="margin:0 0 12px">8BitGo 社区应用提交</h2>` +
      `<p><strong>提交人：</strong>${esc(user.nickname)} &lt;${esc(user.email)}&gt;（用户 ID ${esc(user.id)}）</p>` +
      `<p><strong>应用名称：</strong>${esc(name)}</p>` +
      `<p><strong>适用平台：</strong>${esc(platform || '（未填）')}</p>` +
      `<p><strong>提交时间：</strong>${esc(new Date().toISOString())}</p>` +
      (link ? `<p><strong>主页 / 下载：</strong><a href="${esc(link)}" rel="noreferrer noopener">${esc(link)}</a></p>` : '') +
      (contact ? `<p><strong>联系方式：</strong>${esc(contact)}</p>` : '') +
      `<hr style="border:none;border-top:1px solid #eee;margin:14px 0">` +
      `<p><strong>应用简介：</strong></p><p>${nl2br(description)}</p>` +
      `</div>`

    await sendRawMail({
      to: ownerEmail,
      replyTo: headerSafe(user.email, 200),
      subject: `[8BitGo 社区应用] ${name} · 来自 ${headerSafe(user.nickname, 40)}`,
      text,
      html,
    })

    res.json({ ok: true })
  } catch (e) {
    if (e instanceof MailError) {
      console.error('[apps] 社区提交发信失败：', e.kind, e.message)
      const hint = e.kind === 'ratelimit' ? '站点邮件发送太频繁，请过几分钟再试' : '邮件发送失败，请稍后再试'
      return res.status(502).json({ error: hint })
    }
    next(e)
  }
})
