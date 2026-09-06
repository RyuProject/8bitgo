/**
 * 玩家提交游戏：登录后填名称 / 简介 / 各语言 ROM / 理由，服务端转成一封邮件发给站长。
 *
 * 设计前提是**什么都不落盘**：ROM 不进 R2、不进数据库，只作为邮件附件发出去，
 * 省的就是对象存储那点空间。代价是这条接口天然有三个风险，下面每一处都对着它们写：
 *
 *   1. 一个登录用户就能让服务器**替他发信**。不限流的话，写个循环就是一台
 *      架在你域名上的垃圾邮件发射器，代价是发件域被拉黑（验证码也跟着发不出去）。
 *   2. 附件全在**内存**里（multer 的 memoryStorage）。不卡总量的话，几个人同时
 *      传两百兆，node 进程就 OOM 了 —— 整站一起挂，不只是这个页面。
 *   3. 用户填的字符串要进**邮件头**（主题、附件名）。带换行的名字能往邮件头里
 *      塞任意字段，这是最经典的邮件头注入。
 */
import { Router } from 'express'
import multer from 'multer'
import { requireUser } from '../auth.js'
import { queryOne } from '../db.js'
import { take, clientKey, isMeaningfulIp } from '../rateLimit.js'
import { sendRawMail, MailError, FROM_EMAIL, submitMailProvider } from '../mail.js'
import {
  SUBMIT_ROM_LANGS as LANGS,
  SUBMIT_ROM_LANG_LABEL_ZH as LANG_LABEL,
  ALLOWED_ROM_EXT,
  DEFAULT_SUBMIT_MAX_FILE_MB,
  DEFAULT_SUBMIT_MAX_TOTAL_MB,
  romExtOf as extOf,
} from '../../../shared/game-submission.js'

export const submitGameRouter = Router()

const MB = 1024 * 1024
const envMb = (name, fallback) => {
  const n = Number(process.env[name])
  return Number.isFinite(n) && n > 0 ? Math.round(n * MB) : Math.round(fallback * MB)
}

/**
 * 单个附件上限。
 * 默认 20MB：常见邮箱的收件上限就在 25MB 附近，而 base64 编码还要再胀三分之一，
 * 所以「单个 25MB」那种设法其实一封都发不出去。
 */
const MAX_FILE_BYTES = envMb('SUBMIT_ROM_MAX_FILE_MB', DEFAULT_SUBMIT_MAX_FILE_MB)
/**
 * 一次提交所有附件的**总量**上限 —— 这一条才是真正管用的那道闸。
 * 只限单文件的话，8 个语言各传 20MB 就是 160MB：内存吃满、邮件也必然被退。
 */
const MAX_TOTAL_BYTES = envMb('SUBMIT_ROM_MAX_TOTAL_MB', DEFAULT_SUBMIT_MAX_TOTAL_MB)
/** 整个 multipart 请求体的上限，给 multipart 的分隔符和表单字段留一点余量 */
const MAX_BODY_BYTES = MAX_TOTAL_BYTES + 2 * MB

const MAX_NAME = 120
const MAX_DESC = 2000
const MAX_REASON = 2000
const MAX_LINK = 500

/** 允许当附件发的扩展名，见 shared/game-submission.js —— 前端用同一份做即时提示 */
const ALLOWED_EXT = new Set(ALLOWED_ROM_EXT)

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: MAX_FILE_BYTES,
    files: LANGS.length,
    // 表单字段也要卡：multer 默认允许 1MB 一个字段、字段数无上限
    fields: 40,
    fieldSize: 64 * 1024,
    parts: LANGS.length * 2 + 40,
  },
}).fields(LANGS.map((l) => ({ name: `rom_${l}`, maxCount: 1 })))

function mb(bytes) {
  return `${(bytes / MB).toFixed(1)} MB`
}

/**
 * 去掉控制字符。逐字符判断而不是写正则字符类：源码里不出现裸控制字符，
 * 谁来读都不会把它当成排版空白而误删。
 *
 * @param {unknown} value
 * @param {boolean} keepNewline true 时保留换行（正文用），false 时换成空格（邮件头用）
 */
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

/**
 * 要进邮件头（主题、附件名）的字符串必须先过这里。
 *
 * 去掉 CR / LF 和控制字符 —— 留着的话，一个带换行的游戏名就能往邮件头里
 * 塞任意字段（比如再加一行 Bcc:），这是最经典的邮件头注入。
 * 长度也一起卡死：超长的主题行会被一些邮件网关直接判成畸形邮件。
 */
function headerSafe(value, max) {
  return stripControl(value, false).replace(/\s+/g, ' ').trim().slice(0, max)
}

/** 正文里的多行文本：保留换行，只清掉别的控制字符 */
function bodySafe(value, max) {
  const unified = String(value ?? '').split('\r\n').join('\n').split('\r').join('\n')
  return stripControl(unified, true).trim().slice(0, max)
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

/** 换行转 <br>，用在需要保留换行的正文上 */
function nl2br(s) {
  return escapeHtml(s).replace(/\n/g, '<br>')
}

/**
 * 附件文件名：只取最后一段（挡掉 ../ 和盘符）、清掉控制字符和引号，
 * 再前缀语言，好让你在邮件客户端里一眼分得清哪个是哪个语言。
 */
function attachmentName(lang, original) {
  const base = String(original || '').split(/[\\/]/).pop() || ''
  const cleaned = headerSafe(base, 100).replace(/["']/g, '')
  return `${lang}-${cleaned || 'rom.bin'}`
}

/**
 * multer 的错误**不会**进后面那个 handler 的 try/catch —— 中间件里 next(err)
 * 会直接跳到错误处理中间件，把整段 handler 跳过去。所以必须在这儿把它翻成人话，
 * 否则用户传超了只会看到一句「服务器内部错误」。
 */
function uploadWithErrors(req, res, next) {
  upload(req, res, (err) => {
    if (!err) return next()
    if (err.code === 'LIMIT_FILE_SIZE') {
      return res.status(413).json({ error: `单个 ROM 不能超过 ${mb(MAX_FILE_BYTES)}，更大的请改填下载链接` })
    }
    if (err.code === 'LIMIT_FILE_COUNT' || err.code === 'LIMIT_PART_COUNT') {
      return res.status(400).json({ error: `一次最多提交 ${LANGS.length} 个 ROM 文件` })
    }
    if (err.code === 'LIMIT_UNEXPECTED_FILE') {
      return res.status(400).json({ error: `不认识的文件字段：${headerSafe(err.field, 40)}` })
    }
    if (err.code === 'LIMIT_FIELD_VALUE' || err.code === 'LIMIT_FIELD_COUNT') {
      return res.status(400).json({ error: '表单内容过长' })
    }
    return next(err)
  })
}

/**
 * 在**读请求体之前**按 Content-Length 拒掉过大的提交。
 *
 * 放在 multer 前面是有意的：等 multer 把两百兆收进内存再判断就晚了 ——
 * 内存已经吃掉了，用户也白等了一整趟上传。
 * 拒完顺手断开连接，不然 node 还会把剩下的字节老老实实收完。
 */
function rejectOversizedBody(req, res, next) {
  const len = Number(req.headers['content-length'])
  if (Number.isFinite(len) && len > MAX_BODY_BYTES) {
    res.on('finish', () => {
      try {
        req.destroy()
      } catch {
        /* 连接已经没了，无所谓 */
      }
    })
    return res.status(413).json({
      error: `ROM 附件总大小不能超过 ${mb(MAX_TOTAL_BYTES)}（邮件收不下），更大的请改填「ROM 下载链接」`,
    })
  }
  next()
}

/**
 * 限流。三个维度一起看：
 *   - 每人 10 分钟 3 次：正常提交一款游戏用不了三次，手滑重复点也够用
 *   - 每人一天 20 次：挡住「慢慢刷」
 *   - 每 IP 每小时 20 次：一个人注册一堆号也绕不过去（拿不到真实 IP 时自动跳过，
 *     见 rateLimit.js 的 isMeaningfulIp —— 否则会退化成全站每小时 20 封）
 *
 * 放在 multer 之前：被限流的请求连请求体都不该读，否则限的只是发信、
 * 没限住带宽和内存。
 */
function rateLimitSubmit(req, res, next) {
  const uid = req.user.id
  const perUser = take(`submit:user:${uid}`, 3, 10 * 60_000)
  if (!perUser.ok) {
    return res.status(429).json({ error: '提交太频繁了，请稍后再试', retryAfter: perUser.retryAfter })
  }
  const perDay = take(`submit:user:day:${uid}`, 20, 24 * 3_600_000)
  if (!perDay.ok) {
    return res.status(429).json({ error: '今天提交得有点多了，明天再来吧', retryAfter: perDay.retryAfter })
  }
  const ip = clientKey(req)
  if (isMeaningfulIp(ip)) {
    const perIp = take(`submit:ip:${ip}`, 20, 3_600_000)
    if (!perIp.ok) {
      return res.status(429).json({ error: '提交太频繁了，请稍后再试', retryAfter: perIp.retryAfter })
    }
  }
  next()
}

/**
 * 前端拿真正生效的上限。
 *
 * 为什么不让前端直接用 shared 里的默认值：上限是环境变量能改的（SUBMIT_ROM_MAX_*），
 * 改完不重新构建前端的话，界面上写的和服务端执行的就对不上 ——
 * 表现是「页面说 20MB 以内没问题，传完却被拒」。这个接口一问就永远一致。
 */
submitGameRouter.get('/limits', (_req, res) => {
  res.json({
    maxFileBytes: MAX_FILE_BYTES,
    maxTotalBytes: MAX_TOTAL_BYTES,
    langs: LANGS,
    allowedExt: ALLOWED_ROM_EXT,
  })
})

submitGameRouter.post(
  '/',
  requireUser,
  rateLimitSubmit,
  rejectOversizedBody,
  uploadWithErrors,
  async (req, res, next) => {
    try {
      const user = req.user
      const name = headerSafe(req.body.name, MAX_NAME)
      const description = bodySafe(req.body.description, MAX_DESC)
      const reason = bodySafe(req.body.reason, MAX_REASON)

      if (!name) return res.status(400).json({ error: '请填写游戏名称' })
      if (!description) return res.status(400).json({ error: '请填写游戏简介' })

      // 收集上传的 ROM 文件 + ROM 下载链接（二选一即可，链接用来绕开邮件附件大小上限）
      const fileRoms = []
      const linkRoms = []
      let totalBytes = 0
      for (const l of LANGS) {
        const f = req.files?.[`rom_${l}`]?.[0]
        if (f) {
          const ext = extOf(f.originalname)
          if (!ALLOWED_EXT.has(ext)) {
            return res.status(400).json({
              error:
                `${LANG_LABEL[l]} 的文件「${headerSafe(f.originalname, 60)}」不是能收的 ROM 格式` +
                `${ext ? `（.${ext}）` : ''}。请打包成 zip 再上传 —— 可执行文件会让整封邮件被邮箱拒收`,
            })
          }
          totalBytes += f.size
          fileRoms.push({ lang: l, filename: f.originalname, size: f.size, buffer: f.buffer })
        }
        const link = headerSafe(req.body[`rom_link_${l}`], MAX_LINK)
        if (link) {
          // 只接受 http(s)，避免 javascript: 之类被邮件客户端当链接渲染
          if (!/^https?:\/\/\S+$/i.test(link)) {
            return res.status(400).json({ error: `${LANG_LABEL[l]} 的 ROM 下载链接必须是 http(s) 地址` })
          }
          linkRoms.push({ lang: l, url: link })
        }
      }
      if (fileRoms.length === 0 && linkRoms.length === 0) {
        return res.status(400).json({ error: '请至少提供一种语言的 ROM（上传文件或填写下载链接）' })
      }
      /**
       * 总量复核。前面按 Content-Length 已经拦过一道，但那个头可以缺（chunked 传输），
       * 缺的时候就只剩这一道 —— 所以它不是重复检查。
       */
      if (totalBytes > MAX_TOTAL_BYTES) {
        return res.status(413).json({
          error: `ROM 附件总大小 ${mb(totalBytes)} 超过上限 ${mb(MAX_TOTAL_BYTES)}（邮件收不下），请改填「ROM 下载链接」`,
        })
      }

      /**
       * 通路先确认再干活：SUBMIT_MAIL_PROVIDER 配错时当场报出来，
       * 别等用户把 20MB 传完了才说「发不出去」。
       */
      let provider
      try {
        provider = submitMailProvider()
      } catch (e) {
        if (e instanceof MailError) {
          console.error('[submit-game] 发信通路配置有误：', e.message)
          return res.status(500).json({ error: '站点邮件配置有误，暂时无法接收提交，请稍后再试' })
        }
        throw e
      }
      if (provider === 'cloudflare' && fileRoms.length) {
        return res.status(503).json({ error: '站点当前的邮件通道不支持附件，请改用「ROM 下载链接」提交' })
      }

      const ownerEmail = headerSafe(process.env.SUBMIT_GAME_TO_EMAIL || FROM_EMAIL, 200)
      if (!ownerEmail) {
        console.error('[submit-game] 未配置接收邮箱：SUBMIT_GAME_TO_EMAIL / MAIL_FROM 都是空的')
        return res.status(500).json({ error: '站点未配置接收邮箱，暂时无法接收提交' })
      }

      /**
       * 「游戏库里有没有」这句结论**必须服务端自己查**。
       * 原来是直接采信前端传来的 existingSlug —— 那是用户想填什么就填什么的字段，
       * 于是你在邮件里看到的「游戏库已有同名：否」完全不可信，
       * 而这恰恰是你决定要不要收这个 ROM 的依据。
       */
      const claimedSlug = headerSafe(req.body.existingSlug, 80)
      let existing = null
      if (claimedSlug && /^[a-z0-9][a-z0-9._-]*$/i.test(claimedSlug)) {
        existing = await queryOne('SELECT slug, title, title_zh FROM games WHERE slug = ?', [claimedSlug])
      }
      if (!existing) {
        existing = await queryOne('SELECT slug, title, title_zh FROM games WHERE title = ? OR title_zh = ? LIMIT 1', [
          name,
          name,
        ])
      }
      const existingText = existing
        ? `是 —— ${existing.title_zh || existing.title}（slug: ${existing.slug}）`
        : '否（服务端按名称查过，库里没有同名的）'

      const submittedAt = new Date().toISOString()
      const fileLines = fileRoms
        .map((r) => `- ${LANG_LABEL[r.lang] || r.lang}：${r.filename}（${mb(r.size)}）`)
        .join('\n')
      const linkLines = linkRoms.map((r) => `- ${LANG_LABEL[r.lang] || r.lang}：${r.url}`).join('\n')

      const romSummary =
        `${fileRoms.length ? `ROM 文件（${fileRoms.length} 个，共 ${mb(totalBytes)}，作为附件附上）：\n${fileLines}\n\n` : ''}` +
        `${linkRoms.length ? `ROM 下载链接（${linkRoms.length} 个）：\n${linkLines}\n\n` : ''}` +
        `（ROM 未存储到本站服务器${fileRoms.length ? '，文件仅通过邮件附件发送' : ''}）`

      const text =
        `【8BitGo 游戏提交】\n\n` +
        `提交人：${user.nickname} <${user.email}>（用户 ID ${user.id}）\n` +
        `游戏名称：${name}\n` +
        `游戏库已有同名：${existingText}\n` +
        `提交时间：${submittedAt}\n\n` +
        `游戏简介：\n${description}\n\n` +
        `提交理由：\n${reason || '（未填写）'}\n\n` +
        romSummary

      const html =
        `<div style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;line-height:1.7;color:#222">` +
        `<h2 style="margin:0 0 12px">8BitGo 游戏提交</h2>` +
        `<p><strong>提交人：</strong>${escapeHtml(user.nickname)} &lt;${escapeHtml(user.email)}&gt;（用户 ID ${escapeHtml(user.id)}）</p>` +
        `<p><strong>游戏名称：</strong>${escapeHtml(name)}</p>` +
        `<p><strong>游戏库已有同名：</strong>${escapeHtml(existingText)}</p>` +
        `<p><strong>提交时间：</strong>${escapeHtml(submittedAt)}</p>` +
        `<hr style="border:none;border-top:1px solid #eee;margin:14px 0">` +
        `<p><strong>游戏简介：</strong></p><p>${nl2br(description)}</p>` +
        `<p><strong>提交理由：</strong></p><p>${reason ? nl2br(reason) : '（未填写）'}</p>` +
        `<hr style="border:none;border-top:1px solid #eee;margin:14px 0">` +
        (fileRoms.length
          ? `<p><strong>ROM 文件（${fileRoms.length} 个，共 ${mb(totalBytes)}，作为附件附上）：</strong></p>` +
            `<ul>${fileRoms
              .map((r) => `<li>${LANG_LABEL[r.lang] || r.lang}：${escapeHtml(r.filename)}（${mb(r.size)}）</li>`)
              .join('')}</ul>`
          : '') +
        (linkRoms.length
          ? `<p><strong>ROM 下载链接（${linkRoms.length} 个）：</strong></p>` +
            `<ul>${linkRoms
              .map(
                (r) =>
                  `<li>${LANG_LABEL[r.lang] || r.lang}：` +
                  `<a href="${escapeHtml(r.url)}" rel="noreferrer noopener">${escapeHtml(r.url)}</a></li>`,
              )
              .join('')}</ul>`
          : '') +
        `<p style="color:#888;font-size:12px">ROM 未存储到本站服务器${fileRoms.length ? '，文件仅通过邮件附件发送' : ''}。</p>` +
        `</div>`

      await sendRawMail({
        provider,
        to: ownerEmail,
        // 直接点「回复」就能回到提交人手里，不用从正文里把地址复制出来
        replyTo: headerSafe(user.email, 200),
        subject: `[8BitGo 游戏提交] ${name} · 来自 ${headerSafe(user.nickname, 40)}`,
        text,
        html,
        attachments: fileRoms.map((r) => ({ filename: attachmentName(r.lang, r.filename), content: r.buffer })),
      })

      res.json({ ok: true })
    } catch (e) {
      if (e instanceof MailError) {
        console.error('[submit-game] 发信失败：', e.kind, e.message)
        /**
         * 发信失败要说清「你填的没白填，但也确实没发出去」。
         * 只回一句「失败」的话，用户多半会把 20MB 再传一遍，而真实原因往往是
         * 附件太大 / 通道不支持 —— 再传一百遍也一样。
         */
        const hint =
          e.kind === 'ratelimit'
            ? '站点邮件发送太频繁，请过几分钟再试'
            : '邮件发送失败。如果 ROM 比较大，请改用「ROM 下载链接」那一栏再试'
        return res.status(502).json({ error: hint })
      }
      next(e)
    }
  },
)
