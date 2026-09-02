/**
 * 发送登录验证码邮件。
 *
 * 四条通路，按环境变量自动选，优先级从上往下：
 *
 *   1. Resend（REST API）—— 配了 RESEND_API_KEY 走这条。只用 fetch，零依赖。
 *      发件域必须先在 Resend 后台完成验证（DNS 加 SPF + DKIM），否则一律 403。
 *      唯一的例外是它自带的 onboarding@resend.dev：不用验证域名，但**只能发给你
 *      注册 Resend 的那个邮箱**，别的收件人会被 403 挡回来（kind=sender）。
 *        RESEND_API_KEY=re_xxx
 *        MAIL_FROM=noreply@8bitgo.com   ← 域名要和 Resend 里验证过的一致
 *
 *   2. Cloudflare Email Service（REST API）—— 配了 CF_ACCOUNT_ID + CF_EMAIL_TOKEN 走这条。
 *      只用 fetch，零依赖。将来这个后端搬进 Cloudflare Worker 时，这段代码原样能跑，
 *      也可以换成 env.EMAIL.send() 绑定 —— 消息体字段名（from / to / subject / html / text）
 *      两边完全一致，只需要把 fetch 那几行换掉。
 *
 *   3. SMTP（nodemailer）—— 配了 SMTP_HOST + SMTP_USER 走这条，兼容原有部署。
 *      Cloudflare 也开了 SMTP 口，想完全不动代码接过去就填：
 *        SMTP_HOST=smtp.mx.cloudflare.net
 *        SMTP_PORT=465            只支持 465 隐式 TLS；587 的 STARTTLS 和 25 都不支持
 *        SMTP_USER=api_token      固定就是这九个字母，不是你的邮箱
 *        SMTP_PASS=<API Token>    需要 Email Sending: Edit 权限
 *
 *   4. 都没配 —— 验证码只打印到服务器日志，本地联调用。
 *
 * ⚠️ 发信失败必须让调用方能分辨原因。以前这里的异常会一路冒到 Express 的兜底处理器
 *    变成一句「服务器内部错误」，而验证码那时已经写进 codes 表并起了冷却 ——
 *    用户既收不到信，又要干等一分钟才能重试，还看不到任何有用的提示。
 *    现在统一抛 MailError 并带上 kind，由 routes/auth.js 翻译成人话。
 */

/** 发信失败。kind 供调用方决定回 4xx 还是 5xx，见 routes/auth.js */
export class MailError extends Error {
  /** @param {'suppressed'|'ratelimit'|'sender'|'network'|'unknown'} kind */
  constructor(kind, message, detail) {
    super(message)
    this.name = 'MailError'
    this.kind = kind
    this.detail = detail
  }
}

/** 发件地址。MAIL_FROM 是新名字，SMTP_FROM / SMTP_USER 是为了兼容旧配置 */
const FROM_EMAIL = (process.env.MAIL_FROM || process.env.SMTP_FROM || process.env.SMTP_USER || '').trim()
const FROM_NAME = (process.env.MAIL_FROM_NAME || '8BitGo').trim()
/** 发信超时。挂在这里等于把一个 HTTP 请求也挂住，必须卡死 */
const TIMEOUT_MS = Number(process.env.MAIL_TIMEOUT_MS || 15_000)

/**
 * 当前生效的通路。启动时打一行日志用 ——
 * 不打的话，「配置写错了于是静默退回打日志」这种故障，
 * 表现就是「用户说收不到验证码」，而服务器一切正常，最难查。
 */
export function mailProvider() {
  if (process.env.RESEND_API_KEY) return 'resend'
  if (process.env.CF_ACCOUNT_ID && process.env.CF_EMAIL_TOKEN) return 'cloudflare'
  if (process.env.SMTP_HOST && process.env.SMTP_USER) return 'smtp'
  return 'none'
}

/* ------------------------------------------------------------------ */
/*  Resend                                                             */
/* ------------------------------------------------------------------ */

/**
 * Resend 的错误分类。
 *
 * ⚠️ 不能只看 HTTP 状态码：403 既可能是「发件域没在 Resend 验证」，也可能是
 * 「你在用 onboarding@resend.dev，只准发给自己」；422 既可能是发件地址不合法，
 * 也可能是收件地址不合法。前者是我们的部署问题（用户换邮箱也没用），
 * 后者用户换个邮箱立刻就好 —— 回给用户的提示完全相反，所以必须分开。
 * 判据用 body.name（Resend 给的机读串）加一次消息文本嗅探。
 */
function resendKind(status, name, message) {
  if (name === 'rate_limit_exceeded' || name === 'daily_quota_exceeded' || status === 429) return 'ratelimit'
  // 收件地址本身不合法 / 被拒 —— 这是用户能自己解决的
  if (/`?to`?/i.test(message) && /invalid|not\s+valid|no\s+recipients/i.test(message)) return 'suppressed'
  // 401 密钥不对、403 域名没验证或试用发件地址、422 发件地址不合法 —— 都是部署问题
  if (status === 401 || status === 403 || status === 422) return 'sender'
  return 'unknown'
}

async function sendViaResend(message) {
  // RESEND_API_BASE 只给本地 mock 用。正式环境不要设 ——
  // 设了就等于把能替你发信的 API Key 发给那个地址。
  const base = (process.env.RESEND_API_BASE || 'https://api.resend.com').replace(/\/+$/, '')

  let res
  try {
    res = await fetch(`${base}/emails`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(message),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
  } catch (e) {
    // 网络层失败或超时，**可以重试**，和「这个邮箱收不了信」是两回事
    throw new MailError('network', `连接 Resend 失败：${e.message}`, e)
  }

  let body = null
  try {
    body = await res.json()
  } catch {
    /* 非 JSON 响应（网关错误页之类），下面按状态码判断 */
  }

  if (!res.ok) {
    const name = String(body?.name || '')
    const msg = String(body?.message || res.statusText)
    throw new MailError(
      resendKind(res.status, name, msg),
      `Resend 发信失败（HTTP ${res.status}${name ? `, ${name}` : ''}）：${msg}`,
      body,
    )
  }

  /**
   * 2xx 一定带邮件 id。没有 id 说明返回体和预期不符（多半是被什么中间层改写过），
   * 这时候宁可报错让用户重试，也别静静地当成「发出去了」——
   * 那样用户会对着一封永远不会到的邮件干等十分钟。
   */
  if (!body?.id) {
    throw new MailError('unknown', 'Resend 返回 2xx 但没给邮件 id，返回体见日志', body)
  }
  return body.id
}

/* ------------------------------------------------------------------ */
/*  Cloudflare Email Service                                           */
/* ------------------------------------------------------------------ */

/**
 * Cloudflare 的错误码 -> 我们的 kind。
 * 前两个是「用户/配置的问题」，后两个是「配额的问题」，处理方式完全不同。
 */
const KIND_BY_CODE = {
  E_RECIPIENT_SUPPRESSED: 'suppressed', // 这个地址退过信或被标过垃圾邮件，进了抑制名单
  E_SENDER_NOT_VERIFIED: 'sender', // 发件域没在 Cloudflare 完成 onboarding
  E_RATE_LIMIT_EXCEEDED: 'ratelimit',
  E_DAILY_LIMIT_EXCEEDED: 'ratelimit',
}

function kindOf(status, code) {
  if (code && KIND_BY_CODE[code]) return KIND_BY_CODE[code]
  if (code === 10004) return 'ratelimit' // REST 层的限流码
  if (status === 429) return 'ratelimit'
  if (status === 401 || status === 403) return 'sender' // Token 没权限 / 账号不对
  return 'unknown'
}

async function sendViaCloudflare(message) {
  // CF_API_BASE 只给本地 mock 用（见 scripts/test-mail-parsing.mjs）。正式环境不要设 ——
  // 设了就等于把带 Email Sending 权限的 Token 发给那个地址。
  const base = (process.env.CF_API_BASE || 'https://api.cloudflare.com/client/v4').replace(/\/+$/, '')
  const url = `${base}/accounts/${process.env.CF_ACCOUNT_ID}/email/sending/send`

  let res
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.CF_EMAIL_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(message),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
  } catch (e) {
    // 网络层失败或超时。这类**可以重试**，跟「这个邮箱收不了信」是两回事，
    // 所以单独一个 kind，别和 unknown 混在一起。
    throw new MailError('network', `连接 Cloudflare Email Service 失败：${e.message}`, e)
  }

  let body = null
  try {
    body = await res.json()
  } catch {
    /* 非 JSON 响应（网关错误页之类），下面按状态码判断 */
  }

  if (!res.ok || body?.success !== true) {
    const first = (Array.isArray(body?.errors) ? body.errors[0] : null) || {}
    const tag = first.code ? `, ${first.code}` : ''
    throw new MailError(
      kindOf(res.status, first.code),
      `Cloudflare 发信失败（HTTP ${res.status}${tag}）：${first.message || res.statusText}`,
      body,
    )
  }

  /**
   * ⚠️ success: true 不等于送到了。
   * 地址不存在、或者已经在抑制名单里的硬退信，会出现在 result.permanent_bounces，
   * 而 HTTP 依然是 200。只看状态码的话，用户会对着一封永远不会到的邮件干等十分钟。
   */
  const r = body.result || {}
  if (Array.isArray(r.permanent_bounces) && r.permanent_bounces.length > 0) {
    throw new MailError('suppressed', `收件地址被退回：${r.permanent_bounces.join(', ')}`, r)
  }
  const accepted = [...(r.delivered || []), ...(r.queued || [])]
  if (accepted.length === 0) {
    // 既没收下也没退回 —— 返回体格式和预期不符，宁可报错也别假装发出去了
    throw new MailError('unknown', 'Cloudflare 既未接收也未退回这封信，返回体见日志', r)
  }
}

/* ------------------------------------------------------------------ */
/*  SMTP（nodemailer）                                                 */
/* ------------------------------------------------------------------ */

let transporter = null
let smtpTried = false

async function getTransport() {
  if (smtpTried) return transporter
  smtpTried = true
  try {
    const nodemailer = (await import('nodemailer')).default
    const port = Number(process.env.SMTP_PORT || 587)
    transporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port,
      // 465 是隐式 TLS（SMTPS），其余端口走 STARTTLS。
      // Cloudflare 的 SMTP 只支持 465，填错端口连不上。
      secure: port === 465,
      auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS || '' },
    })
  } catch {
    transporter = null
  }
  return transporter
}

async function sendViaSmtp({ subject, text, html }, to) {
  const t = await getTransport()
  if (!t) {
    throw new MailError(
      'sender',
      '配了 SMTP_HOST 但 nodemailer 没装 —— 在 server 目录跑 npm i 补上，或者改用 Cloudflare Email Service（CF_ACCOUNT_ID + CF_EMAIL_TOKEN，不需要任何依赖）',
    )
  }
  try {
    await t.sendMail({ from: `${FROM_NAME} <${FROM_EMAIL}>`, to, subject, text, html })
  } catch (e) {
    // nodemailer 的 5xx 是对方明确拒收（地址不存在之类），4xx 多是临时故障
    const code = Number(e?.responseCode || 0)
    throw new MailError(code >= 500 && code < 600 ? 'suppressed' : 'network', `SMTP 发信失败：${e.message}`, e)
  }
}

/* ------------------------------------------------------------------ */

/**
 * 验证码邮件的三种用途。同一套发信通路，但信里必须说清这封码是干什么用的 ——
 * 「注销账号」的码长得和「登录」的一模一样，文案不写明白，用户会把注销码当登录码填，
 * 更糟的是被钓鱼的人骗着把注销码报出去。
 */
const TEMPLATES = {
  login: {
    subject: '你的 8BitGo 登录验证码',
    lead: '你的 8BitGo 登录验证码：',
    tail: '10 分钟内有效。若非本人操作请忽略此邮件。',
  },
  bind: {
    subject: '确认你的新 8BitGo 邮箱',
    lead: '用这个验证码把 8BitGo 账号换绑到当前邮箱：',
    tail: '10 分钟内有效。如果你没有在 8BitGo 申请更换邮箱，请忽略此邮件 —— 你的账号不会有任何变化。',
  },
  delete: {
    subject: '确认注销你的 8BitGo 账号',
    lead: '你正在申请**注销** 8BitGo 账号，验证码：',
    tail:
      '注销后账号、稍后玩、游玩记录和全部云存档都会被永久删除，无法恢复。10 分钟内有效。' +
      '如果这不是你本人操作，请不要把验证码告诉任何人，并直接忽略此邮件。',
  },
}

function codeMail(code, purpose) {
  const tpl = TEMPLATES[purpose] || TEMPLATES.login
  // 纯文本正文不要留 markdown 的星号，读起来是「**注销**」很奇怪
  const leadText = tpl.lead.replace(/\*\*/g, '')
  return {
    subject: tpl.subject,
    text: `${leadText}${code}\n\n${tpl.tail.replace(/\*\*/g, '')}`,
    html:
      `<p>${tpl.lead.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')}</p>` +
      `<p style="font-size:24px;font-weight:700;letter-spacing:4px">${code}</p>` +
      `<p style="color:#888">${tpl.tail}</p>`,
  }
}

/**
 * 发一封验证码邮件。成功返回 undefined，失败抛 MailError。
 *
 * @param {string} email   收件地址
 * @param {string} code    六位验证码
 * @param {'login'|'bind'|'delete'} [purpose] 用途，决定信里的文案。默认登录。
 */
export async function sendLoginCode(email, code, purpose = 'login') {
  const mail = codeMail(code, purpose)
  const provider = mailProvider()

  if (provider === 'none') {
    console.log(`[mail:dev] 验证码 ${code} -> ${email}（用途 ${purpose}，未配置发信通道，仅打印日志）`)
    return
  }

  if (!FROM_EMAIL) {
    throw new MailError('sender', '未配置发件地址：在 .env 里设 MAIL_FROM（例如 noreply@8bitgo.com）')
  }

  if (provider === 'resend') {
    await sendViaResend({
      // Resend 认这种 `名字 <地址>` 的写法，收件箱里显示的就是这个名字
      from: `${FROM_NAME} <${FROM_EMAIL}>`,
      to: [email],
      subject: mail.subject,
      text: mail.text,
      html: mail.html,
    })
    return
  }

  if (provider === 'cloudflare') {
    return sendViaCloudflare({
      from: { email: FROM_EMAIL, name: FROM_NAME },
      to: email,
      subject: mail.subject,
      text: mail.text,
      html: mail.html,
    })
  }

  return sendViaSmtp(mail, email)
}
