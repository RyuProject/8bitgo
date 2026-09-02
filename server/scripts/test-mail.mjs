/**
 * 发信自测：不经过 HTTP 接口，直接调 sendLoginCode 发一封真信。
 *
 *   npm run test:mail -- you@example.com
 *
 * 为什么单独做这个：走 /api/auth/email/request-code 测的话，中间隔着限流、
 * 冷却、验证码表，发不出去时你分不清是被自己的限流挡了还是发信真的失败了。
 * 这里只测发信这一段，报错原样打出来。
 */
import 'dotenv/config'
import { sendLoginCode, mailProvider } from '../src/mail.js'

const to = process.argv[2]
if (!to || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) {
  console.error('用法：npm run test:mail -- you@example.com')
  process.exit(1)
}

const provider = mailProvider()
const from = process.env.MAIL_FROM || process.env.SMTP_FROM || process.env.SMTP_USER || '(未设置)'

console.log(`通路：${provider}`)
console.log(`发件：${from}`)
console.log(`收件：${to}`)

if (provider === 'none') {
  console.error('\n⚠️  没有配置发信通道，下面这封信只会打印到日志，不会真的发出去。')
  console.error('   Resend：    在 .env 里填 RESEND_API_KEY、MAIL_FROM')
  console.error('   Cloudflare：填 CF_ACCOUNT_ID、CF_EMAIL_TOKEN、MAIL_FROM')
  console.error('   SMTP：      填 SMTP_HOST、SMTP_PORT、SMTP_USER、SMTP_PASS')
}
if (provider === 'resend' && !process.env.MAIL_FROM) {
  console.warn('\n⚠️  没设 MAIL_FROM，正在退回用 SMTP_FROM / SMTP_USER。Resend 只接受已验证域名下的发件地址。')
}
if (provider === 'cloudflare' && !process.env.MAIL_FROM) {
  console.warn('\n⚠️  没设 MAIL_FROM，正在退回用 SMTP_FROM / SMTP_USER。Cloudflare 要求发件域已完成 onboarding。')
}

const code = String(100000 + Math.floor(Math.random() * 900000))
console.log(`\n正在发送验证码 ${code} …`)

try {
  await sendLoginCode(to, code)
  console.log('\n✅ 发送成功。去收件箱（和垃圾邮件箱）确认一下。')
  if (provider === 'resend') {
    console.log('   注意：Resend 只保证「已入队」，最终投递结果（含退信）看 Dashboard 的 Emails 日志。')
  }
  if (provider === 'cloudflare') {
    console.log('   注意：Cloudflare 只保证「已接收 / 已入队」，最终投递结果看 Dashboard 的发信日志。')
  }
} catch (e) {
  console.error(`\n❌ 发送失败（kind=${e?.kind || 'unknown'}）：${e?.message || e}`)
  const HINT = {
    suppressed: '这个地址在抑制名单里（退过信或被标过垃圾邮件）。换个地址试，或去 Dashboard 把它移出抑制名单。',
    sender:
      '发件域没验证 / 密钥没权限。\n' +
      '   Resend：     发件域要在 Domains 页面显示 Verified（DNS 加 SPF + DKIM），MAIL_FROM 的域名和它一致；\n' +
      '                如果用的是 onboarding@resend.dev，那只能发给你注册 Resend 的那个邮箱。\n' +
      '   Cloudflare： 域名在 Email Service 里完成 onboarding，API Token 有 Email Sending: Edit 权限。',
    ratelimit: '配额或日发送量到顶了。Resend 免费额度是每天 100 封 / 每月 3000 封，超了要等或者升套餐。',
    network: '连不上发信服务。检查服务器出网、DNS，以及 MAIL_TIMEOUT_MS 是不是给太短了。',
  }
  if (HINT[e?.kind]) console.error(`\n   ${HINT[e.kind]}`)
  if (e?.detail) console.error('\n   返回体：', JSON.stringify(e.detail, null, 2).slice(0, 2000))
  process.exit(1)
}
