/**
 * POST /api/submit-game 的自检 —— 玩家提交游戏那条接口。
 *
 *   cd server && npm run test:submit
 *
 * 这条接口的特别之处：它会让服务器**替一个普通用户往外发信**，还带着他上传的附件。
 * 所以这里测的重点不是「表单能不能填对」，而是三件出了事很贵的事：
 *
 *   1. 限流真的拦得住 —— 拦不住就是一台架在你域名上的垃圾邮件发射器
 *   2. 邮件头注入拦得住 —— 游戏名里带换行就能往信头里塞 Bcc
 *   3. 附件总量拦得住 —— 拦不住就是 node 进程被几百兆附件撑爆
 *
 * 另外还盯着一条容易被「优化」掉的：邮件里「游戏库已有同名」那句结论**必须服务端自己查**，
 * 不能采信前端传来的 existingSlug —— 那是用户想填什么就填什么的字段，
 * 而你正是靠这句话决定要不要收这个 ROM。
 *
 * 变异检查（改完手动做一遍）：去掉 rateLimitSubmit、把游戏名的 headerSafe 换成 trim、
 * 把总量复核改成恒假 —— 三条都必须让这里变红。
 * 唯一测不出来的是 rejectOversizedBody（Content-Length 预检）：去掉它结果仍然是 413，
 * 差别只在于那 24MB 已经进过内存了。它是省内存和省带宽的，不是判对错的，
 * 所以别看到「删了测试还是绿的」就以为它可以删。
 *
 * 不连数据库、不真发信：用 node:module 的 register() 钩子把 src/db.js 和 src/mail.js
 * 都换成假实现（抄的 test-birth-date.mjs 那套）。
 */
import assert from 'node:assert/strict'
import express from 'express'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { register } from 'node:module'
import { pathToFileURL } from 'node:url'

/* ---------------- 假数据库 ---------------- */

/** slug -> 游戏行。测「库里已有同名」用 */
const games = new Map([['contra', { slug: 'contra', title: 'Contra', title_zh: '魂斗罗' }]])

globalThis.__fakeDb = {
  async query(sql, params) {
    const q = String(sql).replace(/\s+/g, ' ').trim()
    if (q.startsWith('SELECT * FROM users WHERE id')) {
      const id = params[0]
      return [
        {
          id,
          email: `${id}@example.com`,
          nickname: `玩家${id}`,
          avatar: '游',
          password_hash: '',
          coins: 0,
          role: 'user',
          status: 'active',
          token_version: 0,
          created_at: '2026-01-01',
          birth_date: null,
        },
      ]
    }
    if (q.startsWith('SELECT slug, title, title_zh FROM games WHERE slug')) {
      const g = games.get(params[0])
      return g ? [{ ...g }] : []
    }
    if (q.startsWith('SELECT slug, title, title_zh FROM games WHERE title')) {
      for (const g of games.values()) if (g.title === params[0] || g.title_zh === params[1]) return [{ ...g }]
      return []
    }
    throw new Error(`假数据库没准备这条 SQL：${q}`)
  },
  async queryOne(sql, params) {
    return (await globalThis.__fakeDb.query(sql, params))[0]
  },
}

/* ---------------- 假发信 ---------------- */

/** 最后一次调用 sendRawMail 的参数 */
let lastMail = null
/** 下一次发信要不要失败（值就是 MailError 的 kind） */
let mailFails = null
/** submitMailProvider() 这一轮返回什么 */
let provider = 'smtp'

globalThis.__fakeMail = {
  provider: () => provider,
  // MailError 由假模块传进来 —— 必须和路由 import 的是同一个类，
  // 否则路由里那句 `e instanceof MailError` 永远为假，502 那条会测不到
  send: (opts, MailError) => {
    lastMail = opts
    if (mailFails) throw new MailError(mailFails, '测试里让它失败')
  },
}

/* ---------------- 起服务 ---------------- */

const temp = await mkdtemp(path.join(tmpdir(), '8bitgo-submit-'))
try {
  const fakeDb = path.join(temp, 'fake-db.mjs')
  await writeFile(
    fakeDb,
    [
      'export const query = (sql, params) => globalThis.__fakeDb.query(sql, params)',
      'export const queryOne = (sql, params) => globalThis.__fakeDb.queryOne(sql, params)',
      'export const pool = { query: () => { throw new Error("测试不该直接用 pool") } }',
      '',
    ].join('\n'),
    'utf8',
  )

  const fakeMail = path.join(temp, 'fake-mail.mjs')
  await writeFile(
    fakeMail,
    [
      'export class MailError extends Error {',
      '  constructor(kind, message, detail) { super(message); this.name = "MailError"; this.kind = kind; this.detail = detail }',
      '}',
      'export const FROM_EMAIL = "noreply@8bitgo.com"',
      'export function mailProvider() { return globalThis.__fakeMail.provider() }',
      'export function submitMailProvider() { return globalThis.__fakeMail.provider() }',
      'export async function sendRawMail(opts) { return globalThis.__fakeMail.send(opts, MailError) }',
      'export async function sendLoginCode() {}',
      '',
    ].join('\n'),
    'utf8',
  )

  const hooks = path.join(temp, 'hooks.mjs')
  // 用 endsWith 而不是正则：钩子源码是拼出来的，反斜杠在这里最容易被吃掉一层
  await writeFile(
    hooks,
    [
      `const FAKE_DB = ${JSON.stringify(pathToFileURL(fakeDb).href)}`,
      `const FAKE_MAIL = ${JSON.stringify(pathToFileURL(fakeMail).href)}`,
      'export async function resolve(specifier, context, next) {',
      '  const r = await next(specifier, context)',
      '  if (r.url.endsWith("/src/db.js")) return { ...r, url: FAKE_DB, shortCircuit: true }',
      '  if (r.url.endsWith("/src/mail.js")) return { ...r, url: FAKE_MAIL, shortCircuit: true }',
      '  return r',
      '}',
      '',
    ].join('\n'),
    'utf8',
  )
  register(pathToFileURL(hooks))

  process.env.SUBMIT_GAME_TO_EMAIL = 'owner@8bitgo.com'

  // 钩子装好之后再 import，否则 db.js / mail.js 已经以真身进了模块缓存
  const { submitGameRouter } = await import('../src/routes/submit-game.js')
  const { signToken } = await import('../src/auth.js')

  const app = express()
  app.use('/api/submit-game', submitGameRouter)
  // 兜底错误处理：路由要是把错误漏给了 next()，这里会看见，而不是让请求挂住
  app.use((err, _req, res, _next) => res.status(500).json({ error: String(err?.message || err) }))
  const server = app.listen(0)
  await new Promise((r) => server.once('listening', r))
  const base = `http://127.0.0.1:${server.address().port}`

  let seq = 0
  /** 每个用例换一个用户 —— 限流是按用户算的，不换的话前面几条会把后面的顶掉 */
  const freshToken = () => signToken(`u${++seq}`, 0)

  /**
   * 发一次提交。
   * @param {object} fields  普通表单字段
   * @param {Array<[string, Uint8Array, string]>} files [字段名, 内容, 文件名]
   */
  const submit = async (fields = {}, files = [], token = freshToken()) => {
    const fd = new FormData()
    for (const [k, v] of Object.entries(fields)) if (v !== undefined) fd.append(k, v)
    for (const [field, bytes, filename] of files) fd.append(field, new Blob([bytes]), filename)
    const res = await fetch(`${base}/api/submit-game`, {
      method: 'POST',
      headers: token ? { Authorization: `Bearer ${token}` } : {},
      body: fd,
    })
    let body = {}
    try {
      body = await res.json()
    } catch {
      /* 非 JSON 也算一种结果，交给断言看状态码 */
    }
    return { status: res.status, body }
  }

  const VALID = { name: '超级马里奥', description: '一款横版过关游戏', reason: '想玩' }
  const rom = (n = 1024) => new Uint8Array(n).fill(7)

  let n = 0
let failedChecks = 0
/**
 * ⚠️ 断言失败**不再抛异常**，而是记一笔继续往下跑。
 *
 * 原来是 `assert.ok(cond, msg)` —— 第一条炸了整个进程就退出，后面的用例一条都不执行。
 * 2026-09-11 的教训：test:indexnow 从 09-08 起就红着，28 条里只跑到第 6 条，
 * 后面 22 条三天没被执行过，而没人知道，因为根本没人跑它（现在有 `npm test` 了）。
 * 一条小毛病不该把整套的价值清零。
 *
 * 退出码由下面那个 exit 钩子负责 —— 有失败就是非零，绝不会变成静默通过。
 */
const ok = (cond, msg) => {
  if (cond) {
    n++
    console.log('  OK ' + msg)
    return
  }
  failedChecks++
  console.log('❌ ' + msg)
}
process.on('exit', () => {
  if (failedChecks) {
    console.log(`\n❌ ${failedChecks} 项失败（上面带 ❌ 的那几条）`)
    process.exitCode = 1
  }
})

  const reset = () => {
    lastMail = null
    mailFails = null
    provider = 'smtp'
  }

  console.log('-- 必须登录 --')
  reset()
  ok((await submit(VALID, [['rom_en', rom(), 'a.zip']], '')).status === 401, '不带令牌一律 401')
  ok((await submit(VALID, [['rom_en', rom(), 'a.zip']], 'not-a-jwt')).status === 401, '令牌不合法也是 401')
  ok(lastMail === null, '没登录时一封信都没发出去')

  console.log('\n-- 必填项 --')
  reset()
  ok((await submit({ description: 'x' }, [['rom_en', rom(), 'a.zip']])).status === 400, '缺游戏名 400')
  ok((await submit({ name: 'x' }, [['rom_en', rom(), 'a.zip']])).status === 400, '缺简介 400')
  ok((await submit(VALID, [])).status === 400, '一个 ROM 都没有（文件和链接都没填）400')
  ok((await submit({ name: '   ', description: 'x' }, [['rom_en', rom(), 'a.zip']])).status === 400, '全是空格的游戏名 400')
  ok(lastMail === null, '被拒的这几次一封信都没发')

  console.log('\n-- ROM 格式白名单 --')
  reset()
  {
    const r = await submit(VALID, [['rom_en', rom(), 'setup.exe']])
    ok(r.status === 400 && /zip/.test(r.body.error || ''), '.exe 当场拒收，并提示打包成 zip')
  }
  ok((await submit(VALID, [['rom_en', rom(), 'x.html']])).status === 400, '.html 也拒收')
  ok((await submit(VALID, [['rom_en', rom(), 'noext']])).status === 400, '没有扩展名的拒收')
  ok(lastMail === null, '格式被拒时没发信')

  console.log('\n-- 下载链接 --')
  reset()
  ok((await submit({ ...VALID, rom_link_en: 'javascript:alert(1)' })).status === 400, 'javascript: 链接拒收')
  ok((await submit({ ...VALID, rom_link_en: 'ftp://x/y.zip' })).status === 400, '非 http(s) 链接拒收')
  {
    const r = await submit({ ...VALID, rom_link_ja: 'https://example.com/rom.zip' })
    ok(r.status === 200, '只填链接、不传文件也能提交')
    ok((lastMail.attachments || []).length === 0, '只填链接时这封信没有附件')
    ok(lastMail.text.includes('https://example.com/rom.zip'), '链接进了正文')
  }

  console.log('\n-- 正常提交 --')
  reset()
  {
    const r = await submit(VALID, [
      ['rom_en', rom(2048), 'contra.zip'],
      ['rom_ja', rom(1024), 'contra-jp.zip'],
    ])
    ok(r.status === 200 && r.body.ok === true, '两个语言的 ROM 提交成功')
    ok(lastMail.to === 'owner@8bitgo.com', '发给 SUBMIT_GAME_TO_EMAIL')
    ok(lastMail.attachments.length === 2, '两个附件都带上了')
    ok(lastMail.attachments[0].content.length === 2048, '附件内容原样带上（没被截断）')
    ok(lastMail.attachments.map((a) => a.filename).join(',') === 'en-contra.zip,ja-contra-jp.zip', '附件名带语言前缀，一眼分得清')
    ok(/^u\d+@example\.com$/.test(lastMail.replyTo), 'Reply-To 是提交人，直接回复就能联系上')
    ok(lastMail.subject.includes('超级马里奥'), '主题里有游戏名')
    ok(lastMail.provider === 'smtp', '通路由 submitMailProvider() 决定，不是写死的')
  }

  console.log('\n-- 邮件头注入 --')
  reset()
  {
    const evil = '魂斗罗\r\nBcc: attacker@evil.com'
    const r = await submit({ ...VALID, name: evil }, [['rom_en', rom(), 'a.zip']])
    ok(r.status === 200, '带换行的游戏名不报错（照收，只是被清理）')
    ok(!/[\r\n]/.test(lastMail.subject), '主题里没有任何 CR / LF')
    ok(!lastMail.subject.includes('Bcc:') || !/\n/.test(lastMail.subject), '注入的 Bcc 没能自成一行')
    ok(!/[\r\n]/.test(lastMail.attachments[0].filename), '附件名里也没有 CR / LF')
  }
  reset()
  {
    // 文件名里的路径和引号：进 Content-Disposition 之前必须清掉
    await submit(VALID, [['rom_en', rom(), '../../etc/pa"sswd.zip']])
    const fn = lastMail.attachments[0].filename
    ok(!fn.includes('/') && !fn.includes('"'), `附件名清掉了路径和引号（${fn}）`)
  }

  console.log('\n-- 「游戏库已有同名」必须服务端自己查 --')
  reset()
  {
    // 前端谎报一个库里根本没有的 slug
    await submit({ ...VALID, name: '某个不存在的游戏', existingSlug: 'totally-made-up' }, [['rom_en', rom(), 'a.zip']])
    ok(lastMail.text.includes('游戏库已有同名：否'), '谎报的 slug 不算数，结论仍是「否」')
  }
  reset()
  {
    // 真有同名：即使前端一个字都没传，服务端按名字也查得出来
    await submit({ ...VALID, name: '魂斗罗' }, [['rom_en', rom(), 'a.zip']])
    ok(lastMail.text.includes('slug: contra'), '前端不传 existingSlug，服务端按名字也查得出来')
  }

  console.log('\n-- 大小上限 --')
  reset()
  {
    // 单个超限：multer 在中间件里就抛了，错误**不会**进 handler 的 try/catch，
    // 必须由 uploadWithErrors 翻成人话，否则用户只会看到一句「服务器内部错误」
    const big = new Uint8Array(21 * 1024 * 1024)
    const r = await submit(VALID, [['rom_en', big, 'big.zip']])
    ok(r.status === 413, `单个 21MB 被拒（${r.status}）`)
    ok(/MB/.test(r.body.error || ''), `错误信息说清了上限：${r.body.error}`)
    ok(lastMail === null, '超限时没发信')
  }
  reset()
  {
    // 总量超限：每个都在单文件上限之内，加起来超了。只限单文件的话这里会放行
    const each = new Uint8Array(8 * 1024 * 1024)
    const r = await submit(VALID, [
      ['rom_en', each, 'a.zip'],
      ['rom_ja', each, 'b.zip'],
      ['rom_zh', each, 'c.zip'],
    ])
    ok(r.status === 413, `三个 8MB（单个都合法、合计 24MB）被拒（${r.status}）`)
    ok(lastMail === null, '总量超限时没发信')
  }

  console.log('\n-- 没有 Content-Length 时（chunked）总量照样要拦 --')
  reset()
  {
    /**
     * 为什么单独测这一条：Content-Length 那道预检是**可以绕开**的 —— 用分块传输
     * （Transfer-Encoding: chunked）发上来就没有这个头。真绕开了的话，
     * 24MB 会先老老实实进内存，然后才轮到 handler 里那句总量复核。
     * 所以那句复核不是重复检查，是这条路径上唯一的一道闸。
     */
    const boundary = '----8bitgotest'
    const parts = []
    const field = (name, value) =>
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`)
    parts.push(field('name', VALID.name), field('description', VALID.description))
    for (const [lang, file] of [['en', 'a.zip'], ['ja', 'b.zip'], ['zh', 'c.zip']]) {
      parts.push(
        Buffer.from(
          `--${boundary}\r\nContent-Disposition: form-data; name="rom_${lang}"; filename="${file}"\r\n` +
            `Content-Type: application/zip\r\n\r\n`,
        ),
        Buffer.alloc(8 * 1024 * 1024, 7),
        Buffer.from('\r\n'),
      )
    }
    parts.push(Buffer.from(`--${boundary}--\r\n`))
    const body = Buffer.concat(parts)

    // 用流来发 -> undici 走 chunked，不带 Content-Length
    const stream = new ReadableStream({
      start(controller) {
        for (let i = 0; i < body.length; i += 64 * 1024) {
          controller.enqueue(body.subarray(i, i + 64 * 1024))
        }
        controller.close()
      },
    })
    const res = await fetch(`${base}/api/submit-game`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${freshToken()}`,
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
      },
      body: stream,
      duplex: 'half',
    })
    ok(res.status === 413, `分块上传绕开了 Content-Length，仍然被总量复核拦下（${res.status}）`)
    ok(lastMail === null, '没有发信')
  }

  console.log('\n-- 限流 --')
  reset()
  {
    const token = freshToken()
    const codes = []
    for (let i = 0; i < 4; i++) {
      codes.push((await submit(VALID, [['rom_en', rom(), 'a.zip']], token)).status)
    }
    ok(codes.slice(0, 3).every((c) => c === 200), `同一个人前三次都放行（${codes.slice(0, 3)}）`)
    ok(codes[3] === 429, `第四次被限流（${codes[3]}）—— 不然这就是一台垃圾邮件发射器`)
  }

  console.log('\n-- 通路不支持附件时要硬失败 --')
  reset()
  provider = 'cloudflare'
  {
    const r = await submit(VALID, [['rom_en', rom(), 'a.zip']])
    ok(r.status === 503, 'Cloudflare 通路带附件时直接拒绝，而不是「发成功了但 ROM 没了」')
    ok(lastMail === null, '确实一封都没发')
    const linkOnly = await submit({ ...VALID, rom_link_en: 'https://example.com/a.zip' })
    ok(linkOnly.status === 200, '同一条通路上，只填链接的提交照常放行')
  }

  console.log('\n-- 发信失败 --')
  reset()
  mailFails = 'network'
  {
    const r = await submit(VALID, [['rom_en', rom(), 'a.zip']])
    ok(r.status === 502, `发信失败回 502 而不是 500（${r.status}）`)
    ok(/链接/.test(r.body.error || ''), `提示里告诉用户可以改用下载链接：${r.body.error}`)
  }
  reset()
  mailFails = 'ratelimit'
  ok((await submit(VALID, [['rom_en', rom(), 'a.zip']])).status === 502, '限流类失败也是 502')

  console.log('\n-- 上限接口 --')
  reset()
  {
    const res = await fetch(`${base}/api/submit-game/limits`)
    const body = await res.json()
    ok(res.status === 200, '/limits 不需要登录就能问')
    ok(body.maxTotalBytes > 0 && body.maxFileBytes > 0, '回包带着真正生效的上限')
    ok(Array.isArray(body.allowedExt) && body.allowedExt.includes('zip'), '回包带着扩展名白名单')
  }

  server.close()
  console.log(`\n全部通过（${n} 项）`)
} finally {
  await rm(temp, { recursive: true, force: true })
}
