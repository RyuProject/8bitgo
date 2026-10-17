/**
 * 大型 Windows ZIP → 静态 Sockdrive 后台队列。
 *
 * 浏览器只负责把原始 ZIP 分片上传到随机 staging key；转换、发布与绑定都在持久任务里完成。
 * 进程重启后会重新排队，而 sockdrive.metaj 始终最后上传：它既是播放器入口，也是“整块磁盘已提交”
 * 的提交标志。这样最坏只会留下没人引用的分块，不会把半份磁盘绑定给玩家。
 */
import { randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import { constants as fsConstants } from 'node:fs'
import { access, mkdir, open, readdir, rm, stat, statfs } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { query, queryOne, withTransaction } from './db.js'
import { invalidateContent } from './content.js'

const ACTIVE = new Set(['queued', 'downloading', 'converting', 'uploading', 'verifying'])
const INTERRUPTED = ['downloading', 'converting', 'uploading', 'verifying']
const FETCH_TIMEOUT_MS = 60_000
const SOURCE_IDLE_MS = 60_000
const MAX_ERROR_CHARS = 900
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const PREPARE_SCRIPT = join(REPO_ROOT, 'scripts/prepare-sockdrive.mjs')
const UPLOAD_SCRIPT = join(REPO_ROOT, 'scripts/upload-sockdrive-r2.mjs')

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

export function sockdriveConversionConfig(env = process.env) {
  return {
    workerUrl: String(env.SOCKDRIVE_CONVERT_WORKER_URL || env.PSP_CONVERT_WORKER_URL || '').trim().replace(/\/+$/, ''),
    workerToken: String(env.SOCKDRIVE_CONVERT_WORKER_TOKEN || env.PSP_CONVERT_WORKER_TOKEN || env.ADMIN_TOKEN || '').trim(),
    publicBase: String(env.SOCKDRIVE_PUBLIC_BASE || 'https://assets.8bitgo.com').trim().replace(/\/+$/, ''),
    tempDir: resolve(String(env.SOCKDRIVE_CONVERT_TMP_DIR || new URL('../tmp/sockdrive-conversions', import.meta.url).pathname)),
    cli: String(env.SOCKDRIVE_CLI || '/opt/sockdrive/cli').trim(),
    encoding: String(env.SOCKDRIVE_ENCODING || 'br').trim().toLowerCase(),
    freeSpace: String(env.SOCKDRIVE_FREE_SPACE || '128M').trim().toUpperCase(),
    // 官方 CLI 当前最大只认 2GB 镜像；1900MiB 给 FAT/分区表和默认 128MiB 可写空间留出余量。
    maxSourceBytes: positiveInt(env.SOCKDRIVE_MAX_SOURCE_MB, 1900, 1900) * 1024 * 1024,
    concurrency: positiveInt(env.SOCKDRIVE_CONCURRENCY, 1, 1),
    timeoutMs: positiveInt(env.SOCKDRIVE_TIMEOUT_MINUTES, 360, 24 * 60) * 60 * 1000,
  }
}

function validObjectKey(value) {
  const key = String(value || '')
  // eslint-disable-next-line no-control-regex -- staging key 不能让控制字符进入 URL / 日志。
  const hasControlChars = /[\x00-\x1f\x7f]/.test(key)
  return key.length > 0 && key.length <= 500 && !key.startsWith('/') && !key.endsWith('/') &&
    !key.includes('..') && !key.includes('\\') && !key.includes('//') && !hasControlChars
}

function validExecutable(value) {
  const executable = String(value || '').trim().replace(/\\/g, '/').replace(/^\/+|\/+$/g, '')
  // eslint-disable-next-line no-control-regex -- 路径会进入 DOSBox autoexec，必须先收紧字符边界。
  if (!/^[^:<>"|?*\x00-\x1f]+\.exe$/i.test(executable)) return ''
  // games.dos_executable 是 VARCHAR(255)；在耗时转换前按真实落库上限拦住，不能发布完才绑定失败。
  if (executable.length > 255 || executable.split('/').some((part) => !part || part === '.' || part === '..')) return ''
  return executable
}

export function validateSockdriveConversionRequest(body, env = process.env) {
  const sourceKey = String(body?.sourceKey || '').trim()
  const sourceSize = Number(body?.sourceSize)
  const gameSlug = String(body?.gameSlug || '').trim()
  const executable = validExecutable(body?.executable)
  const version = String(body?.version || '').trim().toLowerCase()
  const expectedSockdrive = String(body?.expectedSockdrive || '').trim().replace(/\/+$/, '')
  const encoding = String(body?.encoding || sockdriveConversionConfig(env).encoding).trim().toLowerCase()
  if (!validObjectKey(sourceKey) || !/^sockdrive-staging\/[a-f0-9-]{16,}\.zip$/i.test(sourceKey)) {
    throw Object.assign(new Error('临时 Sockdrive ZIP key 无效'), { status: 400 })
  }
  const max = sockdriveConversionConfig(env).maxSourceBytes
  if (!Number.isSafeInteger(sourceSize) || sourceSize < 32 * 1024 || sourceSize > max) {
    throw Object.assign(new Error(`ZIP 大小必须在 32KB 到 ${Math.round(max / 1024 / 1024)}MB 之间`), { status: 400 })
  }
  if (!/^[a-z0-9][a-z0-9-]{0,79}$/.test(gameSlug)) throw Object.assign(new Error('游戏 slug 无效'), { status: 400 })
  if (!executable) throw Object.assign(new Error('必须填写游戏盘内安全的 .exe 相对路径'), { status: 400 })
  if (!/^v[1-9]\d*$/.test(version) && !/^[a-f0-9]{8,64}$/.test(version)) {
    throw Object.assign(new Error('版本必须是 v1 / v2 这类编号，或 8～64 位内容哈希'), { status: 400 })
  }
  if (!['br', 'gzip', 'identity'].includes(encoding)) throw Object.assign(new Error('压缩格式无效'), { status: 400 })
  if (expectedSockdrive.length > 500 || /[\r\n]/.test(expectedSockdrive)) {
    throw Object.assign(new Error('当前 Sockdrive 目录无效'), { status: 400 })
  }
  const targetPrefix = `sockdrives/${gameSlug}-${version}`
  return { sourceKey, sourceSize, gameSlug, executable, version, targetPrefix, expectedSockdrive, encoding }
}

function encodeKey(key) {
  return key.split('/').map((part) => encodeURIComponent(part)).join('/')
}

async function workerRequest(config, key, init = {}) {
  const { query: search = '', ...options } = init
  return fetch(`${config.workerUrl}/${encodeKey(key)}${search}`, {
    ...options,
    signal: options.signal || AbortSignal.timeout(FETCH_TIMEOUT_MS),
    headers: { Authorization: `Bearer ${config.workerToken}`, ...options.headers },
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

async function commandExists(bin, args = ['--help']) {
  if (bin.includes('/')) {
    try { await access(bin, fsConstants.X_OK) } catch { return false }
  }
  return new Promise((resolveAvailable) => {
    const child = spawn(bin, args, { stdio: 'ignore' })
    let settled = false
    const finish = (value) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolveAvailable(value)
    }
    const timer = setTimeout(() => { child.kill('SIGKILL'); finish(false) }, 5000)
    timer.unref?.()
    child.once('error', (error) => finish(error?.code !== 'ENOENT'))
    child.once('exit', () => finish(true))
  })
}

async function workerSupportsSockdrive(config) {
  try {
    const response = await fetch(`${config.workerUrl}/ping`, {
      headers: { Authorization: `Bearer ${config.workerToken}` },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      cache: 'no-store',
    })
    if (!response.ok) return false
    const info = await response.json()
    return info?.features?.privateStagingRead === true && info?.features?.contentEncodingUpload === true
  } catch { return false }
}

export async function sockdriveConversionCapability(env = process.env, fresh = false) {
  if (!fresh && capabilityCache && Date.now() - capabilityCache.at < 30_000) return capabilityCache.value
  const config = sockdriveConversionConfig(env)
  let reason = ''
  if (!config.workerUrl) reason = '服务器未配置 SOCKDRIVE_CONVERT_WORKER_URL（可复用 PSP Worker）'
  else if (!config.workerToken) reason = '服务器未配置 Sockdrive Worker 口令'
  else if (!['br', 'gzip', 'identity'].includes(config.encoding)) reason = 'SOCKDRIVE_ENCODING 只能是 br、gzip 或 identity'
  else if (!/^[1-9]\d*(?:[KMG])$/i.test(config.freeSpace)) reason = 'SOCKDRIVE_FREE_SPACE 格式无效'
  else if (!(await commandExists(config.cli))) reason = `找不到 Sockdrive CLI：${config.cli}`
  else if (!(await commandExists('virt-make-fs'))) reason = '找不到 virt-make-fs'
  else if (!(await commandExists('qemu-img'))) reason = '找不到 qemu-img'
  else if (!(await commandExists('7z'))) reason = '找不到 7z'
  else if (config.encoding === 'br' && !(await commandExists('brotli'))) reason = '找不到 brotli'
  else if (!(await workerSupportsSockdrive(config))) {
    reason = 'R2 Worker 尚未部署 Sockdrive 私有 staging / Content-Encoding 支持'
  }
  else {
    try {
      const row = await queryOne(
        "SELECT COUNT(*) AS n FROM information_schema.TABLES WHERE table_schema = DATABASE() AND table_name = 'sockdrive_conversion_jobs'",
      )
      if (!Number(row?.n)) reason = '数据库缺少 sockdrive_conversion_jobs；请在 server 目录执行 npm run migrate'
    } catch {
      reason = '暂时无法检查 Sockdrive 转换任务表'
    }
  }
  const value = {
    available: !reason,
    reason,
    maxSourceBytes: config.maxSourceBytes,
    format: `Sockdrive (${config.encoding === 'br' ? 'Brotli' : config.encoding})`,
  }
  capabilityCache = { at: Date.now(), value }
  return value
}

function publicJob(row) {
  if (!row) return null
  return {
    id: row.id,
    sourceKey: row.source_key,
    targetPrefix: row.target_prefix,
    status: row.status,
    progress: Number(row.progress) || 0,
    sourceSize: Number(row.source_size) || 0,
    outputBytes: row.output_bytes == null ? null : Number(row.output_bytes),
    outputFiles: row.output_files == null ? null : Number(row.output_files),
    gameSlug: row.game_slug,
    executable: row.executable,
    bound: Boolean(row.bound),
    message: row.message || '',
    error: row.error || '',
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    completedAt: row.completed_at,
  }
}

function sameRequest(row, request) {
  return row.source_key === request.sourceKey && Number(row.source_size) === request.sourceSize &&
    row.game_slug === request.gameSlug && row.executable === request.executable && row.version === request.version &&
    row.target_prefix === request.targetPrefix && row.expected_sockdrive === request.expectedSockdrive && row.encoding === request.encoding
}

async function existingJobForSource(request) {
  const row = await queryOne('SELECT * FROM sockdrive_conversion_jobs WHERE source_key = ?', [request.sourceKey])
  if (!row) return null
  if (!sameRequest(row, request)) {
    throw Object.assign(new Error('这个临时 ZIP 已属于另一项转换任务，拒绝复用到不同游戏或版本'), { status: 409 })
  }
  return publicJob(row)
}

function hasDosExtras(value) {
  if (!value) return false
  if (Array.isArray(value)) return value.length > 0
  try {
    const parsed = JSON.parse(value)
    return Array.isArray(parsed) && parsed.length > 0
  } catch { return true }
}

export async function createSockdriveConversion(raw, actorId = null, env = process.env) {
  const capability = await sockdriveConversionCapability(env)
  if (!capability.available) throw Object.assign(new Error(capability.reason), { status: 503 })
  const request = validateSockdriveConversionRequest(raw, env)
  const existing = await existingJobForSource(request)
  if (existing) return existing
  const game = await queryOne(
    'SELECT id, platform, dos_backend, dos_system, dos_sockdrive, dos_extras, dos_executable FROM games WHERE slug = ?',
    [request.gameSlug],
  )
  if (!game) throw Object.assign(new Error('要绑定的游戏不存在；请先保存游戏资料'), { status: 409 })
  if (game.platform !== 'dos' || game.dos_backend !== 'dosboxX' || !String(game.dos_system || '').trim()) {
    throw Object.assign(new Error('目标游戏必须先配置 DOSBox-X 和共享 Windows 系统镜像'), { status: 409 })
  }
  if (hasDosExtras(game.dos_extras)) {
    throw Object.assign(new Error('目标游戏还有 DOS 附加文件；请先把补丁合入 ZIP，流式盘不能在浏览器现场叠加'), { status: 409 })
  }
  if (String(game.dos_sockdrive || '').trim().replace(/\/+$/, '') !== request.expectedSockdrive) {
    throw Object.assign(new Error('Sockdrive 绑定已被其他人修改，请刷新表单后重试'), { status: 409 })
  }
  const config = sockdriveConversionConfig(env)
  const source = await remoteHead(config, request.sourceKey)
  if (!source) throw Object.assign(new Error('临时 ZIP 不存在；请重新上传'), { status: 404 })
  if (source.size !== request.sourceSize) throw Object.assign(new Error('临时 ZIP 大小与浏览器上报不一致'), { status: 409 })
  if (await remoteHead(config, `${request.targetPrefix}/sockdrive.metaj`)) {
    throw Object.assign(new Error('目标版本目录已经存在；Sockdrive 禁止原地覆盖，请换新版本'), { status: 409 })
  }

  const id = randomUUID()
  try {
    await query(
      `INSERT INTO sockdrive_conversion_jobs
       (id, source_key, source_size, source_etag, game_id, game_slug, executable, expected_executable,
        version, target_prefix, expected_sockdrive, encoding, actor_id, status, progress)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', 0)`,
      [id, request.sourceKey, request.sourceSize, source.etag, game.id, request.gameSlug, request.executable,
        String(game.dos_executable || ''), request.version, request.targetPrefix, request.expectedSockdrive,
        request.encoding, actorId],
    )
  } catch (error) {
    if (error?.code !== 'ER_DUP_ENTRY') throw error
    const raced = await existingJobForSource(request)
    if (raced) return raced
    throw Object.assign(new Error('目标版本目录已经被另一项任务占用，请换新版本'), { status: 409 })
  }
  schedulePump()
  return getSockdriveConversion(id)
}

export async function getSockdriveConversion(id) {
  return publicJob(await queryOne('SELECT * FROM sockdrive_conversion_jobs WHERE id = ?', [id]))
}

export async function retrySockdriveConversion(id) {
  const row = await queryOne('SELECT * FROM sockdrive_conversion_jobs WHERE id = ?', [id])
  if (!row) return null
  if (ACTIVE.has(row.status) || row.status === 'completed') return publicJob(row)
  const config = sockdriveConversionConfig()
  // 上传阶段失败后只有“最终元数据已经存在”才能脱离源 ZIP 恢复；仅凭 publish_started 不代表发布已提交。
  const published = row.publish_started
    ? await remoteHead(config, `${row.target_prefix}/sockdrive.metaj`)
    : null
  if (!published) {
    if (Number(row.source_deleted) !== 0) {
      throw Object.assign(new Error('临时 ZIP 已清理且发布尚未提交，不能重试；请重新上传'), { status: 409 })
    }
    const source = await remoteHead(config, row.source_key)
    if (!source || source.size !== Number(row.source_size) || source.etag !== row.source_etag) {
      throw Object.assign(new Error('临时 ZIP 已不存在或改变，不能重试；请重新上传'), { status: 409 })
    }
  }
  const claimed = await query(
    "UPDATE sockdrive_conversion_jobs SET status = 'queued', progress = 0, error = NULL, message = '手动重试', completed_at = NULL WHERE id = ? AND status = 'failed'",
    [id],
  )
  if (claimed.affectedRows !== 1) throw Object.assign(new Error('任务状态刚刚变化，请刷新后再试'), { status: 409 })
  schedulePump()
  return getSockdriveConversion(id)
}

async function updateJob(id, fields) {
  const allowed = new Set([
    'status', 'progress', 'output_bytes', 'output_files', 'metadata_etag', 'range_count', 'bound',
    'publish_started', 'message', 'error', 'completed_at', 'source_deleted',
  ])
  const entries = Object.entries(fields).filter(([key]) => allowed.has(key))
  if (!entries.length) return
  const sql = entries.map(([key]) => `\`${key}\` = ?`).join(', ')
  await query(`UPDATE sockdrive_conversion_jobs SET ${sql} WHERE id = ?`, [...entries.map(([, value]) => value), id])
}

async function ensureDiskSpace(config, sourceSize) {
  await mkdir(config.tempDir, { recursive: true })
  const fs = await statfs(config.tempDir)
  const free = Number(fs.bavail) * Number(fs.bsize)
  // ZIP、解压目录、QCOW2 与发布分块会短暂并存；12GB 下限覆盖高压缩比的小源包，5 倍覆盖普通大包。
  const need = Math.max(12 * 1024 ** 3, sourceSize * 5 + 1024 ** 3)
  if (!Number.isFinite(free) || free < need) {
    throw new Error(`Sockdrive 工作盘空间不足：至少需要 ${Math.ceil(need / 1024 / 1024)}MB 可用空间`)
  }
}

async function writeAllAt(file, bytes, position) {
  let offset = 0
  while (offset < bytes.byteLength) {
    const { bytesWritten } = await file.write(bytes, offset, bytes.byteLength - offset, position + offset)
    if (!Number.isSafeInteger(bytesWritten) || bytesWritten <= 0) throw new Error('写入临时 ZIP 时磁盘没有继续前进')
    offset += bytesWritten
  }
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
      method: 'GET', headers: { 'If-Match': job.source_etag }, signal: controller.signal,
    })
    if (response.status === 412) throw new Error('临时 ZIP 在任务创建后被覆盖，已停止转换')
    if (!response.ok || !response.body) throw new Error(`下载临时 ZIP 失败：HTTP ${response.status}`)
    if (Number(response.headers.get('content-length')) !== Number(job.source_size)) throw new Error('下载响应大小与任务记录不一致')
    file = await open(destination, 'wx')
    for await (const chunk of response.body) {
      armIdle()
      if (received + chunk.byteLength > Number(job.source_size)) throw new Error('下载数据超过任务记录大小')
      await writeAllAt(file, chunk, received)
      received += chunk.byteLength
      const progress = 4 + Math.floor(received / Number(job.source_size) * 16)
      if (progress !== reported) { reported = progress; await updateJob(job.id, { progress }) }
    }
  } finally {
    clearTimeout(idle)
    if (file) await file.close()
  }
  if (received !== Number(job.source_size)) throw new Error(`ZIP 下载不完整：收到 ${received}/${job.source_size} 字节`)
  const header = Buffer.alloc(4)
  const source = await open(destination, 'r')
  try { await source.read(header, 0, header.length, 0) } finally { await source.close() }
  if (!header.equals(Buffer.from([0x50, 0x4b, 0x03, 0x04])) && !header.equals(Buffer.from([0x50, 0x4b, 0x05, 0x06]))) {
    throw new Error('上传内容不是 ZIP 文件')
  }
}

function runCommand(command, args, { env = process.env, timeoutMs, onText } = {}) {
  return new Promise((resolveRun, rejectRun) => {
    // 制盘脚本内部还会启动 guestfs/qemu；单杀 Node 包装进程会留下占盘的孤儿制作进程。
    const processGroup = process.platform !== 'win32'
    const child = spawn(command, args, { cwd: REPO_ROOT, env, stdio: ['ignore', 'pipe', 'pipe'], detached: processGroup })
    let tail = ''
    let timedOut = false
    let hardKill
    const collect = (chunk) => {
      const text = chunk.toString('utf8')
      tail = (tail + text).slice(-96 * 1024)
      onText?.(text)
    }
    child.stdout.on('data', collect)
    child.stderr.on('data', collect)
    const timer = setTimeout(() => {
      timedOut = true
      const kill = (signal) => {
        try {
          if (processGroup && child.pid) process.kill(-child.pid, signal)
          else child.kill(signal)
        } catch { /* 进程恰好已经退出，不需要把超时清理变成第二个错误。 */ }
      }
      kill('SIGTERM')
      hardKill = setTimeout(() => kill('SIGKILL'), 10_000)
      hardKill.unref?.()
    }, timeoutMs)
    timer.unref?.()
    const done = () => { clearTimeout(timer); clearTimeout(hardKill) }
    child.once('error', (error) => { done(); rejectRun(error) })
    child.once('exit', (code, signal) => {
      done()
      if (timedOut) rejectRun(new Error(`转换超过 ${Math.round(timeoutMs / 60_000)} 分钟，已终止`))
      else if (code === 0) resolveRun(tail)
      else rejectRun(new Error(`${command} 失败（${signal || `exit ${code}`}）：${tail.trim().slice(-2500)}`))
    })
  })
}

function conversionProgress(text) {
  if (/Sockdrive 制作完成/.test(text)) return 70
  if (/Sockdrive 结构完整/.test(text)) return 68
  if (/调用官方 sockify/.test(text)) return 55
  if (/制作 FAT32\/QCOW2/.test(text)) return 40
  if (/源文件检查通过/.test(text)) return 32
  return null
}

async function outputSummary(directory) {
  const names = await readdir(directory)
  let bytes = 0
  let files = 0
  for (const name of names) {
    const info = await stat(join(directory, name))
    if (!info.isFile()) continue
    files++
    bytes += info.size
  }
  return { files, bytes }
}

async function verifyPublished(config, job) {
  const root = `${config.publicBase}/${job.target_prefix}`
  const stamp = Date.now()
  // Cloudflare 会按 Accept-Encoding 协商响应；不声明 br 时它可能解码并移除响应头，造成正确产物被误判。
  const publicHeaders = {
    Origin: 'https://8bitgo.com',
    'Accept-Encoding': job.encoding === 'identity' ? 'identity' : job.encoding,
  }
  const metadataResponse = await fetch(`${root}/sockdrive.metaj?verify=${stamp}`, {
    headers: publicHeaders, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS), cache: 'no-store',
  })
  if (!metadataResponse.ok) throw new Error(`公开 sockdrive.metaj 读取失败：HTTP ${metadataResponse.status}`)
  const metadata = await metadataResponse.json()
  if (!Number.isSafeInteger(metadata.range_count) || metadata.range_count <= 0) throw new Error('公开 sockdrive.metaj 的分块数无效')
  const cors = metadataResponse.headers.get('access-control-allow-origin')
  if (cors !== '*' && cors !== 'https://8bitgo.com') throw new Error('公开 Sockdrive 没有允许 8bitgo.com 跨域读取')
  const preload = await fetch(`${root}/preload_ranges.metaj?verify=${stamp}`, {
    headers: publicHeaders, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS), cache: 'no-store',
  })
  if (!preload.ok || !Array.isArray(await preload.json())) throw new Error('公开 preload_ranges.metaj 无效')
  const dropped = new Set(Array.isArray(metadata.dropped_ranges) ? metadata.dropped_ranges : [])
  const small = new Set(Array.isArray(metadata.small_ranges) ? metadata.small_ranges : [])
  const sample = small.size
    ? 'preload.raw'
    : Array.from({ length: metadata.range_count }, (_, index) => index).find((index) => !dropped.has(index) && !small.has(index))
  if (sample !== undefined) {
    const name = typeof sample === 'number' ? `${sample}.raw` : sample
    const response = await fetch(`${root}/${name}?verify=${stamp}`, {
      method: 'HEAD', headers: publicHeaders, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS), cache: 'no-store',
    })
    if (!response.ok) throw new Error(`公开分块 ${name} 读取失败：HTTP ${response.status}`)
    const actualEncoding = response.headers.get('content-encoding') || 'identity'
    if (actualEncoding !== job.encoding) throw new Error(`公开分块编码是 ${actualEncoding}，应为 ${job.encoding}`)
  }
  const head = await remoteHead(config, `${job.target_prefix}/sockdrive.metaj`)
  if (!head) throw new Error('Worker 中找不到已发布的 sockdrive.metaj')
  return { ...head, rangeCount: metadata.range_count }
}

async function bindPublished(job) {
  const result = await withTransaction(async (run) => {
    const rows = await run(
      'SELECT id, platform, dos_backend, dos_system, dos_sockdrive, dos_extras, dos_executable FROM games WHERE id = ? FOR UPDATE',
      [job.game_id],
    )
    const game = rows[0]
    if (!game) return { bound: false, message: '游戏已经删除；Sockdrive 已发布但未绑定' }
    if (game.platform !== 'dos' || game.dos_backend !== 'dosboxX' || !String(game.dos_system || '').trim()) {
      return { bound: false, message: '游戏运行环境已改变；Sockdrive 已发布但未绑定' }
    }
    if (hasDosExtras(game.dos_extras)) return { bound: false, message: '游戏新增了附加文件；为避免流式盘漏补丁，未自动绑定' }
    const current = String(game.dos_sockdrive || '').trim().replace(/\/+$/, '')
    if (current === job.target_prefix && String(game.dos_executable || '') === job.executable) {
      return { bound: true, message: 'Sockdrive 已经绑定' }
    }
    if (current !== String(job.expected_sockdrive || '') || String(game.dos_executable || '') !== String(job.expected_executable || '')) {
      return { bound: false, message: '游戏配置在转换期间被修改；已保留新配置，没有强行覆盖' }
    }
    await run('UPDATE games SET dos_sockdrive = ?, dos_executable = ? WHERE id = ?', [job.target_prefix, job.executable, game.id])
    return { bound: true, message: 'Sockdrive 与启动 EXE 已原子绑定到游戏' }
  })
  if (result.bound) invalidateContent()
  return result
}

async function deleteSource(job, config) {
  const response = await workerRequest(config, job.source_key, { method: 'DELETE' })
  if (!response.ok && response.status !== 404) throw new Error(`临时 ZIP 清理失败：HTTP ${response.status}`)
}

async function finishPublishedJob(job, config, published) {
  let binding
  try { binding = await bindPublished(job) }
  catch (error) { binding = { bound: false, message: `Sockdrive 已发布，但自动绑定失败：${error.message}` } }
  await updateJob(job.id, {
    status: 'completed', progress: 100, metadata_etag: published.etag, range_count: published.rangeCount,
    bound: binding.bound ? 1 : 0, message: binding.message, error: null, completed_at: new Date(), source_deleted: 0,
  })
  try {
    await deleteSource(job, config)
    await updateJob(job.id, { source_deleted: 1 })
  } catch (error) {
    await updateJob(job.id, { message: `${binding.message}；${error.message}`.slice(0, 500) }).catch(() => {})
  }
}

async function processJob(job) {
  const config = sockdriveConversionConfig()
  const dir = join(config.tempDir, job.id)
  const input = join(dir, 'source.zip')
  const workRoot = join(dir, 'work')
  const buildRoot = join(workRoot, `${job.game_slug}-${job.version}`)
  const publishDir = join(buildRoot, 'publish')
  try {
    if (job.publish_started) {
      const existing = await remoteHead(config, `${job.target_prefix}/sockdrive.metaj`)
      if (existing) {
        await updateJob(job.id, { status: 'verifying', progress: 98, message: '检测到已提交的元数据，正在恢复校验与绑定' })
        const published = await verifyPublished(config, job)
        await finishPublishedJob(job, config, published)
        return
      }
    }
    await ensureDiskSpace(config, Number(job.source_size))
    await rm(dir, { recursive: true, force: true })
    await mkdir(dir, { recursive: true })
    await updateJob(job.id, { status: 'downloading', progress: 3, error: null, message: '正在从私有 staging 读取原始 ZIP' })
    await downloadSource(job, config, input)

    await updateJob(job.id, { status: 'converting', progress: 22, message: '正在制作 FAT32/QCOW2 并生成 Sockdrive 分块' })
    let progress = 22
    let progressWrites = Promise.resolve()
    await runCommand(process.execPath, [
      PREPARE_SCRIPT,
      '--source', input,
      '--slug', job.game_slug,
      '--version', job.version,
      '--exe', job.executable,
      '--work-dir', workRoot,
      '--cli', config.cli,
      '--encoding', job.encoding,
      '--free-space', config.freeSpace,
      '--public-base', config.publicBase,
    ], {
      timeoutMs: config.timeoutMs,
      onText: (text) => {
        const next = conversionProgress(text)
        if (next == null || next <= progress) return
        progress = next
        progressWrites = progressWrites.then(() => updateJob(job.id, { progress })).catch(() => {})
      },
    })
    await progressWrites
    const summary = await outputSummary(publishDir)
    await updateJob(job.id, {
      status: 'uploading', progress: 72, output_bytes: summary.bytes, output_files: summary.files,
      publish_started: 1, message: `正在发布 ${summary.files} 个不可变分块到 R2`,
    })
    let uploaded = 0
    await runCommand(process.execPath, [
      UPLOAD_SCRIPT,
      '--src', publishDir,
      '--prefix', job.target_prefix,
      '--encoding', job.encoding,
      '--public-base', config.publicBase,
      '--worker-url', config.workerUrl,
    ], {
      timeoutMs: config.timeoutMs,
      env: { ...process.env, SOCKDRIVE_WORKER_TOKEN: config.workerToken },
      onText: (text) => {
        const match = /上传 .*（(\d+)\/(\d+)）/.exec(text)
        if (!match) return
        const next = 72 + Math.floor(Number(match[1]) / Math.max(1, Number(match[2])) * 24)
        if (next <= uploaded) return
        uploaded = next
        void updateJob(job.id, { progress: next }).catch(() => {})
      },
    })
    await updateJob(job.id, { status: 'verifying', progress: 98, message: '正在通过公开域名复核元数据、热点清单和编码' })
    const published = await verifyPublished(config, job)
    await finishPublishedJob(job, config, published)
  } catch (error) {
    const message = String(error?.message || error || '未知错误').slice(0, MAX_ERROR_CHARS)
    console.error(`[sockdrive-convert] ${job.id} 失败：`, error)
    await updateJob(job.id, {
      status: 'failed', error: message,
      message: job.publish_started ? '已保留任务状态；可重试恢复发布或绑定' : '临时 ZIP 已保留，可在 24 小时内重试',
    }).catch(() => {})
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {})
  }
}

async function sweepStaleSources() {
  const config = sockdriveConversionConfig()
  const rows = await query(
    `SELECT id, source_key, status, message FROM sockdrive_conversion_jobs
      WHERE source_deleted = 0
        AND (status = 'completed' OR (status = 'failed' AND updated_at < NOW() - INTERVAL 24 HOUR))
      ORDER BY updated_at ASC LIMIT 20`,
  )
  for (const row of rows) {
    try {
      const claimed = await query(
        `UPDATE sockdrive_conversion_jobs SET source_deleted = 2
          WHERE id = ? AND source_deleted = 0
            AND (status = 'completed' OR (status = 'failed' AND updated_at < NOW() - INTERVAL 24 HOUR))`,
        [row.id],
      )
      if (claimed.affectedRows !== 1) continue
      await deleteSource(row, config)
      await updateJob(row.id, {
        source_deleted: 1,
        ...(row.status === 'failed' ? { message: '临时 ZIP 已在失败 24 小时后自动清理' } : {}),
      })
    } catch (error) {
      await updateJob(row.id, { source_deleted: 0 }).catch(() => {})
      console.warn(`[sockdrive-convert] 清理 ${row.source_key} 失败：${error.message}`)
    }
  }
}

async function claimNext() {
  const row = await queryOne("SELECT * FROM sockdrive_conversion_jobs WHERE status = 'queued' ORDER BY created_at ASC LIMIT 1")
  if (!row) return null
  const claimed = await query(
    "UPDATE sockdrive_conversion_jobs SET status = 'downloading', progress = GREATEST(progress, 1), message = '任务已领取' WHERE id = ? AND status = 'queued'",
    [row.id],
  )
  return claimed.affectedRows === 1 ? { ...row, status: 'downloading' } : null
}

async function pump() {
  pumpTimer = undefined
  const config = sockdriveConversionConfig()
  while (activeWorkers < config.concurrency) {
    const job = await claimNext().catch((error) => {
      console.error('[sockdrive-convert] 领取任务失败：', error.message)
      return null
    })
    if (!job) break
    activeWorkers++
    void processJob(job).finally(() => { activeWorkers--; schedulePump(50) })
  }
}

function schedulePump(delay = 0) {
  if (!started || pumpTimer) return
  pumpTimer = setTimeout(() => void pump(), delay)
  pumpTimer.unref?.()
}

export async function startSockdriveConversionQueue() {
  if (started) return
  started = true
  const capability = await sockdriveConversionCapability(process.env, true)
  if (!capability.available) {
    console.warn(`[sockdrive-convert] 未启用：${capability.reason}`)
    return
  }
  await mkdir(sockdriveConversionConfig().tempDir, { recursive: true })
  await query(
    `UPDATE sockdrive_conversion_jobs
      SET status = 'queued', progress = LEAST(progress, 98), message = '服务器重启，任务自动重新排队'
      WHERE status IN (${INTERRUPTED.map(() => '?').join(', ')})`,
    INTERRUPTED,
  )
  console.log('[sockdrive-convert] Windows ZIP → Sockdrive 后台队列已启用')
  schedulePump()
  void sweepStaleSources().catch((error) => console.warn('[sockdrive-convert] staging 清扫失败：', error.message))
  sweepTimer = setInterval(() => {
    void sweepStaleSources().catch((error) => console.warn('[sockdrive-convert] staging 清扫失败：', error.message))
  }, 6 * 60 * 60 * 1000)
  sweepTimer.unref?.()
}
