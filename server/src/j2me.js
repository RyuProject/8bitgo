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
 *    体积上限、魔数校验、随机文件名、总量上限、定时清扫。
 */
import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, statSync, unlinkSync, utimesSync, writeFileSync, createReadStream } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// 公开 R2 域名不是机密，给线上同源 JAR 代理一个可用默认值。
// 否则前端运行时装好了，服务器少一行 server/.env 仍会让全部云端 JAR 404。
const ROM_BASE = (process.env.ROM_BASE_URL || 'https://assets.8bitgo.com').replace(/\/+$/, '')
const ROM_PREFIX = (process.env.ROM_PREFIX || 'roms').replace(/^\/+|\/+$/g, '')

/** 临时上传目录。默认在 server/tmp/j2me，可用 J2ME_TMP_DIR 覆盖。 */
export const TMP_DIR = process.env.J2ME_TMP_DIR
  ? path.resolve(process.env.J2ME_TMP_DIR)
  : path.resolve(fileURLToPath(new URL('../tmp/j2me', import.meta.url)))

const MAX_MB = Number(process.env.J2ME_MAX_UPLOAD_MB || 20)
const MAX_BYTES = MAX_MB * 1024 * 1024
/** 兜底清扫：超过这个时间的临时文件一律删除，哪怕浏览器没来得及通知 */
const TTL_MS = Number(process.env.J2ME_TMP_TTL_MS || 30 * 60_000)
/** 临时目录总量上限，防止被人当免费网盘刷爆磁盘 */
const MAX_TOTAL_MB = Number(process.env.J2ME_TMP_TOTAL_MB || 500)

/** 只允许简单文件名，挡掉 ../ 之类的路径穿越 */
const SAFE_NAME = /^[A-Za-z0-9._-]+\.(jar|jad)$/i
/** 临时文件用固定格式的随机名，便于和正式 ROM 区分 */
const TMP_NAME = /^tmp-[a-f0-9]{32}\.jar$/i

function ensureDir() {
  if (!existsSync(TMP_DIR)) mkdirSync(TMP_DIR, { recursive: true })
}

function listTmp() {
  ensureDir()
  return readdirSync(TMP_DIR)
    .filter((f) => TMP_NAME.test(f))
    .map((f) => {
      const p = path.join(TMP_DIR, f)
      try {
        return { name: f, path: p, ...statSync(p) }
      } catch {
        return null
      }
    })
    .filter(Boolean)
}

/** 删除过期的临时 jar。浏览器没通知到（崩溃 / 断网 / 强杀）时靠这个兜底。 */
export function sweepTmp() {
  const now = Date.now()
  let removed = 0
  for (const f of listTmp()) {
    if (now - f.mtimeMs > TTL_MS) {
      try {
        unlinkSync(f.path)
        removed++
      } catch {
        /* 已经被删了就算了 */
      }
    }
  }
  if (removed) console.log(`[j2me] 清理过期临时 jar ${removed} 个`)
  return removed
}

/** 启动定时清扫。间隔取 TTL 的 1/3，至少 1 分钟。 */
export function startSweeper() {
  ensureDir()
  sweepTmp()
  const every = Math.max(60_000, Math.floor(TTL_MS / 3))
  const timer = setInterval(sweepTmp, every)
  timer.unref?.()
  return timer
}

/** 刷新文件的修改时间，等于给它续期 */
function touch(p) {
  try {
    const now = new Date()
    utimesSync(p, now, now)
  } catch {
    /* 文件刚好被删了就算了 */
  }
}

/**
 * POST /api/j2me/keepalive   body: { name }
 * 玩家还在玩的时候前端定时调用，给临时文件续期。
 * 没有这个的话，连续玩超过 TTL 会被清扫掉，游戏中途读不到 jar。
 */
export function keepaliveJar(req, res) {
  let name = ''
  try {
    const b = req.body
    name = typeof b === 'string' ? JSON.parse(b).name : b?.name || ''
  } catch {
    /* 忽略 */
  }
  if (!TMP_NAME.test(name || '')) return res.status(204).end()
  const p = path.join(TMP_DIR, name)
  if (existsSync(p)) touch(p)
  res.status(204).end()
}

/* ---------------- 上传 ---------------- */

/**
 * POST /api/j2me/upload
 * 请求体就是 jar 的原始字节（Content-Type: application/java-archive）。
 * 用原始 body 而不是 multipart，省掉一个依赖。
 * 返回 { name }，前端拿去拼 run.html?jar=<name>。
 */
export function uploadJar(req, res) {
  try {
    const buf = req.body
    if (!Buffer.isBuffer(buf) || buf.length === 0) {
      return res.status(400).json({ error: '请求体为空' })
    }
    if (buf.length > MAX_BYTES) {
      return res.status(413).json({ error: `文件超过 ${MAX_MB} MB` })
    }
    // jar 就是 zip：校验魔数，挡掉随便传别的东西
    if (!(buf[0] === 0x50 && buf[1] === 0x4b && (buf[2] === 0x03 || buf[2] === 0x05 || buf[2] === 0x07))) {
      return res.status(400).json({ error: '不是有效的 .jar（ZIP）文件' })
    }

    sweepTmp()

    // 总量上限
    const total = listTmp().reduce((s, f) => s + f.size, 0)
    if (total + buf.length > MAX_TOTAL_MB * 1024 * 1024) {
      return res.status(507).json({ error: '服务器临时空间已满，请稍后再试' })
    }

    ensureDir()
    // 每次上传给一个**唯一**的文件名。
    //
    // 以前是按内容 sha256 命名、内容相同就复用同一个物理文件 —— 省空间，但两个人
    // （或同一个人开两个标签页）玩同一个 .jar 时会共用一个文件，谁先关页面，
    // release 就把文件删了，另一个人当场 404「临时文件已过期」，游戏中途挂掉。
    // 这也等于给了任何人一个「上传同一个 jar → 立刻 release」删掉别人文件的口子。
    // 临时文件本来就有 TTL 和总量上限兜着，重复一点空间换正确性是划算的。
    const name = `tmp-${randomBytes(16).toString('hex')}.jar`
    const dest = path.join(TMP_DIR, name)
    writeFileSync(dest, buf)

    res.json({ name, expiresInMs: TTL_MS })
  } catch (e) {
    console.error('[j2me] 上传失败：', e.message)
    res.status(500).json({ error: '上传失败' })
  }
}

/**
 * POST /api/j2me/release
 * 玩家关闭页面 / 切换游戏时调用。body: { name }
 * 用 POST 而不是 DELETE —— navigator.sendBeacon 只能发 POST。
 * 这是「尽力而为」：真没收到也没关系，上面的定时清扫会兜底。
 */
export function releaseJar(req, res) {
  let name = ''
  try {
    const b = req.body
    name = typeof b === 'string' ? JSON.parse(b).name : b?.name || ''
  } catch {
    /* 解析失败按空处理 */
  }
  if (!TMP_NAME.test(name || '')) return res.status(204).end()
  try {
    unlinkSync(path.join(TMP_DIR, name))
  } catch {
    /* 不存在就算了 */
  }
  res.status(204).end()
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
    if (existsSync(p)) {
      // 取一次就续一次命：正在玩的游戏不该被 TTL 清扫掉
      touch(p)
      res.setHeader('Content-Type', 'application/java-archive')
      res.setHeader('X-Content-Type-Options', 'nosniff')
      res.setHeader('Cache-Control', 'no-store')
      // 这里刻意不再声明 Accept-Ranges：本分支根本没实现 Range，
      // 声明了会让客户端发 Range 请求然后每次都拿到整包。
      const stream = createReadStream(p)
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
  try {
    const headers = {}
    if (req.headers.range) headers.range = req.headers.range
    const upstream = await fetch(target, { headers })
    if (!upstream.ok && upstream.status !== 206) {
      return res.status(upstream.status).send(`上游返回 ${upstream.status}`)
    }
    res.status(upstream.status)
    for (const h of ['content-type', 'content-length', 'content-range', 'accept-ranges', 'etag', 'last-modified']) {
      const v = upstream.headers.get(h)
      if (v) res.setHeader(h, v)
    }
    res.setHeader('Cache-Control', 'public, max-age=86400')
    res.end(Buffer.from(await upstream.arrayBuffer()))
  } catch (e) {
    console.error('[j2me] jar 代理失败：', e.message)
    res.status(502).send('jar 获取失败')
  }
}

export { MAX_BYTES, TTL_MS }
