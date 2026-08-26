/**
 * 发送登录验证码邮件。
 *  - 配置了 SMTP_HOST / SMTP_USER 才真正发信（需要 nodemailer，装了才会用：npm i nodemailer）。
 *  - 未配置时退回到把验证码打印到服务器日志，方便本地 / 首次联调。
 */
let transporter = null
let tried = false

async function getTransport() {
  if (tried) return transporter
  tried = true
  const { SMTP_HOST, SMTP_USER } = process.env
  if (!SMTP_HOST || !SMTP_USER) return null
  try {
    const nodemailer = (await import('nodemailer')).default
    transporter = nodemailer.createTransport({
      host: SMTP_HOST,
      port: Number(process.env.SMTP_PORT || 587),
      secure: Number(process.env.SMTP_PORT) === 465,
      auth: { user: SMTP_USER, pass: process.env.SMTP_PASS || '' },
    })
  } catch {
    console.warn('[mail] 未安装 nodemailer，验证码只会打印到日志。启用真实邮件请：npm i nodemailer')
    transporter = null
  }
  return transporter
}

export async function sendLoginCode(email, code) {
  const t = await getTransport()
  if (!t) {
    console.log(`[mail:dev] 验证码 ${code} -> ${email}（未配置 SMTP，仅打印日志）`)
    return
  }
  const from = process.env.SMTP_FROM || process.env.SMTP_USER
  await t.sendMail({
    from: `8BitGo <${from}>`,
    to: email,
    subject: '你的 8BitGo 登录验证码',
    text: `你的验证码是 ${code}，10 分钟内有效。若非本人操作请忽略此邮件。`,
    html: `<p>你的 8BitGo 登录验证码：</p><p style="font-size:24px;font-weight:700;letter-spacing:4px">${code}</p><p style="color:#888">10 分钟内有效。若非本人操作请忽略此邮件。</p>`,
  })
}
