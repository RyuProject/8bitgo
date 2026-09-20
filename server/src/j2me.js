/**
 * J2ME 的 .jar 供给：三个来源，按优先级
 *
 *   1. public/j2me/jar/ 里的本地文件   —— 由 express.static 优先命中，不走这里
 *   2. 玩家临时上传的 jar             —— 存在临时目录，TTL 到期或页面关闭即删
 *   3. 对象存储（R2）上的正式 ROM      —— 转发
 *
 * 为什么要这层：freej2me-web 的加载路径是 cheerpjWebRoot + "/jar/" + 文件名 硬拼出来的，
 * 不能直接给完整 URL 或 blob: 地址，所以 jar 必须能从 <J2ME_PATH>jar/<名字> 取到。
 *
 * ⚠️ 上传接口不需要登录（玩家本来就不一定有账号），所以按「公开攻击面」来防：
 *    体积上限、魔数校验、随机文件名、总量上限、定时清扫、**限流**。
 *
 * ⚠️ 限流是 2026-09-07 补的，之前**一条都没有** —— 这是全站唯一一个
 *    「不需要登录、还往磁盘写文件」的公开端点，而 comments / ratings / collections /
 *    验证码全都既要登录又有限流。没有它的话，一台机器就能把 500MB 的临时空间刷满
 *    （JAR 结构校验挡不住「构造一个合法的空壳 jar」），之后所有玩家上传都是 507；
 *    每次上传还是一次 20MB 的同步写 + 两遍全目录 readdir/stat，等于顺带的事件循环放大器。
 *    release / keepalive 刻意**不**限流：它们要求名字命中 `tmp-<32位十六进制>.jar`
 *    才做任何 IO，猜不到就是一句 204 空转，没有可放大的成本（那个随机名本身就是凭据）。
 */
import { createReadStream } from 'node:fs'
import { TemporaryJarStore } from './temporary-jar-store.js'
import { readResponseBuffer } from './bounded-response.js'
import { envNumber } from './resource-limits.js'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { assertJarBuffer } from './jar-validation.js'
import { take, clientKey, isMeaningfulIp } from './rateLimit.js'
import { assetBaseUrl } from './site-urls.js'

// 公开 R2 域名不是机密，给线上同源 JAR 代理一个可用默认值（默认值和读取逻辑都在
// site-urls.js —— 动态 sitemap 的 <image:loc> 也要用同一个根地址，抄两份就会出现
// 「JAR 代理能取到、sitemap 里的封面地址是空的」这种一边好一边坏的情况）。
const ROM_BASE = assetBaseUrl()
const ROM_PREFIX = (process.env.ROM_PREFIX || 'roms').replace(/^\/+|\/+$/g, '')

/** 临时上传目录。默认在 server/tmp/j2me，可用 J2ME_TMP_DIR 覆盖。 */
export const TMP_DIR = process.env.J2ME_TMP_DIR
  ? path.resolve(process.env.J2ME_TMP_DIR)
  : path.resolve(fileURLToPath(new URL('../tmp/j2me', import.meta.url)))

const MAX_MB = envNumber('J2ME_MAX_UPLOAD_MB', 20, { integer: false, min: 0.001, max: 256 })
const MAX_BYTES = Math.floor(MAX_MB * 1024 * 1024)
/** 兜底清扫：超过这个时间的临时文件一律删除，哪怕浏览器没来得及通知 */
const TTL_MS = envNumber('J2ME_TMP_TTL_MS', 30 * 60_000, { max: 7 * 86400000 })
/** 临时目录总量上限，防止被人当免费网盘刷爆磁盘 */
const MAX_TOTAL_MB = envNumber('J2ME_TMP_TOTAL_MB', 500, { integer: false, min: 0.001, max: 102400 })

/*
  限流额度。数字按「正常玩家玩得舒服、脚本刷不动」定：
  一个人挑 jar 试玩，一分钟内传三五个很正常（换游戏、传错了重传），10 次足够宽；
  一小时 60 次已经远超任何真人。全站那道是**真正的兜底**：反代没透传真实 IP 时
  （Cloudflare 在前面而 nginx 只写了 $remote_addr）所有人会塌缩成同一个 key，
  这时候按 IP 限流会误伤真实用户，所以那一档直接跳过、只留全站闸 ——
  和 codes.js 里发验证码那条路的取舍完全一致。
*/
const UPLOAD_PER_IP_PER_MIN = envNumber('J2ME_UPLOAD_PER_IP_MIN', 10, { max: 100000 })
const UPLOAD_PER_IP_PER_HOUR = envNumber('J2ME_UPLOAD_PER_IP_HOUR', 60, { max: 100000 })
const UPLOAD_GLOBAL_PER_MIN = envNumber('J2ME_UPLOAD_GLOBAL_MIN', 120, { max: 100000 })
const MINUTE = 60_000
const HOUR = 3_600_000
/** 反代没透传真实 IP 时只警告一次，别每次上传刷一行日志 */
let warnedNoRealIp = false

/** 只允许简单文件名，挡掉 ../ 之类的路径穿越 */
const SAFE_NAME = /^[A-Za-z0-9._-]+\.(jar|jad)$/i
/** 临时文件用固定格式的随机名，便于和正式 ROM 区分 */
const TMP_NAME = /^tmp-[a-f0-9]{32}\.jar$/i

const store = new TemporaryJarStore({ directory: TMP_DIR, maxBytes: MAX_TOTAL_MB * 1024 * 1024, ttlMs: TTL_MS })
const MAX_UPLOADS = envNumber('J2ME_UPLOAD_CONCURRENCY', 4, { max: 64 })
const MAX_PROXIES = envNumber('J2ME_PROXY_CONCURRENCY', 4, { max: 64 })
const PROXY_BYTES = Math.floor(envNumber('J2ME_PROXY_MAX_MB', 64, { integer: false, min: 0.001, max: 512 }) * 1024 * 1024)
const PROXY_TIMEOUT = envNumber('J2ME_PROXY_TIMEOUT_MS', 30000, { max: 300000 })
const UPLOAD_LEASE = Symbol('j2meUploadLease')
let activeUploads = 0
let activeProxies = 0

/** Async cleanup; return value is now a Promise. All internal callers await/catch it. */
export function sweepTmp() { return store.sweep() }
export function startSweeper() {
  const sweep = () => { void sweepTmp().catch(e => console.error('[j2me] 清理失败：', e.message)) }
  sweep()
  const timer = setInterval(sweep, Math.max(60_000, Math.floor(TTL_MS / 3)))
  timer.unref?.()
  return timer
}
function requestName(req) {
  try { return (typeof req.body === 'string' ? JSON.parse(req.body) : req.body)?.name || '' }
  catch { return '' }
}
export async function keepaliveJar(req, res) {
  try { await store.touch(requestName(req)) }
  catch (e) { console.error('[j2me] 续期失败：', e.message) }
  if (!res.destroyed) res.status(204).end()
}

/* ---------------- 上传 ---------------- */

/**
 * POST /api/j2me/upload
 * 请求体就是 jar 的原始字节（Content-Type: application/java-archive）。
 * 用原始 body 而不是 multipart，省掉一个依赖。
 * 返回 { name }，前端拿去拼 run.html?jar=<name>。
 */
/**
 * 上传的闸。**必须挂在 express.raw 之前**（见 index.js 的挂载点）。
 *
 * ## 为什么是一个独立的中间件，而不是 uploadJar 里的头几行
 *
 * 它原来就写在 uploadJar 开头，注释还写着「限流放在最前面 —— 挡掉的请求不该再花
 * 任何 CPU 或磁盘」。但那句话在实际的中间件顺序下**不成立**：
 *
 *     app.post('/api/j2me/upload', express.raw({ limit: 20MB }), uploadJar)
 *                                  └─ 这一步跑完，20MB 已经整个进内存了 ─┘
 *
 * 也就是说被拒的第 121 次请求，和被放行的前 120 次一样，各自先吃掉 20MB。
 * 未认证的内存放大器。拆成独立中间件之后，429 是在读 body 之前发出去的。
 *
 * 顺带补一道 Content-Length 预检：超了直接断连接，不给它机会把字节送完。
 * 这个头可以缺（chunked 传输），缺的时候 express.raw 的 limit 仍然兜着。
 */
export function uploadGate(req, res, next) {
  // 预检：声明了就信，超了当场拒。省掉 20MB 的内存和一次完整的接收
  const len = Number(req.headers['content-length'])
  if (Number.isFinite(len) && len > MAX_BYTES) {
    res.on('finish', () => {
      try {
        req.destroy()
      } catch {
        /* 连接已经没了，无所谓 */
      }
    })
    return res.status(413).json({ error: `jar 不能超过 ${Math.round(MAX_BYTES / 1024 / 1024)}MB` })
  }

  const ip = clientKey(req)
  if (isMeaningfulIp(ip)) {
    const perMin = take(`j2me:up:ip:${ip}`, UPLOAD_PER_IP_PER_MIN, MINUTE)
    if (!perMin.ok) return res.status(429).json({ error: '上传太频繁了，请稍后再试', retryAfter: perMin.retryAfter })
    const perHour = take(`j2me:up:ip:h:${ip}`, UPLOAD_PER_IP_PER_HOUR, HOUR)
    if (!perHour.ok) return res.status(429).json({ error: '上传次数过多，请稍后再试', retryAfter: perHour.retryAfter })
  } else if (!warnedNoRealIp) {
    warnedNoRealIp = true
    console.warn(
      '[j2me] 拿不到真实客户端 IP，按 IP 的上传限流已跳过，只剩全站兜底。' +
        ' 让 nginx 透传真实 IP 即可恢复：proxy_set_header X-Forwarded-For $http_cf_connecting_ip;',
    )
  }
  const global = take('j2me:up:global', UPLOAD_GLOBAL_PER_MIN, MINUTE)
  if (!global.ok) {
    console.warn('[j2me] 全站上传配额已用尽 —— 可能正在被刷，检查 nginx 是否透传了真实 IP')
    return res.status(429).json({ error: '当前上传请求过多，请稍后再试', retryAfter: global.retryAfter })
  }
  if (activeUploads >= MAX_UPLOADS) {
    res.setHeader('Retry-After', '1')
    return res.status(503).json({ error: '上传繁忙，请稍后重试' })
  }
  activeUploads++
  let released = false
  const lease = { processing: false, release: null }
  req[UPLOAD_LEASE] = lease
  const onResponseDone = () => { if (!lease.processing) release() }
  const release = () => {
    if (released) return
    released = true
    activeUploads--
    res.off('finish', onResponseDone)
    res.off('close', onResponseDone)
  }
  lease.release = release
  res.once('finish', onResponseDone)
  res.once('close', onResponseDone)
  next()
}

export async function uploadJar(req, res) {
  if (req[UPLOAD_LEASE]) req[UPLOAD_LEASE].processing = true
  try {
    // ⚠️ 限流和大小预检在 uploadGate 里，它挂在 express.raw **之前**（见 index.js）。
    // 别把那几行搬回来 —— 搬回来就等于「先收 20MB 再说拒绝」。
    const buf = req.body
    if (!Buffer.isBuffer(buf) || buf.length === 0) {
      return res.status(400).json({ error: '请求体为空' })
    }
    if (buf.length > MAX_BYTES) {
      return res.status(413).json({ error: `文件超过 ${MAX_MB} MB` })
    }
    try {
      assertJarBuffer(buf)
    } catch (e) {
      return res.status(400).json({ error: `不是有效的 J2ME JAR：${e.message}` })
    }

    const name = await store.put(buf)
    if (res.destroyed) {
      await store.remove(name)
      return
    }
    res.json({ name, expiresInMs: TTL_MS })
  } catch (e) {
    console.error('[j2me] 上传失败：', e.message)
    if (!res.destroyed && !res.headersSent) {
      res.status(e.code === 'J2ME_QUOTA' ? 507 : 500).json({ error: e.code === 'J2ME_QUOTA' ? '服务器临时空间已满，请稍后再试' : '上传失败' })
    }
  } finally {
    req[UPLOAD_LEASE]?.release()
  }
}

/**
 * POST /api/j2me/release
 * 玩家关闭页面 / 切换游戏时调用。body: { name }
 * 用 POST 而不是 DELETE —— navigator.sendBeacon 只能发 POST。
 * 这是「尽力而为」：真没收到也没关系，上面的定时清扫会兜底。
 */
export async function releaseJar(req, res) {
  try { await store.remove(requestName(req)) }
  catch (e) { console.error('[j2me] 释放失败：', e.message) }
  if (!res.destroyed) res.status(204).end()
}

/* ---------------- 取 jar ---------------- */

/**
 * GET /j2me/jar/:name
 * 注册在 express.static 之后，所以 public/j2me/jar/ 里已有的文件优先。
 * 这里依次尝试：临时上传目录 -> 对象存储。
 */
export async function j2meJarProxy(req, res) {
  const name = req.params.name || ''
  if (!SAFE_NAME.test(name)) return res.status(400).send('bad name')

  // 1. 玩家临时上传的
  if (TMP_NAME.test(name)) {
    const p = path.join(TMP_DIR, name)
    let exists = false
    try { exists = await store.touch(name) } catch { /* Handled as missing below. */ }
    if (exists) {
      res.setHeader('Content-Type', 'application/java-archive')
      res.setHeader('X-Content-Type-Options', 'nosniff')
      res.setHeader('Cache-Control', 'no-store')
      // 这里刻意不再声明 Accept-Ranges：本分支根本没实现 Range，
      // 声明了会让客户端发 Range 请求然后每次都拿到整包。
      if (req.method === 'HEAD') return res.status(200).end()
      const stream = createReadStream(p)
      const onClose = () => stream.destroy()
      res.once('close', onClose)
      stream.once('close', () => res.off('close', onClose))
      // pipe 不转发错误。existsSync 与真正 open 之间有窗口，文件可能刚好被
      // release / TTL 清扫删掉 —— 没有这个监听，ENOENT 会变成未捕获异常直接杀掉进程。
      stream.on('error', (err) => {
        console.error('[j2me] 读取临时 jar 失败：', err.message)
        if (!res.headersSent) res.status(404).send('临时文件已过期')
        else res.destroy()
      })
      return stream.pipe(res)
    }
    return res.status(404).send('临时文件已过期')
  }

  // 2. 对象存储
  if (!ROM_BASE) return res.status(404).send('ROM_BASE_URL 未配置')
  const target = `${ROM_BASE}/${ROM_PREFIX}/java/${encodeURIComponent(name)}`
  if (activeProxies >= MAX_PROXIES) {
    res.setHeader('Retry-After', '1')
    return res.status(503).send('jar 代理繁忙')
  }
  activeProxies++
  const controller = new AbortController()
  const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(PROXY_TIMEOUT)])
  const onClose = () => { if (!res.writableEnded) controller.abort(new Error('Client disconnected')) }
  res.once('close', onClose)
  try {
    /*
      条件请求要**原样转给上游**（2026-09-07 补）。

      背景：freej2me-web 只能吃纯文件名，所以适配器把播放地址上那个
      `?romv=<etag>` 缓存戳丢掉了（见 src/emulator/j2meUrl.ts 的 j2meFileName）——
      全站别的平台靠那个戳换缓存，J2ME 这条路上没有。
      而这里原来给的是 `Cache-Control: public, max-age=86400`：
      **管理员重传了一个 J2ME 的 ROM，玩家最多一整天还在玩旧包**，
      而且完全看不出为什么（页面刷了、后台也显示新文件）。

      修法不是把缓存关掉（每次开局重下几百 KB 也不必要），而是让它**每次都回来问一句**：
      下面 Cache-Control 改成 must-revalidate + max-age=0，浏览器于是带
      If-None-Match 回来；我们把它转给 R2，没变就原样透传 304，一个字节都不用传。
      ETag 本来就已经在往下转了，这条链是通的。
    */
    const headers = {}
    if (req.headers.range) headers.range = req.headers.range
    if (req.headers['if-none-match']) headers['if-none-match'] = req.headers['if-none-match']
    if (req.headers['if-modified-since']) headers['if-modified-since'] = req.headers['if-modified-since']
    if (req.headers['if-range']) headers['if-range'] = req.headers['if-range']
    const upstream = await fetch(target, { headers, signal, method: req.method === 'HEAD' ? 'HEAD' : 'GET' })

    /*
      304 必须在 `upstream.ok` 那道判断**之前**处理：304 不在 2xx 里，
      掉到下面就会变成 `res.status(304).send('上游返回 304')` —— 给 304 带 body
      是不合法的响应，浏览器那边表现成「文件坏了」。
      而且 304 本来就没有 body，不能去 arrayBuffer()、更不能拿去验 JAR。
    */
    if (upstream.status === 304) {
      for (const h of ['etag', 'last-modified', 'cache-control']) {
        const v = upstream.headers.get(h)
        if (v) res.setHeader(h, v)
      }
      res.setHeader('Cache-Control', 'public, max-age=0, must-revalidate')
      return res.status(304).end()
    }

    if (!upstream.ok && upstream.status !== 206) {
      await upstream.body?.cancel().catch(() => {})
      return res.status(upstream.status).send(`上游返回 ${upstream.status}`)
    }
    if (req.method === 'HEAD') {
      for (const h of ['content-type', 'content-length', 'content-range', 'accept-ranges', 'etag', 'last-modified']) {
        const value = upstream.headers.get(h)
        if (value) res.setHeader(h, value)
      }
      res.setHeader('Cache-Control', 'public, max-age=0, must-revalidate')
      await upstream.body?.cancel().catch(() => {})
      return res.status(upstream.status).end()
    }
    const body = await readResponseBuffer(upstream, PROXY_BYTES, signal)
    // 普通完整响应在转给 FreeJ2ME 前先验一次；Range 响应只有局部字节，不能冒充完整 JAR 去验。
    if (upstream.status === 200 && name.toLowerCase().endsWith('.jar')) {
      try {
        assertJarBuffer(body)
      } catch (e) {
        console.error(`[j2me] 上游 JAR 无效 ${name}:`, e.message)
        return res.status(502).send('上游 JAR 已损坏或格式不正确')
      }
    }
    res.status(upstream.status)
    for (const h of ['content-type', 'content-range', 'accept-ranges', 'etag', 'last-modified']) {
      const v = upstream.headers.get(h)
      if (v) res.setHeader(h, v)
    }
    // Node fetch 可能已经把 gzip/br 响应解压；沿用上游 Content-Length 会让浏览器只读到半截。
    res.setHeader('Content-Length', String(body.length))
    // 见上面那段：不能强缓存一天，否则重传 ROM 之后玩家还在玩旧包。
    // 每次回来问一句，没变就是一个 304（上面那一支），成本可以忽略。
    res.setHeader('Cache-Control', 'public, max-age=0, must-revalidate')
    res.end(body)
  } catch (e) {
    console.error('[j2me] jar 代理失败：', e.message)
    if (!res.destroyed && !res.headersSent) res.status(signal.aborted && !controller.signal.aborted ? 504 : 502).send('jar 获取失败')
  } finally {
    res.off('close', onClose)
    activeProxies--
  }
}

export { MAX_BYTES, TTL_MS }
