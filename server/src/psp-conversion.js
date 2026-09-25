/**
 * PSP ISO -> CHD 后台转换队列。
 *
 * 浏览器仍负责把大 ISO 通过现有 R2 分片接口上传到随机临时 key；服务器只接收 key，
 * 不接收几 GB 的请求体。这样刷新页面不会中断 R2 续传，Cloudflare 的单请求上限也不会
 * 卡住源文件。真正的压缩必须在有本地磁盘的源站做：chdman 需要随机读取输入和输出，
 * 放进 Worker 既超 CPU / 内存预算，也没法可靠地从中断位置恢复。
 *
 * 任务状态落 MySQL。进程中途退出时，下一次启动会把 running 状态改回 queued；R2 上未
 * complete 的旧 multipart 会先中止，再从头发布。最终对象只在 complete 那一刻可见，
 * 玩家永远不会读到半份 CHD。
 */
import { randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import { constants as fsConstants } from 'node:fs'
import { access, mkdir, open, rm, stat, statfs } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { query, queryOne, withTransaction } from './db.js'
import { invalidateContent } from './content.js'

const ACTIVE = new Set(['queued', 'downloading', 'converting', 'verifying', 'uploading'])
const INTERRUPTED = ['downloading', 'converting', 'verifying', 'uploading']
const ROM_LANGS = new Set(['zh-Hans', 'zh-Hant', 'en', 'ja'])
const PART_BYTES = 8 * 1024 * 1024
const FETCH_ATTEMPTS = 4
const SOURCE_IDLE_MS = 60_000
const WORKER_REQUEST_TIMEOUT_MS = 60_000
const COMMAND_PROBE_TIMEOUT_MS = 5_000
const MAX_ERROR_CHARS = 900

let started = false
let activeWorkers = 0
let pumpTimer
let sweepTimer
let capabilityCache

function positiveInt(raw, fallback, max = Number.MAX_SAFE_INTEGER) {
  if (raw === undefined || raw === '') return fallback
  const value = Number(raw)
  return Number.isSafeInteger(value) && value > 0 && value <= max ? value : fallback
}

export function pspConversionConfig(env = process.env) {
  const workerUrl = String(env.PSP_CONVERT_WORKER_URL || '').trim().replace(/\/+$/, '')
  const workerToken = String(env.PSP_CONVERT_WORKER_TOKEN || env.ADMIN_TOKEN || '').trim()
  const tempDir = resolve(String(env.PSP_CONVERT_TMP_DIR || new URL('../tmp/psp-conversions', import.meta.url).pathname))
  return {
    workerUrl,
    workerToken,
    chdman: String(env.PSP_CHDMAN_BIN || 'chdman').trim() || 'chdman',
    tempDir,
    maxIsoBytes: positiveInt(env.PSP_CONVERT_MAX_ISO_MB, 2560, 16 * 1024) * 1024 * 1024,
    concurrency: positiveInt(env.PSP_CONVERT_CONCURRENCY, 1, 2),
    timeoutMs: positiveInt(env.PSP_CONVERT_TIMEOUT_MINUTES, 180, 24 * 60) * 60 * 1000,
  }
}

/** key 只允许普通对象路径；拒绝控制字符、反斜杠和目录穿越。 */
export function validObjectKey(value) {
  const key = String(value || '')
  // eslint-disable-next-line no-control-regex -- 对象 key 的边界必须明确拒绝 C0 / DEL。
  const hasControlCharacter = /[\x00-\x1f\x7f]/.test(key)
  return key.length > 0 && key.length <= 500 && !key.startsWith('/') && !key.endsWith('/') &&
    !key.includes('..') && !key.includes('\\') && !key.includes('//') && !hasControlCharacter
}

export function validatePspConversionRequest(body, env = process.env) {
  const sourceKey = String(body?.sourceKey || '').trim()
  const targetKey = String(body?.targetKey || '').trim()
  const sourceSize = Number(body?.sourceSize)
  const gameSlug = String(body?.gameSlug || '').trim()
  const lang = String(body?.lang || '').trim()
  const expectedCurrentKey = String(body?.expectedCurrentKey || '').trim()

  if (!validObjectKey(sourceKey) || !/^psp-staging\/[a-f0-9-]{16,}\.iso$/i.test(sourceKey)) {
    throw Object.assign(new Error('临时 ISO key 无效'), { status: 400 })
  }
  if (!validObjectKey(targetKey) || !/(^|\/)psp\/[^/]+\.chd$/i.test(targetKey)) {
    throw Object.assign(new Error('最终 PSP 对象必须是 psp 目录下的 .chd'), { status: 400 })
  }
  if (sourceKey === targetKey) throw Object.assign(new Error('临时源文件和最终文件不能使用同一个 key'), { status: 400 })
  const max = pspConversionConfig(env).maxIsoBytes
  if (!Number.isSafeInteger(sourceSize) || sourceSize < 32 * 1024 || sourceSize > max) {
    throw Object.assign(new Error(`ISO 大小必须在 32KB 到 ${Math.round(max / 1024 / 1024)}MB 之间`), { status: 400 })
  }
  if (gameSlug && !/^[a-z0-9][a-z0-9-]{0,119}$/.test(gameSlug)) {
    throw Object.assign(new Error('游戏 slug 无效'), { status: 400 })
  }
  if (lang && !ROM_LANGS.has(lang)) throw Object.assign(new Error('ROM 语言无效'), { status: 400 })
  if ((gameSlug && !lang) || (!gameSlug && lang)) {
    throw Object.assign(new Error('自动绑定需要同时提供游戏 slug 和语言'), { status: 400 })
  }
  if (expectedCurrentKey.length > 500 || (expectedCurrentKey && !validObjectKey(expectedCurrentKey) && !/^https?:\/\//i.test(expectedCurrentKey))) {
    throw Object.assign(new Error('当前 ROM key 无效'), { status: 400 })
  }
  return {
    sourceKey,
    targetKey,
    sourceSize,
    gameSlug: gameSlug || null,
    lang: lang || null,
    expectedCurrentKey,
    overwrite: body?.overwrite === true,
  }
}

export function chdmanCreateArgs(input, output) {
  // PSP 官方建议：createdvd + 2048-byte hunk。createcd 虽能打开，但旧核心上随机读性能很差。
  return ['createdvd', '-hs', '2048', '-c', 'zstd', '-i', input, '-o', output]
}

export function chdmanProgress(text) {
  const hits = [...String(text || '').matchAll(/(?:^|\s)(\d{1,3}(?:\.\d+)?)%/g)]
  if (!hits.length) return null
  const value = Number(hits.at(-1)[1])
  return Number.isFinite(value) ? Math.max(0, Math.min(100, value)) : null
}

/** 只认真正的 PSP ISO9660 标识，避免把 Worker 的 200 + HTML 错误页压成一份“合法 CHD”。 */
export function isPspIsoHeader(bytes) {
  const data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes || 0)
  if (data.length < 0x8010) return false
  const ascii = (at, len) => String.fromCharCode(...data.subarray(at, at + len))
  return ascii(0x8001, 5) === 'CD001' && ascii(0x8008, 8) === 'PSP GAME'
}

function encodeKey(key) {
  return key.split('/').map((part) => encodeURIComponent(part)).join('/')
}

function workerHeaders(config, extra = {}) {
  return { Authorization: `Bearer ${config.workerToken}`, ...extra }
}

async function workerRequest(config, key, options = {}) {
  const { query: search = '', ...init } = options
  return fetch(`${config.workerUrl}/${encodeKey(key)}${search}`, {
    ...init,
    // 队列并发默认只有 1；一次失联如果永久挂起，后面所有 ISO 都会永远排队。
    signal: init.signal || AbortSignal.timeout(WORKER_REQUEST_TIMEOUT_MS),
    headers: workerHeaders(config, init.headers),
  })
}

async function remoteHead(config, key) {
  const response = await workerRequest(config, key, { method: 'HEAD' })
  if (response.status === 404) return null
  if (!response.ok) throw new Error(`对象存储 HEAD ${key} 失败：HTTP ${response.status}`)
  const size = Number(response.headers.get('content-length'))
  const etag = response.headers.get('etag') || ''
  if (!Number.isSafeInteger(size) || size < 0 || !etag) throw new Error(`对象存储没有返回 ${key} 的完整大小或 ETag`)
  return { size, etag }
}

/** 空串明确表示“创建任务时目标不存在”，不是“不知道”；这一区分决定能不能安全覆盖。 */
export function objectVersionMatches(head, expectedEtag) {
  return (head?.etag || '') === String(expectedEtag || '')
}

async function commandExists(bin) {
  if (bin.includes('/')) {
    try {
      await access(bin, fsConstants.X_OK)
      return true
    } catch {
      return false
    }
  }
  return new Promise((resolveAvailable) => {
    const child = spawn(bin, ['help'], { stdio: 'ignore' })
    let done = false
    const finish = (available) => {
      if (done) return
      done = true
      clearTimeout(timer)
      resolveAvailable(available)
    }
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      finish(false)
    }, COMMAND_PROBE_TIMEOUT_MS)
    timer.unref?.()
    child.once('error', (error) => finish(error?.code !== 'ENOENT'))
    child.once('exit', () => finish(true))
  })
}

export async function pspConversionCapability(env = process.env, fresh = false) {
  if (!fresh && capabilityCache && Date.now() - capabilityCache.at < 30_000) return capabilityCache.value
  const config = pspConversionConfig(env)
  let reason = ''
  if (!config.workerUrl) reason = '服务器未配置 PSP_CONVERT_WORKER_URL'
  else if (!config.workerToken) reason = '服务器未配置 PSP_CONVERT_WORKER_TOKEN（可与 Worker 的 ADMIN_TOKEN 相同）'
  else if (!(await commandExists(config.chdman))) reason = `找不到 chdman：${config.chdman}`
  else {
    try {
      const row = await queryOne(
        "SELECT COUNT(*) AS n FROM information_schema.TABLES WHERE table_schema = DATABASE() AND table_name = 'psp_conversion_jobs'",
      )
      if (!Number(row?.n)) reason = '数据库缺少 psp_conversion_jobs；请在 server 目录执行 npm run migrate'
      else {
        const columns = await queryOne(
          `SELECT COUNT(*) AS n FROM information_schema.COLUMNS
            WHERE table_schema = DATABASE() AND table_name = 'psp_conversion_jobs'
              AND column_name IN ('target_etag_before', 'output_etag', 'game_id')`,
        )
        if (Number(columns?.n) !== 3) reason = 'psp_conversion_jobs 结构过旧；请在 server 目录重新执行 npm run migrate'
      }
    } catch {
      reason = '暂时无法检查 PSP 转换任务表'
    }
  }
  const value = { available: !reason, reason, maxIsoBytes: config.maxIsoBytes, format: 'CHD (zstd, 2048-byte hunk)' }
  capabilityCache = { at: Date.now(), value }
  return value
}

function publicJob(row) {
  if (!row) return null
  return {
    id: row.id,
    sourceKey: row.source_key,
    targetKey: row.target_key,
    status: row.status,
    progress: Number(row.progress) || 0,
    sourceSize: Number(row.source_size) || 0,
    outputSize: row.output_size == null ? null : Number(row.output_size),
    gameSlug: row.game_slug || null,
    lang: row.lang || null,
    bound: Boolean(row.bound),
    message: row.message || '',
    error: row.error || '',
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    completedAt: row.completed_at,
  }
}

export async function inspectPspSource(request, env = process.env) {
  const config = pspConversionConfig(env)
  const head = await remoteHead(config, request.sourceKey)
  if (!head) throw Object.assign(new Error('临时 ISO 不存在；请重新上传'), { status: 404 })
  if (head.size !== request.sourceSize) {
    throw Object.assign(new Error(`临时 ISO 大小不符：R2 是 ${head.size} 字节，浏览器上报 ${request.sourceSize} 字节`), { status: 409 })
  }
  const target = await remoteHead(config, request.targetKey)
  if (target && !request.overwrite) {
    throw Object.assign(new Error('最终 CHD 已存在；需要明确确认覆盖'), { status: 409 })
  }
  return { ...head, targetExists: Boolean(target), targetEtag: target?.etag || '' }
}

function sameCreateRequest(row, request) {
  return row.source_key === request.sourceKey &&
    row.target_key === request.targetKey &&
    Number(row.source_size) === request.sourceSize &&
    (row.game_slug || '') === (request.gameSlug || '') &&
    (row.lang || '') === (request.lang || '') &&
    (row.expected_current_key || '') === request.expectedCurrentKey &&
    Boolean(row.allow_overwrite) === request.overwrite
}

async function existingJobForSource(request) {
  const row = await queryOne('SELECT * FROM psp_conversion_jobs WHERE source_key = ?', [request.sourceKey])
  if (!row) return null
  if (!sameCreateRequest(row, request)) {
    throw Object.assign(new Error('这个临时 ISO 已属于另一项转换任务，拒绝复用到不同目标'), { status: 409 })
  }
  return publicJob(row)
}

export async function createPspConversion(raw, actorId = null, env = process.env) {
  const capability = await pspConversionCapability(env)
  if (!capability.available) throw Object.assign(new Error(capability.reason), { status: 503 })
  const request = validatePspConversionRequest(raw, env)
  // POST 必须幂等：服务端已建任务但响应途中断线时，浏览器重试只能拿回原任务，不能再压一份。
  const existing = await existingJobForSource(request)
  if (existing) return existing
  let gameId = null
  if (request.gameSlug) {
    const game = await queryOne('SELECT id, platform FROM games WHERE slug = ?', [request.gameSlug])
    if (!game) throw Object.assign(new Error('要自动绑定的游戏不存在；请刷新后台后重试'), { status: 409 })
    if (game.platform !== 'psp') throw Object.assign(new Error('要自动绑定的游戏已经不是 PSP 平台'), { status: 409 })
    gameId = game.id
  }
  const source = await inspectPspSource(request, env)
  const id = randomUUID()
  try {
    await query(
      `INSERT INTO psp_conversion_jobs
       (id, source_key, target_key, source_size, source_etag, target_etag_before, game_id, game_slug, lang,
        expected_current_key, allow_overwrite, actor_id, status, progress)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', 0)`,
      [id, request.sourceKey, request.targetKey, request.sourceSize, source.etag, source.targetEtag,
        gameId, request.gameSlug, request.lang, request.expectedCurrentKey, request.overwrite ? 1 : 0, actorId],
    )
  } catch (error) {
    // 两个相同的重试可能同时越过上面的 SELECT；唯一键决定赢家，输家返回同一个任务。
    if (error?.code !== 'ER_DUP_ENTRY') throw error
    const raced = await existingJobForSource(request)
    if (raced) return raced
    throw error
  }
  schedulePump()
  return getPspConversion(id)
}

export async function getPspConversion(id) {
  return publicJob(await queryOne('SELECT * FROM psp_conversion_jobs WHERE id = ?', [id]))
}

export async function retryPspConversion(id) {
  const row = await queryOne('SELECT * FROM psp_conversion_jobs WHERE id = ?', [id])
  if (!row) return null
  if (ACTIVE.has(row.status)) return publicJob(row)
  if (row.status === 'completed') return publicJob(row)
  if (Number(row.source_deleted) !== 0) {
    throw Object.assign(new Error('临时 ISO 正在清理或已经删除，不能重试；请重新上传'), { status: 409 })
  }
  const config = pspConversionConfig()
  const source = await remoteHead(config, row.source_key)
  if (!source || source.size !== Number(row.source_size) || source.etag !== row.source_etag) {
    throw Object.assign(new Error('临时 ISO 已不存在或已改变，不能重试；请重新上传'), { status: 409 })
  }
  const claimed = await query(
    "UPDATE psp_conversion_jobs SET status = 'queued', progress = 0, error = NULL, message = '手动重试', completed_at = NULL WHERE id = ? AND status = 'failed' AND source_deleted = 0",
    [id],
  )
  if (claimed.affectedRows !== 1) {
    throw Object.assign(new Error('任务状态刚刚发生变化，请刷新后再试'), { status: 409 })
  }
  schedulePump()
  return getPspConversion(id)
}

async function updateJob(id, fields) {
  const allowed = new Set([
    'status', 'progress', 'output_size', 'output_etag', 'bound', 'message', 'error',
    'upload_id', 'upload_marker', 'upload_parts', 'completed_at', 'source_deleted',
  ])
  const entries = Object.entries(fields).filter(([key]) => allowed.has(key))
  if (!entries.length) return
  const sql = entries.map(([key]) => `\`${key}\` = ?`).join(', ')
  await query(`UPDATE psp_conversion_jobs SET ${sql} WHERE id = ?`, [...entries.map(([, value]) => value), id])
}

async function ensureDiskSpace(config, sourceSize) {
  await mkdir(config.tempDir, { recursive: true })
  const fs = await statfs(config.tempDir)
  const free = Number(fs.bavail) * Number(fs.bsize)
  // 输入 + 最坏情况下几乎不压缩的输出 + 256MB 工具/文件系统余量。
  const need = sourceSize * 2 + 256 * 1024 * 1024
  if (!Number.isFinite(free) || free < need) {
    throw new Error(`临时磁盘空间不足：至少需要 ${Math.ceil(need / 1024 / 1024)}MB 可用空间`)
  }
}

/**
 * FileHandle 的 read / write 都允许短操作；大文件在磁盘压力下不能假定一次就写完。
 * 显式位置还能避免一次短写后把下一块接到错误偏移，最终让 chdman 读到缺口。
 */
export async function writeAllAt(file, bytes, position) {
  let offset = 0
  while (offset < bytes.byteLength) {
    const { bytesWritten } = await file.write(bytes, offset, bytes.byteLength - offset, position + offset)
    if (!Number.isSafeInteger(bytesWritten) || bytesWritten <= 0) throw new Error('写入临时 ISO 时磁盘没有继续前进')
    offset += bytesWritten
  }
  return offset
}

/** 到 EOF 为止尽量填满 buffer；调用方再决定短读是正常文件尾还是损坏。 */
export async function readExactlyAt(file, buffer, position) {
  let offset = 0
  while (offset < buffer.byteLength) {
    const { bytesRead } = await file.read(buffer, offset, buffer.byteLength - offset, position + offset)
    if (!Number.isSafeInteger(bytesRead) || bytesRead < 0) throw new Error('读取 CHD 时返回了无效字节数')
    if (bytesRead === 0) break
    offset += bytesRead
  }
  return offset
}

async function downloadSource(job, config, destination) {
  const controller = new AbortController()
  let idle
  let file
  const armIdle = () => {
    clearTimeout(idle)
    idle = setTimeout(() => controller.abort(new Error('下载连续 60 秒没有收到数据')), SOURCE_IDLE_MS)
    idle.unref?.()
  }
  armIdle()
  let received = 0
  let reported = -1
  try {
    const response = await workerRequest(config, job.source_key, {
      method: 'GET',
      headers: { 'If-Match': job.source_etag },
      signal: controller.signal,
    })
    if (response.status === 412) throw new Error('临时 ISO 在任务创建后被覆盖，已拒绝把两份内容混在一起')
    if (!response.ok || !response.body) throw new Error(`下载临时 ISO 失败：HTTP ${response.status}`)
    const declared = Number(response.headers.get('content-length'))
    if (declared !== Number(job.source_size)) throw new Error('下载响应的 ISO 大小与任务记录不一致')

    file = await open(destination, 'wx')
    for await (const chunk of response.body) {
      armIdle()
      if (received + chunk.byteLength > Number(job.source_size)) throw new Error('下载数据超过 ISO 记录大小')
      await writeAllAt(file, chunk, received)
      received += chunk.byteLength
      const pct = 5 + Math.floor((received / Number(job.source_size)) * 24)
      if (pct !== reported) {
        reported = pct
        await updateJob(job.id, { progress: pct })
      }
    }
  } finally {
    clearTimeout(idle)
    if (file) await file.close()
  }
  if (received !== Number(job.source_size)) throw new Error(`ISO 下载不完整：收到 ${received}/${job.source_size} 字节`)
  // 这里只读 36KB 文件头。把 readFile 用在 1.8GB ISO 上会平白制造一份同大的内存副本，
  // 转换还没开始就可能把 Node 进程顶掉。
  const header = await open(destination, 'r').then(async (source) => {
    try {
      const bytes = Buffer.alloc(0x9000)
      const bytesRead = await readExactlyAt(source, bytes, 0)
      return bytes.subarray(0, bytesRead)
    } finally {
      await source.close()
    }
  })
  if (!isPspIsoHeader(header)) throw new Error('上传内容不是有效的 PSP ISO（缺少 CD001 / PSP GAME 标识）')
}

function runChdman(bin, args, onProgress, timeoutMs) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    let tail = ''
    let last = -1
    let timedOut = false
    let hardKill
    const timer = setTimeout(() => {
      timedOut = true
      child.kill('SIGTERM')
      hardKill = setTimeout(() => child.kill('SIGKILL'), 10_000)
      hardKill.unref?.()
    }, timeoutMs)
    timer.unref?.()
    const clearTimers = () => {
      clearTimeout(timer)
      clearTimeout(hardKill)
    }
    const collect = (chunk) => {
      const text = chunk.toString('utf8')
      tail = (tail + text).slice(-64 * 1024)
      const value = chdmanProgress(text)
      if (value != null && value !== last) {
        last = value
        onProgress?.(value)
      }
    }
    child.stdout.on('data', collect)
    child.stderr.on('data', collect)
    child.once('error', (error) => {
      clearTimers()
      rejectRun(error)
    })
    child.once('exit', (code, signal) => {
      clearTimers()
      if (timedOut) rejectRun(new Error(`chdman ${args[0]} 超过 ${Math.round(timeoutMs / 60_000)} 分钟，已终止`))
      else if (code === 0) resolveRun(tail)
      else rejectRun(new Error(`chdman ${args[0]} 失败（${signal || `exit ${code}`}）：${tail.trim().slice(-2000)}`))
    })
  })
}

async function validateChd(path, config) {
  const info = await stat(path)
  if (!info.isFile() || info.size < 4096) throw new Error('chdman 没有生成有效输出文件')
  const magic = await open(path, 'r').then(async (file) => {
    try {
      const buffer = Buffer.alloc(8)
      const bytesRead = await readExactlyAt(file, buffer, 0)
      if (bytesRead !== buffer.length) return ''
      return buffer.toString('ascii')
    } finally {
      await file.close()
    }
  })
  if (magic !== 'MComprHD') throw new Error('输出文件缺少 CHD 魔数，拒绝发布')
  await runChdman(config.chdman, ['verify', '-i', path], undefined, config.timeoutMs)
  return info.size
}

async function retryFetch(task, what) {
  let last
  for (let attempt = 0; attempt < FETCH_ATTEMPTS; attempt++) {
    try {
      const response = await task()
      if (response.ok) return response
      const text = await response.text().catch(() => '')
      const error = new Error(`${what}失败：HTTP ${response.status}${text ? ` ${text.slice(0, 300)}` : ''}`)
      if (response.status >= 400 && response.status < 500 && ![408, 409, 429].includes(response.status)) throw Object.assign(error, { fatal: true })
      last = error
    } catch (error) {
      last = error
      if (error?.fatal) throw error
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 500 * 2 ** attempt))
  }
  throw last
}

async function abortMultipartSession(config, key, uploadId, marker) {
  const qs = new URLSearchParams({ uploadId })
  if (marker) qs.set('marker', marker)
  const response = await workerRequest(config, key, { method: 'DELETE', query: `?${qs}` })
  // 中止未被 Worker 确认时必须保留 uploadId / marker；清掉数据库账本只会把收费分片变成孤儿。
  if (!response.ok && response.status !== 404) {
    const detail = await response.text().catch(() => '')
    throw new Error(`清理上次 CHD 分片会话失败：HTTP ${response.status}${detail ? ` ${detail.slice(0, 300)}` : ''}`)
  }
}

async function abortOldMultipart(job, config) {
  if (!job.upload_id) return
  await abortMultipartSession(config, job.target_key, job.upload_id, job.upload_marker)
  await updateJob(job.id, { upload_id: null, upload_marker: null, upload_parts: null })
}

async function uploadChd(job, config, path, outputSize) {
  await abortOldMultipart(job, config)
  // complete 请求可能在 R2 已提交之后才断线。先记住旧对象身份，后面就能凭 ETag 变化
  // 区分“这次其实成功了”和“这里只是看到了原来那份同尺寸 CHD”。
  const previousTarget = await remoteHead(config, job.target_key)
  if (!objectVersionMatches(previousTarget, job.target_etag_before)) {
    throw new Error('最终 CHD 在任务排队期间被其他上传修改，已停止发布，避免覆盖新文件')
  }
  if (previousTarget && !job.allow_overwrite) throw new Error('最终 CHD 在排队期间已经出现，未获授权覆盖')
  const create = await retryFetch(
    () => workerRequest(config, job.target_key, {
      method: 'POST',
      query: '?uploads',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contentType: 'application/x-mame-chd', size: outputSize, name: job.target_key.split('/').pop() }),
    }),
    '创建 CHD 分片会话',
  )
  const session = await create.json()
  if (!session?.uploadId || !session?.marker) throw new Error('Worker 没有返回有效的 CHD 分片会话')
  await updateJob(job.id, { upload_id: session.uploadId, upload_marker: session.marker, upload_parts: '[]' })

  const file = await open(path, 'r')
  const parts = []
  const total = Math.max(1, Math.ceil(outputSize / PART_BYTES))
  try {
    for (let partNumber = 1; partNumber <= total; partNumber++) {
      const length = Math.min(PART_BYTES, outputSize - (partNumber - 1) * PART_BYTES)
      const buffer = Buffer.allocUnsafe(length)
      const bytesRead = await readExactlyAt(file, buffer, (partNumber - 1) * PART_BYTES)
      if (bytesRead !== length) throw new Error(`读取 CHD 第 ${partNumber} 片不完整`)
      const response = await retryFetch(
        () => workerRequest(config, job.target_key, {
          method: 'PUT',
          query: `?uploadId=${encodeURIComponent(session.uploadId)}&partNumber=${partNumber}`,
          headers: { 'Content-Type': 'application/octet-stream', 'Content-Length': String(length) },
          body: buffer,
        }),
        `上传 CHD 第 ${partNumber}/${total} 片`,
      )
      const part = await response.json()
      if (!part?.etag) throw new Error(`Worker 没有确认 CHD 第 ${partNumber} 片`)
      parts.push({ partNumber, etag: part.etag })
      await updateJob(job.id, {
        progress: 76 + Math.floor((partNumber / total) * 22),
        upload_parts: JSON.stringify(parts),
      })
    }
  } finally {
    await file.close()
  }

  let result
  try {
    // multipart complete 本身不支持 If-Match；在最靠近提交的位置再核对一次，把覆盖竞态压到最小。
    const beforeComplete = await remoteHead(config, job.target_key)
    if (!objectVersionMatches(beforeComplete, previousTarget?.etag)) {
      await abortMultipartSession(config, job.target_key, session.uploadId, session.marker)
      await updateJob(job.id, { upload_id: null, upload_marker: null, upload_parts: null })
      throw Object.assign(new Error('上传 CHD 分片期间目标对象被修改，已中止合并，未覆盖对方文件'), { fatal: true })
    }
    const complete = await retryFetch(
      () => workerRequest(config, job.target_key, {
        method: 'POST',
        query: `?uploadId=${encodeURIComponent(session.uploadId)}`,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ parts, marker: session.marker }),
      }),
      '合并 CHD 分片',
    )
    result = await complete.json()
  } catch (error) {
    if (error?.fatal) throw error
    const after = await remoteHead(config, job.target_key).catch(() => null)
    if (!after || after.size !== outputSize || after.etag === previousTarget?.etag) throw error
    // 网络断在 complete 的响应途中，但新一代对象已经可见；不要把真成功重跑成失败。
    result = { ok: true, key: job.target_key, size: after.size, etag: after.etag }
  }
  if (result?.ok !== true || result.key !== job.target_key || Number(result.size) !== outputSize || !result.etag) {
    throw new Error('Worker 没有完整确认最终 CHD；请到 ROM 存储核查对象')
  }
  const final = await remoteHead(config, job.target_key)
  if (!final || final.size !== outputSize || final.etag !== result.etag) throw new Error('最终 CHD 的大小或 ETag 校验失败')
  await updateJob(job.id, { upload_id: null, upload_marker: null, upload_parts: null, output_etag: final.etag })
  return result
}

async function bindConvertedRom(job) {
  if (!job.game_id || !job.lang) return { bound: false, message: '游戏尚未保存；CHD 已生成，请在表单中保存绑定' }
  const result = await withTransaction(async (run) => {
    // slug 可在后台改名；数字主键是创建任务时解析并钉住的，不能在收尾时重新按名字猜游戏。
    const games = await run('SELECT id, platform FROM games WHERE id = ? FOR UPDATE', [job.game_id])
    const game = games[0]
    if (!game) return { bound: false, message: '游戏尚未入库；CHD 已生成，请保存当前游戏表单' }
    if (game.platform !== 'psp') return { bound: false, message: '游戏平台已经不是 PSP，未自动改动 ROM 绑定' }
    const rows = await run('SELECT object_key FROM game_roms WHERE game_id = ? AND lang = ? FOR UPDATE', [game.id, job.lang])
    const current = rows[0]?.object_key || ''
    if (current === job.target_key) return { bound: true, message: '最终 CHD 已经绑定' }
    if (current !== (job.expected_current_key || '')) {
      return { bound: false, message: 'ROM 绑定在转换期间被别人修改，已保留新值；CHD 没有强行覆盖它' }
    }
    if (rows.length) {
      await run('UPDATE game_roms SET object_key = ? WHERE game_id = ? AND lang = ?', [job.target_key, game.id, job.lang])
    } else {
      await run('INSERT INTO game_roms (game_id, lang, object_key) VALUES (?, ?, ?)', [game.id, job.lang, job.target_key])
    }
    return { bound: true, message: 'CHD 已原子绑定到游戏' }
  })
  if (result.bound) invalidateContent()
  return result
}

async function deleteSource(job, config) {
  const response = await workerRequest(config, job.source_key, { method: 'DELETE' })
  if (!response.ok && response.status !== 404) throw new Error(`临时 ISO 清理失败：HTTP ${response.status}`)
}

async function sweepStaleSources() {
  const config = pspConversionConfig()
  const rows = await query(
    `SELECT id, source_key, status, message
       FROM psp_conversion_jobs
      WHERE source_deleted = 0
        AND (status = 'completed' OR (status = 'failed' AND updated_at < NOW() - INTERVAL 24 HOUR))
      ORDER BY updated_at ASC
      LIMIT 20`,
  )
  for (const row of rows) {
    try {
      const claim = await query(
        `UPDATE psp_conversion_jobs
            SET source_deleted = 2
          WHERE id = ? AND source_deleted = 0
            AND (status = 'completed' OR (status = 'failed' AND updated_at < NOW() - INTERVAL 24 HOUR))`,
        [row.id],
      )
      if (claim.affectedRows !== 1) continue
      await deleteSource(row, config)
      const note = row.status === 'failed' ? '临时 ISO 已在失败 24 小时后自动清理' : row.message
      await updateJob(row.id, { source_deleted: 1, ...(note ? { message: String(note).slice(0, 500) } : {}) })
    } catch (error) {
      // 删除没得到确认就把领取标记退回；否则一次网络闪断会让这份临时 ISO 永远没人再清。
      await updateJob(row.id, { source_deleted: 0 }).catch(() => {})
      console.warn(`[psp-convert] 清理临时 ISO ${row.source_key} 失败：${error.message}`)
    }
  }
}

async function finishPublishedJob(job, config) {
  const final = await remoteHead(config, job.target_key)
  if (!final || final.etag !== job.output_etag || final.size !== Number(job.output_size)) {
    throw new Error('最终 CHD 在数据库绑定前发生变化，已停止自动绑定')
  }
  let binding
  try {
    binding = await bindConvertedRom(job)
  } catch (error) {
    // 最终对象已经通过大小 + ETag 校验，数据库绑定失败不能把它说成“转换失败”并重做上传。
    binding = { bound: false, message: `CHD 已发布，但自动绑定失败：${error.message}` }
  }
  await updateJob(job.id, {
    status: 'completed', progress: 100, bound: binding.bound ? 1 : 0,
    message: binding.message, error: null, completed_at: new Date(), source_deleted: 0,
  })
  // 先把“最终对象可用”落库，再清临时源。若进程恰好在这里退出，清扫器会补删。
  try {
    await deleteSource(job, config)
    await updateJob(job.id, { source_deleted: 1 })
  } catch (error) {
    await updateJob(job.id, { message: `${binding.message}；${error.message}`.slice(0, 500) }).catch(() => {})
  }
}

async function processJob(job) {
  const config = pspConversionConfig()
  const dir = join(config.tempDir, job.id)
  const input = join(dir, 'input.iso')
  const output = join(dir, 'output.chd')
  try {
    // R2 已发布、但服务在绑定数据库之前重启：凭完整 ETag/大小直接收尾，绝不能再压缩并覆盖一次。
    if (job.output_etag && job.output_size) {
      const published = await remoteHead(config, job.target_key)
      if (published && published.etag === job.output_etag && published.size === Number(job.output_size)) {
        await finishPublishedJob(job, config)
        return
      }
      throw new Error('任务记录显示 CHD 已发布，但 R2 最终对象身份已经变化；已停止自动覆盖')
    }
    await ensureDiskSpace(config, Number(job.source_size))
    await rm(dir, { recursive: true, force: true })
    await mkdir(dir, { recursive: true })
    await abortOldMultipart(job, config)
    await updateJob(job.id, { status: 'downloading', progress: 4, error: null, message: '正在从 R2 读取临时 ISO' })
    await downloadSource(job, config, input)

    await updateJob(job.id, { status: 'converting', progress: 30, message: '正在转换为 CHD（zstd / 2048-byte hunk）' })
    let reported = -1
    let progressWrites = Promise.resolve()
    await runChdman(config.chdman, chdmanCreateArgs(input, output), (pct) => {
      const mapped = 30 + Math.floor(pct * 0.4)
      if (mapped === reported) return
      reported = mapped
      // 保持写入顺序；不然较早的 UPDATE 可能在“正在校验”之后才落库，把进度倒退到 40%。
      progressWrites = progressWrites.then(() => updateJob(job.id, { progress: mapped })).catch(() => {})
    }, config.timeoutMs)
    await progressWrites

    await updateJob(job.id, { status: 'verifying', progress: 71, message: '正在完整校验 CHD' })
    const outputSize = await validateChd(output, config)
    if (outputSize > Number(job.source_size) + 16 * 1024 * 1024) throw new Error('CHD 比原 ISO 还大，拒绝发布异常输出')
    await updateJob(job.id, { output_size: outputSize, status: 'uploading', progress: 75, message: '正在把最终 CHD 分片发布到 R2' })
    const published = await uploadChd(job, config, output, outputSize)
    await finishPublishedJob({ ...job, output_size: outputSize, output_etag: published.etag }, config)
  } catch (error) {
    const text = String(error?.message || error || '未知错误').slice(0, MAX_ERROR_CHARS)
    console.error(`[psp-convert] ${job.id} 失败：`, error)
    await updateJob(job.id, { status: 'failed', error: text, message: '临时 ISO 已保留，可在 24 小时内重试' }).catch(() => {})
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {})
  }
}

async function claimNext() {
  const row = await queryOne("SELECT * FROM psp_conversion_jobs WHERE status = 'queued' ORDER BY created_at ASC LIMIT 1")
  if (!row) return null
  const result = await query(
    "UPDATE psp_conversion_jobs SET status = 'downloading', progress = GREATEST(progress, 1), message = '任务已领取' WHERE id = ? AND status = 'queued'",
    [row.id],
  )
  return result.affectedRows === 1 ? { ...row, status: 'downloading' } : null
}

async function pump() {
  pumpTimer = undefined
  const config = pspConversionConfig()
  while (activeWorkers < config.concurrency) {
    const job = await claimNext().catch((error) => {
      console.error('[psp-convert] 领取任务失败：', error.message)
      return null
    })
    if (!job) break
    activeWorkers++
    void processJob(job).finally(() => {
      activeWorkers--
      schedulePump(50)
    })
  }
}

function schedulePump(delay = 0) {
  if (!started || pumpTimer) return
  pumpTimer = setTimeout(() => void pump(), delay)
  pumpTimer.unref?.()
}

export async function startPspConversionQueue() {
  if (started) return
  started = true
  const capability = await pspConversionCapability(process.env, true)
  if (!capability.available) {
    console.warn(`[psp-convert] 未启用：${capability.reason}`)
    return
  }
  await mkdir(pspConversionConfig().tempDir, { recursive: true })
  await query(
    `UPDATE psp_conversion_jobs
        SET status = 'queued', progress = LEAST(progress, 75), message = '服务器重启，任务自动重新排队'
      WHERE status IN (${INTERRUPTED.map(() => '?').join(', ')})`,
    INTERRUPTED,
  )
  console.log('[psp-convert] PSP ISO → CHD 后台队列已启用')
  schedulePump()
  void sweepStaleSources().catch((error) => console.warn('[psp-convert] 临时 ISO 清扫失败：', error.message))
  sweepTimer = setInterval(() => {
    void sweepStaleSources().catch((error) => console.warn('[psp-convert] 临时 ISO 清扫失败：', error.message))
  }, 6 * 60 * 60 * 1000)
  sweepTimer.unref?.()
}
