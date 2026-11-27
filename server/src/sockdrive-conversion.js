/**
 * 大型 DOS / Windows ZIP → 静态 Sockdrive 后台队列。
 *
 * 浏览器只负责把原始 ZIP 分片上传到随机 staging key；转换、发布与绑定都在持久任务里完成。
 * 进程重启后会重新排队，而 sockdrive.metaj 始终最后上传：它既是播放器入口，也是“整块磁盘已提交”
 * 的提交标志。这样最坏只会留下没人引用的分块，不会把半份磁盘绑定给玩家。
 */
import { randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import { constants as fsConstants, createWriteStream } from 'node:fs'
import { access, mkdir, open, readFile, rm, statfs, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { fileURLToPath } from 'node:url'
import { query, queryOne, withTransaction } from './db.js'
import { invalidateContent } from './content.js'
import { SITE_LANGUAGES } from '../../shared/site-languages.js'
import { listSockdriveFiles } from '../../scripts/lib/sockdrive-pipeline.mjs'

const ACTIVE = new Set(['queued', 'downloading', 'converting', 'uploading', 'verifying'])
const INTERRUPTED = ['downloading', 'converting', 'uploading', 'verifying']
const FETCH_TIMEOUT_MS = 60_000
// 管理接口在 Cloudflare 后面；同步校验若接近 100 秒，网关会先回 504，客户端无法知道任务有没有创建。
const CONTROL_PLANE_TIMEOUT_MS = 8_000
const SOURCE_IDLE_MS = 60_000
const MAX_ERROR_CHARS = 900
const ROM_LANGS = new Set(SITE_LANGUAGES.map(({ code }) => code))
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const PREPARE_SCRIPT = join(REPO_ROOT, 'scripts/prepare-sockdrive.mjs')
const UPLOAD_SCRIPT = join(REPO_ROOT, 'scripts/upload-sockdrive-r2.mjs')
const DOS_83_SEGMENT = /^[A-Za-z0-9_^$~!#%&{}@'()-]{1,8}(\.[A-Za-z0-9_^$~!#%&{}@'()-]{1,3})?$/

let started = false
let starting = false
let activeWorkers = 0
let pumping = false
let pumpTimer
let claimRetryMs = 5_000
let startupRetryTimer
let lastCapabilityWarning = ''
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
    // 压缩以前由官方 CLI 为每个分块同时派生进程，2GB 盘能瞬间耗尽 4GB 内存；这里单独硬限流。
    compressionConcurrency: positiveInt(env.SOCKDRIVE_COMPRESSION_CONCURRENCY, 2, 8),
    brotliQuality: positiveInt(env.SOCKDRIVE_BROTLI_QUALITY, 5, 11),
    // 转换本身保持单任务，发布小分块则需要并发隐藏 R2 往返；上限防止误配置打爆文件描述符。
    uploadConcurrency: positiveInt(env.SOCKDRIVE_UPLOAD_CONCURRENCY, 6, 16),
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
  const lang = body?.lang == null || body.lang === '' ? null : String(body.lang).trim()
  const targetRomKey = String(body?.targetRomKey || '').trim()
  const expectedRomKey = String(body?.expectedRomKey || '').trim()
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
  if (lang && !ROM_LANGS.has(lang)) throw Object.assign(new Error('ROM 语言代码无效'), { status: 400 })
  if (lang && (!validObjectKey(targetRomKey) || !targetRomKey.startsWith('roms/'))) {
    throw Object.assign(new Error('当前语言的完整回退包 key 无效'), { status: 400 })
  }
  // 旧槽可能还是完整 HTTPS 外链；它只用于 CAS 比较，不会被服务端请求，保留原值即可。
  // eslint-disable-next-line no-control-regex
  if (expectedRomKey.length > 500 || /[\x00-\x1f\x7f]/.test(expectedRomKey)) {
    throw Object.assign(new Error('当前语言原 ROM key 无效'), { status: 400 })
  }
  if (!executable) throw Object.assign(new Error('必须填写游戏盘内安全的 .exe 相对路径'), { status: 400 })
  if (!/^v[1-9]\d*$/.test(version) && !/^[a-f0-9]{8,64}$/.test(version)) {
    throw Object.assign(new Error('版本必须是 v1 / v2 这类编号，或 8～64 位内容哈希'), { status: 400 })
  }
  if (!['br', 'gzip', 'identity'].includes(encoding)) throw Object.assign(new Error('压缩格式无效'), { status: 400 })
  if (expectedSockdrive.length > 500 || /[\r\n]/.test(expectedSockdrive)) {
    throw Object.assign(new Error('当前 Sockdrive 目录无效'), { status: 400 })
  }
  // 目录名显式带语言，既方便后台排查，也防止两个语言任务争用同一个不可覆盖版本目录。
  const targetPrefix = `sockdrives/${gameSlug}${lang ? `-${lang.toLowerCase()}` : ''}-${version}`
  return { sourceKey, sourceSize, gameSlug, lang, targetRomKey, expectedRomKey, executable, version, targetPrefix, expectedSockdrive, encoding }
}

function encodeKey(key) {
  return key.split('/').map((part) => encodeURIComponent(part)).join('/')
}

async function workerRequest(config, key, init = {}) {
  const { query: search = '', timeoutMs = FETCH_TIMEOUT_MS, ...options } = init
  return fetch(`${config.workerUrl}/${encodeKey(key)}${search}`, {
    ...options,
    signal: options.signal || AbortSignal.timeout(timeoutMs),
    headers: { Authorization: `Bearer ${config.workerToken}`, ...options.headers },
  })
}

async function remoteHead(config, key, timeoutMs = FETCH_TIMEOUT_MS) {
  const response = await workerRequest(config, key, { method: 'HEAD', timeoutMs })
  if (response.status === 404) return null
  if (!response.ok) throw new Error(`对象存储 HEAD ${key} 失败：HTTP ${response.status}`)
  const size = Number(response.headers.get('content-length'))
  const etag = response.headers.get('etag') || ''
  if (!Number.isSafeInteger(size) || size < 0 || !etag) throw new Error(`对象存储没有返回 ${key} 的完整大小或 ETag`)
  return { size, etag }
}

/**
 * 建任务属于 HTTP 控制面，不能把一分钟的 R2 等待塞进一次管理请求。
 * 后台转换仍保留 60 秒容错；这里只在八秒内拿不到结论就明确回 503，让幂等客户端重试。
 */
async function controlPlaneHead(config, key, label) {
  try {
    return await remoteHead(config, key, CONTROL_PLANE_TIMEOUT_MS)
  } catch (error) {
    throw Object.assign(new Error(`对象存储暂时无法确认${label}；任务尚未创建，请稍后重试`), {
      status: 503,
      retryAfter: 2,
      cause: error,
    })
  }
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
      signal: AbortSignal.timeout(CONTROL_PLANE_TIMEOUT_MS),
      cache: 'no-store',
    })
    if (!response.ok) return false
    const info = await response.json()
    const features = info?.features
    if (features?.privateStagingRead !== true || features?.contentEncodingUpload !== true) return false
    return { sourceCopy: features.sockdriveSourceCopy === true }
  } catch { return false }
}

export async function sockdriveConversionCapability(env = process.env, fresh = false) {
  if (!fresh && capabilityCache && Date.now() - capabilityCache.at < 30_000) return capabilityCache.value
  const config = sockdriveConversionConfig(env)
  let reason = ''
  let sourceCopyAvailable = false
  if (!config.workerUrl) reason = '服务器未配置 SOCKDRIVE_CONVERT_WORKER_URL（可复用 PSP Worker）'
  else if (!config.workerToken) reason = '服务器未配置 Sockdrive Worker 口令'
  else if (!['br', 'gzip', 'identity'].includes(config.encoding)) reason = 'SOCKDRIVE_ENCODING 只能是 br、gzip 或 identity'
  else if (!/^[1-9]\d*(?:[KMG])$/i.test(config.freeSpace)) reason = 'SOCKDRIVE_FREE_SPACE 格式无效'
  else if (!(await commandExists(config.cli))) reason = `找不到 Sockdrive CLI：${config.cli}`
  else if (!(await commandExists('virt-make-fs'))) reason = '找不到 virt-make-fs'
  else if (!(await commandExists('qemu-img'))) reason = '找不到 qemu-img'
  else if (!(await commandExists('7z'))) reason = '找不到 7z'
  else {
    const workerFeatures = await workerSupportsSockdrive(config)
    if (!workerFeatures) reason = 'R2 Worker 尚未部署 Sockdrive 私有 staging / Content-Encoding 支持'
    else sourceCopyAvailable = workerFeatures.sourceCopy
  }
  if (!reason) {
    try {
      const row = await queryOne(
        "SELECT COUNT(*) AS n FROM information_schema.TABLES WHERE table_schema = DATABASE() AND table_name = 'sockdrive_conversion_jobs'",
      )
      if (!Number(row?.n)) reason = '数据库缺少 sockdrive_conversion_jobs；请在 server 目录执行 npm run migrate'
      if (!reason) {
        const columns = await queryOne(
          "SELECT COUNT(*) AS n FROM information_schema.COLUMNS WHERE table_schema = DATABASE() AND table_name = 'sockdrive_conversion_jobs' AND column_name IN ('lang', 'expected_object_key', 'target_object_key', 'resolved_executable')",
        )
        if (Number(columns?.n) !== 4) reason = 'Sockdrive 转换任务列尚未迁移；请在 server 目录执行 npm run migrate'
      }
    } catch {
      reason = '暂时无法检查 Sockdrive 转换任务表'
    }
  }
  const value = {
    available: !reason,
    reason,
    maxSourceBytes: config.maxSourceBytes,
    format: `Sockdrive (${config.encoding === 'br' ? 'Brotli' : config.encoding})`,
    sourceCopyAvailable,
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
    lang: row.lang || null,
    targetRomKey: row.target_object_key || null,
    executable: row.resolved_executable || row.executable,
    bound: Boolean(row.bound),
    message: row.message || '',
    error: row.error || '',
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    completedAt: row.completed_at,
  }
}

/** 后台重启恢复发布时也要按玩家的解析规则校验清单，不能只因预取文件是数组就自动绑定。 */
export function validatePublishedSockdrivePlan(metadata, profile) {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) {
    throw new Error('公开 sockdrive.metaj 根节点无效')
  }
  const sizeKb = metadata.size
  const aheadRead = metadata.ahead_read
  const rangeCount = metadata.range_count
  const sectorSize = metadata.sector_size
  const sizeBytes = sizeKb * 1024
  if (!Number.isSafeInteger(sizeKb) || sizeKb <= 0 || !Number.isSafeInteger(sizeBytes) || sizeBytes > 2 * 1024 ** 3 ||
      !Number.isSafeInteger(aheadRead) || aheadRead <= 0 || aheadRead > 16 * 1024 * 1024 ||
      !Number.isSafeInteger(rangeCount) || rangeCount <= 0 || Math.ceil(sizeBytes / aheadRead) !== rangeCount ||
      !Number.isSafeInteger(sectorSize) || sectorSize <= 0 || aheadRead % sectorSize !== 0) {
    throw new Error('公开 sockdrive.metaj 的磁盘大小、分块或扇区布局无效')
  }

  const seen = new Set()
  const readRanges = (value, field) => {
    if (!Array.isArray(value)) throw new Error(`公开 Sockdrive ${field} 不是数组`)
    const ranges = []
    for (const range of value) {
      if (!Number.isSafeInteger(range) || range < 0 || range >= rangeCount || seen.has(range)) {
        throw new Error(`公开 Sockdrive ${field} 含越界、空范围或重复索引：${String(range)}`)
      }
      seen.add(range)
      ranges.push(range)
    }
    return ranges
  }
  const dropped = new Set(readRanges(metadata.dropped_ranges ?? [], 'dropped_ranges'))
  const small = new Set(readRanges(metadata.small_ranges ?? [], 'small_ranges'))
  // 小范围允许进入 preload_ranges：Sockdrive 会把它们从 preload.raw 中恢复。
  const preload = []
  const preloadValue = metadata.preload_ranges ?? []
  if (!Array.isArray(preloadValue)) throw new Error('公开 Sockdrive preload_ranges 不是数组')
  const preloadSeen = new Set()
  for (const range of preloadValue) {
    if (!Number.isSafeInteger(range) || range < 0 || range >= rangeCount || dropped.has(range) || preloadSeen.has(range)) {
      throw new Error(`公开 Sockdrive preload_ranges 含越界、空范围或重复索引：${String(range)}`)
    }
    preloadSeen.add(range)
    preload.push(range)
  }
  // 独立热点清单覆盖默认预取，不可含坏索引；允许其引用 small_ranges，因为它同样映射到 preload.raw。
  const profileSeen = new Set()
  if (!Array.isArray(profile)) throw new Error('公开 preload_ranges.metaj 不是数组')
  for (const range of profile) {
    if (!Number.isSafeInteger(range) || range < 0 || range >= rangeCount || dropped.has(range) || profileSeen.has(range)) {
      throw new Error(`公开 preload_ranges.metaj 含越界、空范围或重复索引：${String(range)}`)
    }
    profileSeen.add(range)
  }
  return { sizeBytes, aheadRead, rangeCount, sectorSize, dropped, small, preload, profile: [...profile] }
}

/** 清单很小且由管理端生成，但边缘缓存或错误发布仍可能返回任意长度的正文；先限流再解析。 */
export async function readBoundedSockdriveJson(response, label, maxBytes = 1024 * 1024) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) throw new RangeError('Sockdrive JSON 上限无效')
  const rawLength = response.headers.get('content-length')
  const declaredLength = rawLength === null ? null : Number(rawLength)
  if (declaredLength !== null && Number.isSafeInteger(declaredLength) && declaredLength > maxBytes) {
    void response.body?.cancel().catch(() => {})
    throw new Error(`${label} 超过 ${maxBytes} 字节`)
  }

  let bytes
  if (!response.body) {
    if (declaredLength === null || !Number.isSafeInteger(declaredLength) || declaredLength < 0 || declaredLength > maxBytes) {
      throw new Error(`${label} 没有可限制大小的响应流`)
    }
    bytes = new Uint8Array(await response.arrayBuffer())
  } else {
    const reader = response.body.getReader()
    const chunks = []
    let loaded = 0
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        if (!value) continue
        if (loaded + value.byteLength > maxBytes) {
          await reader.cancel().catch(() => {})
          throw new Error(`${label} 超过 ${maxBytes} 字节`)
        }
        chunks.push(value)
        loaded += value.byteLength
      }
    } catch (error) {
      await reader.cancel(error).catch(() => {})
      throw error
    } finally {
      try { reader.releaseLock() } catch { /* 已终止的响应流无需再次释放 */ }
    }
    bytes = new Uint8Array(loaded)
    let offset = 0
    for (const chunk of chunks) {
      bytes.set(chunk, offset)
      offset += chunk.byteLength
    }
  }
  if (bytes.byteLength > maxBytes) throw new Error(`${label} 超过 ${maxBytes} 字节`)
  try {
    return JSON.parse(new TextDecoder().decode(bytes))
  } catch (error) {
    throw new Error(`${label} 不是有效 JSON`, { cause: error })
  }
}

/** 玩家规范路径必须与绕过缓存的发布内容完全一致，不能只比较分块总数。 */
export function publishedSockdrivePlansMatch(left, right) {
  const sameSet = (a, b) => a.size === b.size && [...a].every((value) => b.has(value))
  const sameArray = (a, b) => a.length === b.length && a.every((value, index) => value === b[index])
  return left.sizeBytes === right.sizeBytes && left.aheadRead === right.aheadRead &&
    left.rangeCount === right.rangeCount && left.sectorSize === right.sectorSize &&
    sameSet(left.dropped, right.dropped) && sameSet(left.small, right.small) &&
    sameArray(left.preload, right.preload) && sameArray(left.profile, right.profile)
}

function sameRequest(row, request) {
  return row.source_key === request.sourceKey && Number(row.source_size) === request.sourceSize &&
    row.game_slug === request.gameSlug && (row.lang || null) === request.lang &&
    String(row.target_object_key || '') === request.targetRomKey && String(row.expected_object_key || '') === request.expectedRomKey &&
    row.executable === request.executable && row.version === request.version &&
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
  const request = validateSockdriveConversionRequest(raw, env)
  let existing
  try {
    existing = await existingJobForSource(request)
  } catch (error) {
    const capability = await sockdriveConversionCapability(env, true)
    if (!capability.available) throw Object.assign(new Error(capability.reason), { status: 503 })
    throw error
  }
  if (existing) return existing
  const capability = await sockdriveConversionCapability(env)
  if (!capability.available) throw Object.assign(new Error(capability.reason), { status: 503 })
  const game = await queryOne(
    'SELECT id, platform, dos_backend, dos_system, dos_sockdrive, dos_extras, dos_executable FROM games WHERE slug = ?',
    [request.gameSlug],
  )
  if (!game) throw Object.assign(new Error('要绑定的游戏不存在；请先保存游戏资料'), { status: 409 })
  if (game.platform !== 'dos' || game.dos_backend !== 'dosboxX') {
    throw Object.assign(new Error('目标游戏必须先配置 DOSBox-X；普通 DOSBox 不支持 Sockdrive'), { status: 409 })
  }
  if (!String(game.dos_system || '').trim() && !request.executable.split('/').every((part) => DOS_83_SEGMENT.test(part))) {
    throw Object.assign(new Error('纯 DOS 流式盘的启动程序必须使用 DOS 8.3 路径'), { status: 409 })
  }
  if (hasDosExtras(game.dos_extras)) {
    throw Object.assign(new Error('目标游戏还有 DOS 附加文件；请先把补丁合入 ZIP，流式盘不能在浏览器现场叠加'), { status: 409 })
  }
  const languageRom = request.lang
    ? await queryOne('SELECT object_key, dos_executable, dos_sockdrive FROM game_roms WHERE game_id = ? AND lang = ?', [game.id, request.lang])
    : null
  const currentRomKey = String(languageRom?.object_key || '')
  if (request.lang && currentRomKey !== request.expectedRomKey && currentRomKey !== request.targetRomKey) {
    throw Object.assign(new Error('这个语言槽的 ROM 已被其他人修改，请刷新表单后重试'), { status: 409 })
  }
  const currentSockdrive = request.lang ? languageRom?.dos_sockdrive : game.dos_sockdrive
  if (String(currentSockdrive || '').trim().replace(/\/+$/, '') !== request.expectedSockdrive) {
    throw Object.assign(new Error('Sockdrive 绑定已被其他人修改，请刷新表单后重试'), { status: 409 })
  }
  const config = sockdriveConversionConfig(env)
  // 三个 HEAD 互不依赖；串行最坏会越过 Cloudflare 网关时限，造成“服务器其实建了任务、浏览器只见 504”。
  const [source, fallback, published] = await Promise.all([
    controlPlaneHead(config, request.sourceKey, '临时 ZIP'),
    request.lang ? controlPlaneHead(config, request.targetRomKey, '完整回退包') : null,
    controlPlaneHead(config, `${request.targetPrefix}/sockdrive.metaj`, '目标版本目录'),
  ])
  if (!source) throw Object.assign(new Error('临时 ZIP 不存在；请重新上传'), { status: 404 })
  if (source.size !== request.sourceSize) throw Object.assign(new Error('临时 ZIP 大小与浏览器上报不一致'), { status: 409 })
  if (request.lang && !fallback) {
    throw Object.assign(new Error('完整回退包尚未上传成功；拒绝创建只有流式盘的语言槽'), { status: 409 })
  }
  if (published) {
    throw Object.assign(new Error('目标版本目录已经存在；Sockdrive 禁止原地覆盖，请换新版本'), { status: 409 })
  }

  const id = randomUUID()
  try {
    await query(
      `INSERT INTO sockdrive_conversion_jobs
       (id, source_key, source_size, source_etag, game_id, game_slug, lang, executable, expected_executable,
        expected_object_key, target_object_key, version, target_prefix, expected_sockdrive, encoding, actor_id, status, progress)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', 0)`,
      [id, request.sourceKey, request.sourceSize, source.etag, game.id, request.gameSlug, request.lang,
        request.executable, String((request.lang ? languageRom?.dos_executable : game.dos_executable) || ''),
        request.expectedRomKey, request.targetRomKey, request.version, request.targetPrefix, request.expectedSockdrive,
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

async function retryExecutableSnapshot(row) {
  const game = await queryOne('SELECT id, dos_executable FROM games WHERE id = ?', [row.game_id])
  if (!game) throw Object.assign(new Error('原游戏已删除，不能重试这个转换任务'), { status: 409 })

  let effective = String(game.dos_executable || '').trim()
  let expected = effective
  if (row.lang) {
    const languageRom = await queryOne(
      'SELECT dos_executable FROM game_roms WHERE game_id = ? AND lang = ?',
      [game.id, row.lang],
    )
    const languageExecutable = String(languageRom?.dos_executable || '').trim()
    // 语言槽留空时播放器会回退默认 EXE，但绑定时仍要守住语言槽自身的原值。
    if (languageExecutable) effective = languageExecutable
    expected = languageExecutable
  }
  const executable = validExecutable(effective)
  if (!executable) {
    throw Object.assign(new Error('当前游戏的启动 EXE 无效；请先保存游戏盘内的 .exe 相对路径'), { status: 409 })
  }
  return { executable, expected }
}

export async function retrySockdriveConversion(id) {
  const row = await queryOne('SELECT * FROM sockdrive_conversion_jobs WHERE id = ?', [id])
  if (!row) return null
  if (ACTIVE.has(row.status) || row.status === 'completed') return publicJob(row)
  if (Number(row.source_deleted) === 2) {
    throw Object.assign(new Error('任务临时文件正在清理，请稍后刷新'), { status: 409 })
  }
  if (!row.publish_started && Number(row.source_deleted) !== 0) {
    throw Object.assign(new Error('临时 ZIP 已清理且发布尚未开始，不能重试；请重新上传'), { status: 409 })
  }
  /*
   * 重试接口只负责重新排队，不能同步 HEAD R2：发布过的任务要查元数据，未发布的还要查源 ZIP，
   * 两次外部等待曾超过 Cloudflare 时限直接回 504。processJob 本来就会按 ETag 重新校验源文件，
   * 并在 publish_started 时先检查已提交元数据；把 I/O 留给后台既不降低安全性，也让请求立即返回。
   */
  /*
   * 条件里必须带上 source_deleted：上面那次读和这次写之间，清扫器（sweepStaleSources）
   * 可能刚领走这份 24 小时前失败的源 ZIP（source_deleted 0 → 2 → 1）。不在同一条 UPDATE 里
   * 核对，就会把一个「源文件正在被删」的任务重新排队，processJob 下载到一半 404。
   * 发布已开始的任务不再需要源 ZIP（只补发布 / 绑定），所以这类不看 source_deleted。
   * PSP 转换的重试（psp-conversion.js）是同一条规矩。
   */
  /*
   * 失败源保留给管理员修配置后直接重试。如果仍沿用任务创建时的 executable 快照，
   * “源文件找不到 1.exe”这类错误会把同一份 ZIP 永久卡死，逼人重新上传数百 MB。
   * 只有尚未发布时才重取配置；发布过的磁盘内已经写入启动脚本，不能把元数据改成另一套入口。
   */
  const executable = row.publish_started
    ? { executable: row.executable, expected: row.expected_executable }
    : await retryExecutableSnapshot(row)
  const claimed = await query(
    `UPDATE sockdrive_conversion_jobs
      SET executable = ?, expected_executable = ?,
        resolved_executable = CASE WHEN publish_started = 1 THEN resolved_executable ELSE NULL END,
        status = 'queued', progress = 0, error = NULL,
        message = '按当前游戏配置重新排队', completed_at = NULL
      WHERE id = ? AND status = 'failed' AND source_deleted <> 2 AND (publish_started = 1 OR source_deleted = 0)`,
    [executable.executable, executable.expected, id],
  )
  if (claimed.affectedRows !== 1) {
    const now = await queryOne('SELECT status, publish_started, source_deleted FROM sockdrive_conversion_jobs WHERE id = ?', [id])
    if (now && now.status === 'failed' && Number(now.source_deleted) === 2) {
      throw Object.assign(new Error('任务临时文件正在清理，请稍后刷新'), { status: 409 })
    }
    if (now && now.status === 'failed' && !Number(now.publish_started) && Number(now.source_deleted) !== 0) {
      throw Object.assign(new Error('临时 ZIP 正在清理或已经删除，不能重试；请重新上传'), { status: 409 })
    }
    throw Object.assign(new Error('任务状态刚刚变化，请刷新后再试'), { status: 409 })
  }
  schedulePump()
  return getSockdriveConversion(id)
}

async function updateJob(id, fields) {
  const allowed = new Set([
    'status', 'progress', 'output_bytes', 'output_files', 'metadata_etag', 'range_count', 'bound',
    'publish_started', 'resolved_executable', 'message', 'error', 'completed_at', 'source_deleted',
  ])
  const entries = Object.entries(fields).filter(([key]) => allowed.has(key))
  if (!entries.length) return
  const sql = entries.map(([key]) => `\`${key}\` = ?`).join(', ')
  await query(`UPDATE sockdrive_conversion_jobs SET ${sql} WHERE id = ?`, [...entries.map(([, value]) => value), id])
}

async function ensureDiskSpace(config, sourceSize, existingSourceBytes = 0) {
  await mkdir(config.tempDir, { recursive: true })
  const fs = await statfs(config.tempDir)
  const free = Number(fs.bavail) * Number(fs.bsize)
  // ZIP、解压目录、QCOW2 与发布分块会短暂并存；12GB 下限覆盖高压缩比的小源包，5 倍覆盖普通大包。
  const fullNeed = Math.max(12 * 1024 ** 3, sourceSize * 5 + 1024 ** 3)
  // 重试会复用完整 staging ZIP；它已经占用的空间不能再次算作待新增空间。
  const need = Math.max(0, fullNeed - Math.min(sourceSize, Math.max(0, existingSourceBytes)))
  if (!Number.isFinite(free) || free < need) {
    throw new Error(`Sockdrive 工作盘空间不足：至少需要 ${Math.ceil(need / 1024 / 1024)}MB 可用空间`)
  }
}

async function reusableSourceZip(path, expectedSize) {
  let file
  try {
    file = await open(path, 'r')
    const info = await file.stat()
    if (!info.isFile() || info.size !== Number(expectedSize)) return false
    const header = Buffer.alloc(4)
    const { bytesRead } = await file.read(header, 0, header.length, 0)
    return bytesRead === 4 && (
      header.equals(Buffer.from([0x50, 0x4b, 0x03, 0x04])) ||
      header.equals(Buffer.from([0x50, 0x4b, 0x05, 0x06]))
    )
  } catch {
    return false
  } finally {
    await file?.close().catch(() => {})
  }
}

async function downloadSource(job, config, destination) {
  const controller = new AbortController()
  let idle
  const armIdle = () => {
    clearTimeout(idle)
    idle = setTimeout(() => controller.abort(new Error('下载连续 60 秒没有收到数据')), SOURCE_IDLE_MS)
    idle.unref?.()
  }
  armIdle()
  let received = 0
  let reported = -1
  let progressWrites = Promise.resolve()
  let progressError = null
  try {
    const response = await workerRequest(config, job.source_key, {
      method: 'GET', headers: { 'If-Match': job.source_etag }, signal: controller.signal,
    })
    if (response.status === 412) throw new Error('临时 ZIP 在任务创建后被覆盖，已停止转换')
    if (!response.ok || !response.body) throw new Error(`下载临时 ZIP 失败：HTTP ${response.status}`)
    if (Number(response.headers.get('content-length')) !== Number(job.source_size)) throw new Error('下载响应大小与任务记录不一致')
    const countAndValidate = new Transform({
      transform(chunk, _encoding, callback) {
        armIdle()
        if (received + chunk.byteLength > Number(job.source_size)) {
          callback(new Error('下载数据超过任务记录大小'))
          return
        }
        received += chunk.byteLength
        const progress = 4 + Math.floor(received / Number(job.source_size) * 16)
        if (progress !== reported) {
          reported = progress
          // 数据库进度不再阻塞每一个网络 chunk；最多 17 次更新串行落库，管线继续让网络与磁盘重叠。
          progressWrites = progressWrites
            .then(() => updateJob(job.id, { progress }))
            .catch((error) => { progressError ??= error })
        }
        callback(null, chunk)
      },
    })
    await pipeline(
      Readable.fromWeb(response.body),
      countAndValidate,
      // 1MB 缓冲只占固定小内存，却避免每个 64KB 网络块都等一次磁盘落盘后才继续读。
      createWriteStream(destination, { flags: 'wx', highWaterMark: 1024 * 1024 }),
    )
    await progressWrites
    if (progressError) throw progressError
  } finally {
    clearTimeout(idle)
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

/**
 * 上传数千个分块时，子进程尾部绝大多数是“上传 4499/4465”进度。数据库若从头截断，
 * 真正的异常和堆栈反而全部丢失，后台只能看到无意义的 exit 1。失败信息必须保留末尾。
 */
export function sockdriveFailureMessage(error, maxChars = MAX_ERROR_CHARS) {
  const raw = String(error?.message || error || '未知错误').trim()
  if (raw.length <= maxChars) return raw
  return `…${raw.slice(-(maxChars - 1))}`
}

export function sockdriveConversionProgress(text) {
  if (/Sockdrive 制作完成/.test(text)) return 70
  if (/Sockdrive 结构完整/.test(text)) return 68
  const compression = /压缩 Sockdrive 分块：(\d+)\/(\d+)/.exec(text)
  if (compression) {
    const completed = Number(compression[1])
    const total = Math.max(1, Number(compression[2]))
    return 55 + Math.min(12, Math.floor(completed / total * 13))
  }
  if (/调用官方 sockify/.test(text)) return 55
  if (/制作 FAT32\/QCOW2/.test(text)) return 40
  if (/源文件检查通过/.test(text)) return 32
  return null
}

export function parseSockdriveOutputSummary(text) {
  const match = /Sockdrive 输出统计：(\d+) 个文件 \/ (\d+) 字节/.exec(String(text || ''))
  if (!match) return null
  const files = Number(match[1])
  const bytes = Number(match[2])
  if (!Number.isSafeInteger(files) || !Number.isSafeInteger(bytes)) return null
  return { files, bytes }
}

async function readPreparedExecutable(job, buildRoot) {
  let manifest
  try {
    manifest = JSON.parse(await readFile(join(buildRoot, 'release.json'), 'utf8'))
  } catch (error) {
    throw new Error(`Sockdrive 制作清单缺失或无效：${error instanceof Error ? error.message : String(error)}`)
  }
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    throw new Error('Sockdrive 制作清单内容格式无效')
  }
  const requested = validExecutable(job.executable)
  const resolved = validExecutable(manifest.executable)
  const recordedRequest = validExecutable(manifest.requestedExecutable || manifest.executable)
  if (!requested || !resolved || recordedRequest !== requested ||
      manifest.slug !== job.game_slug || manifest.version !== job.version) {
    throw new Error('Sockdrive 制作清单中的启动程序与当前任务不一致')
  }
  const normalizePath = (value) => value.normalize('NFC').toLowerCase()
  const sameRequestedEntry = requested.includes('/')
    ? normalizePath(resolved) === normalizePath(requested)
    : normalizePath(resolved.split('/').at(-1)) === normalizePath(requested)
  if (!sameRequestedEntry) throw new Error('Sockdrive 制作清单自动定位到了不同名称的启动程序')
  return resolved
}

async function recordPreparedOutput(job, config, directory, markerPath) {
  const files = await listSockdriveFiles(directory, { strict: true })
  const record = {
    version: 1,
    sourceEtag: job.source_etag,
    sourceSize: Number(job.source_size),
    targetPrefix: job.target_prefix,
    executable: job.executable,
    resolvedExecutable: job.resolved_executable,
    encoding: job.encoding,
    cli: config.cli,
    freeSpace: config.freeSpace,
    brotliQuality: config.brotliQuality,
    publicBase: config.publicBase,
    files: files.map(({ name, size }) => [name, size]),
  }
  // 这个完成标记由父进程在制作脚本完整退出后写入；没有它就不能把半成品目录当成可续发产物。
  await writeFile(markerPath, JSON.stringify(record), { flag: 'wx' })
  return { files: files.length, bytes: files.reduce((total, file) => total + file.size, 0) }
}

async function reusablePreparedOutput(job, config, directory, markerPath) {
  try {
    const record = JSON.parse(await readFile(markerPath, 'utf8'))
    if (record.version !== 1 || record.sourceEtag !== job.source_etag ||
        Number(record.sourceSize) !== Number(job.source_size) || record.targetPrefix !== job.target_prefix ||
        record.executable !== job.executable ||
        !validExecutable(record.resolvedExecutable) ||
        (validExecutable(job.resolved_executable) && record.resolvedExecutable !== job.resolved_executable) ||
        record.encoding !== job.encoding || record.cli !== config.cli || record.freeSpace !== config.freeSpace ||
        record.brotliQuality !== config.brotliQuality || record.publicBase !== config.publicBase ||
        !Array.isArray(record.files)) return null
    const files = await listSockdriveFiles(directory, { strict: true })
    if (record.files.length !== files.length || record.files.some((item, index) =>
      !Array.isArray(item) || item[0] !== files[index].name || Number(item[1]) !== files[index].size)) return null
    return {
      files: files.length,
      bytes: files.reduce((total, file) => total + file.size, 0),
      resolvedExecutable: record.resolvedExecutable,
    }
  } catch {
    return null
  }
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
  const metadata = await readBoundedSockdriveJson(metadataResponse, '公开 sockdrive.metaj')
  const cors = metadataResponse.headers.get('access-control-allow-origin')
  if (cors !== '*' && cors !== 'https://8bitgo.com') throw new Error('公开 Sockdrive 没有允许 8bitgo.com 跨域读取')
  const preload = await fetch(`${root}/preload_ranges.metaj?verify=${stamp}`, {
    headers: publicHeaders, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS), cache: 'no-store',
  })
  if (!preload.ok) throw new Error('公开 preload_ranges.metaj 无效')
  const profile = await readBoundedSockdriveJson(preload, '公开 preload_ranges.metaj')
  const plan = validatePublishedSockdrivePlan(metadata, profile)
  let sampleRange
  for (let range = 0; sampleRange === undefined && range < plan.rangeCount; range++) {
    if (!plan.dropped.has(range) && !plan.small.has(range)) sampleRange = range
  }
  const sample = sampleRange === undefined ? (plan.small.size ? 'preload.raw' : '') : `${sampleRange}.raw`
  if (sample) {
    const readsBody = sampleRange !== undefined
    const response = await fetch(`${root}/${sample}?verify=${stamp}`, {
      method: readsBody ? 'GET' : 'HEAD', headers: publicHeaders,
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS), cache: 'no-store',
    })
    if (!response.ok) throw new Error(`公开分块 ${sample} 读取失败：HTTP ${response.status}`)
    const actualEncoding = response.headers.get('content-encoding') || 'identity'
    if (actualEncoding !== job.encoding) throw new Error(`公开分块编码是 ${actualEncoding}，应为 ${job.encoding}`)
    if (readsBody) {
      const expected = Math.min(plan.aheadRead, plan.sizeBytes - sampleRange * plan.aheadRead)
      const actual = (await response.arrayBuffer()).byteLength
      if (actual !== expected) throw new Error(`公开分块 ${sample} 解码后是 ${actual} 字节，应为 ${expected} 字节`)
    }
  }
  // 上传器已经验过规范 URL；后台重启后可能直接从“元数据已提交”恢复，仍要自己连读两次，
  // 防止把只有首次 MISS 正常、后续缓存 HIT 损坏的目录重新绑定给玩家。
  for (let pass = 1; pass <= 2; pass++) {
    const canonical = await fetch(`${root}/sockdrive.metaj`, {
      headers: publicHeaders, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    })
    if (!canonical.ok) throw new Error(`玩家路径第 ${pass} 次读取 sockdrive.metaj 失败：HTTP ${canonical.status}`)
    const canonicalMetadata = await readBoundedSockdriveJson(canonical, `玩家路径第 ${pass} 次读取 sockdrive.metaj`)
    const canonicalPreload = await fetch(`${root}/preload_ranges.metaj`, {
      headers: publicHeaders, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    })
    if (!canonicalPreload.ok) throw new Error(`玩家路径第 ${pass} 次读取 preload_ranges.metaj 失败：HTTP ${canonicalPreload.status}`)
    const canonicalProfile = await readBoundedSockdriveJson(canonicalPreload, `玩家路径第 ${pass} 次读取 preload_ranges.metaj`)
    let canonicalPlan
    try {
      canonicalPlan = validatePublishedSockdrivePlan(canonicalMetadata, canonicalProfile)
    } catch (error) {
      throw new Error(`玩家路径第 ${pass} 次读取到无效 Sockdrive 清单：${error instanceof Error ? error.message : String(error)}`)
    }
    if (!publishedSockdrivePlansMatch(plan, canonicalPlan)) {
      throw new Error(`玩家路径第 ${pass} 次读取的 Sockdrive 清单与已发布产物不一致`)
    }
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
    if (game.platform !== 'dos' || game.dos_backend !== 'dosboxX') {
      return { bound: false, message: '游戏运行环境已改变；Sockdrive 已发布但未绑定' }
    }
    if (hasDosExtras(game.dos_extras)) return { bound: false, message: '游戏新增了附加文件；为避免流式盘漏补丁，未自动绑定' }
    if (job.lang) {
      const romRows = await run(
        'SELECT object_key, dos_executable, dos_sockdrive FROM game_roms WHERE game_id = ? AND lang = ? FOR UPDATE',
        [game.id, job.lang],
      )
      const rom = romRows[0]
      const current = String(rom?.dos_sockdrive || '').trim().replace(/\/+$/, '')
      const currentObjectKey = String(rom?.object_key || '')
      const currentExecutable = String(rom?.dos_executable || '')
      if (current === job.target_prefix && currentObjectKey === job.target_object_key && String(rom?.dos_executable || '') === job.executable) {
        return { bound: true, message: `${job.lang} Sockdrive 已经绑定` }
      }
      if (
        current !== String(job.expected_sockdrive || '') ||
        (currentExecutable !== String(job.expected_executable || '') && !(currentObjectKey === String(job.target_object_key || '') && currentExecutable === job.executable)) ||
        (currentObjectKey !== String(job.expected_object_key || '') && currentObjectKey !== String(job.target_object_key || ''))
      ) {
        return { bound: false, message: '这个语言槽在转换期间被修改；已保留新配置，没有强行覆盖' }
      }
      if (rom) {
        await run(
          'UPDATE game_roms SET object_key = ?, dos_sockdrive = ?, dos_executable = ? WHERE game_id = ? AND lang = ?',
          [job.target_object_key, job.target_prefix, job.executable, game.id, job.lang],
        )
      } else {
        await run(
          'INSERT INTO game_roms (game_id, lang, object_key, dos_executable, dos_sockdrive) VALUES (?, ?, ?, ?, ?)',
          [game.id, job.lang, job.target_object_key, job.executable, job.target_prefix],
        )
      }
      return { bound: true, message: `${job.lang} 完整回退包、Sockdrive 与启动 EXE 已原子绑定` }
    }
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
  try {
    // 完整回退包在数小时转换期间仍可能被后台删除；最终绑定前再确认一次，不能发布出只有流式盘的语言槽。
    if (job.lang && !(await remoteHead(config, job.target_object_key))) {
      binding = { bound: false, message: '完整回退包在转换期间被删除；Sockdrive 已发布但未自动绑定' }
    } else if (!validExecutable(job.resolved_executable)) {
      binding = { bound: false, message: 'Sockdrive 已发布，但无法确认 ZIP 内启动程序的实际路径；为避免错误启动，未自动绑定' }
    } else {
      binding = await bindPublished({ ...job, executable: job.resolved_executable })
      if (binding.bound && job.resolved_executable !== job.executable) {
        binding.message += `；启动程序已自动定位为 ${job.resolved_executable}`
      }
    }
  }
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
  const preparedMarker = join(buildRoot, '.8bg-publish-ready.json')
  let completed = false
  try {
    if (job.publish_started) {
      const existing = await remoteHead(config, `${job.target_prefix}/sockdrive.metaj`)
      if (existing) {
        await updateJob(job.id, { status: 'verifying', progress: 98, message: '检测到已提交的元数据，正在恢复校验与绑定' })
        const published = await verifyPublished(config, job)
        // 进程重启后只从本任务的制作清单恢复规范路径；缺清单时 finish 会安全地不自动绑定。
        const storedExecutable = validExecutable(job.resolved_executable)
        const manifestExecutable = await readPreparedExecutable(job, buildRoot).catch((error) => {
          console.warn(`[sockdrive-convert] ${job.id} 无法恢复启动程序路径：${error.message}`)
          return null
        })
        const executableMismatch = Boolean(manifestExecutable && storedExecutable && storedExecutable !== manifestExecutable)
        job.resolved_executable = executableMismatch ? '' : manifestExecutable || storedExecutable
        if (executableMismatch) await updateJob(job.id, { resolved_executable: null }).catch(() => {})
        await finishPublishedJob(job, config, published)
        completed = true
        return
      }
    }
    let summary = await reusablePreparedOutput(job, config, publishDir, preparedMarker)
    if (summary) {
      try {
        const resolvedExecutable = await readPreparedExecutable(job, buildRoot)
        if (resolvedExecutable !== summary.resolvedExecutable) summary = null
        else {
          const storedExecutable = validExecutable(job.resolved_executable)
          job.resolved_executable = resolvedExecutable
          if (!storedExecutable) {
            await updateJob(job.id, { resolved_executable: job.resolved_executable })
          }
        }
      } catch {
        summary = null
      }
    }
    if (!summary) {
      // 制作未完成时清掉旧 work 目录，保留完整 ZIP；重试只需重做镜像，不必从 R2 再拉数 GB。
      await rm(workRoot, { recursive: true, force: true })
      await mkdir(dir, { recursive: true })
      const sourceReady = await reusableSourceZip(input, Number(job.source_size))
      if (!sourceReady) await rm(input, { force: true })
      await ensureDiskSpace(config, Number(job.source_size), sourceReady ? Number(job.source_size) : 0)
      if (!sourceReady) {
        await updateJob(job.id, { status: 'downloading', progress: 3, error: null, message: '正在从私有 staging 读取原始 ZIP' })
        await downloadSource(job, config, input)
      } else {
        await updateJob(job.id, { status: 'downloading', progress: 20, error: null, message: '复用上次已下载完成的 ZIP' })
      }

      await updateJob(job.id, { status: 'converting', progress: 22, message: '正在制作 FAT32/QCOW2 并生成 Sockdrive 分块' })
      let progress = 22
      let progressWrites = Promise.resolve()
      const gameRuntime = await queryOne('SELECT dos_system FROM games WHERE id = ?', [job.game_id])
      const windowsGuest = Boolean(String(gameRuntime?.dos_system || '').trim())
      const prepareArgs = [
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
        '--compression-concurrency', String(config.compressionConcurrency),
        '--brotli-quality', String(config.brotliQuality),
        '--defer-validation',
      ]
      if (!windowsGuest) prepareArgs.push('--dos83-exe')
      await runCommand(process.execPath, prepareArgs, {
        timeoutMs: config.timeoutMs,
        onText: (text) => {
          const next = sockdriveConversionProgress(text)
          if (next == null || next <= progress) return
          progress = next
          progressWrites = progressWrites.then(() => updateJob(job.id, { progress })).catch(() => {})
        },
      })
      await progressWrites
      job.resolved_executable = await readPreparedExecutable(job, buildRoot)
      summary = await recordPreparedOutput(job, config, publishDir, preparedMarker)
      await updateJob(job.id, { resolved_executable: job.resolved_executable })
    }
    await updateJob(job.id, {
      status: 'uploading', progress: 72, output_bytes: summary.bytes, output_files: summary.files,
      publish_started: 1, message: `正在发布 ${summary.files} 个不可变分块到 R2`,
    })
    // 本地发布目录已经完整落盘并有完成标记，原始 ZIP 之后不再参与上传；尽早腾出数据盘空间。
    await rm(input, { force: true }).catch(() => {})
    let uploaded = 0
    await runCommand(process.execPath, [
      UPLOAD_SCRIPT,
      '--src', publishDir,
      '--prefix', job.target_prefix,
      '--encoding', job.encoding,
      '--public-base', config.publicBase,
      '--worker-url', config.workerUrl,
      '--concurrency', String(config.uploadConcurrency),
    ], {
      timeoutMs: config.timeoutMs,
      env: { ...process.env, SOCKDRIVE_WORKER_TOKEN: config.workerToken },
      onText: (text) => {
        const match = /上传 .*（(\d+)\/(\d+)）/.exec(text)
        if (!match) return
        const bytes = /\[(\d+)\/(\d+) 字节/.exec(text)
        const ratio = bytes
          ? Number(bytes[1]) / Math.max(1, Number(bytes[2]))
          : Number(match[1]) / Math.max(1, Number(match[2]))
        const next = 72 + Math.floor(ratio * 24)
        if (next <= uploaded) return
        uploaded = next
        void updateJob(job.id, { progress: next }).catch(() => {})
      },
    })
    await updateJob(job.id, { status: 'verifying', progress: 98, message: '正在通过公开域名复核元数据、热点清单和编码' })
    const published = await verifyPublished(config, job)
    await finishPublishedJob(job, config, published)
    completed = true
  } catch (error) {
    const message = sockdriveFailureMessage(error)
    console.error(`[sockdrive-convert] ${job.id} 失败：`, error)
    /*
     * job 是开工时读的那一行；publish_started 是这次运行中途才写进库的（updateJob 不改内存对象），
     * 直接读 job.publish_started 会在「发布已开始」时仍提示「临时 ZIP 已保留」—— 而那时源 ZIP
     * 可能已经清理，管理员照着提示去等重试反而是错的。所以先回库读一次真实状态。
     */
    const current = await queryOne('SELECT publish_started FROM sockdrive_conversion_jobs WHERE id = ?', [job.id]).catch(() => null)
    const publishStarted = Boolean(Number(current?.publish_started ?? job.publish_started)) || existsSync(preparedMarker)
    await updateJob(job.id, {
      status: 'failed', error: message,
      message: publishStarted ? '已保留任务状态；可重试恢复发布或绑定' : '临时 ZIP 已保留，可在 24 小时内重试',
    }).catch(() => {})
  } finally {
    if (completed) {
      await rm(dir, { recursive: true, force: true }).catch(() => {})
    } else if (existsSync(preparedMarker)) {
      // 分块已制好，发布/校验/绑定重试只需继续用本地发布目录，不再跑数小时制作流程。
      await rm(input, { force: true }).catch(() => {})
      console.log(`[sockdrive-convert] ${job.id} 保留已制好的发布目录，重试可跳过重新制盘`)
    } else if (await reusableSourceZip(input, Number(job.source_size))) {
      // 制盘失败时只保留可复用源 ZIP；下次重做前会删除不完整的 work 目录。
      await rm(workRoot, { recursive: true, force: true }).catch(() => {})
      console.log(`[sockdrive-convert] ${job.id} 保留已下载 ZIP，重试可跳过重新下载`)
    } else {
      await rm(dir, { recursive: true, force: true }).catch(() => {})
    }
  }
}

async function sweepStaleSources() {
  const config = sockdriveConversionConfig()
  const rows = await query(
    `SELECT id, source_key, status, message, source_deleted FROM sockdrive_conversion_jobs
      WHERE source_deleted IN (0, 2)
        AND (source_deleted = 2 OR status = 'completed' OR (status = 'failed' AND updated_at < NOW() - INTERVAL 24 HOUR))
      ORDER BY updated_at ASC LIMIT 20`,
  )
  for (const row of rows) {
    let sourceDeleted = false
    try {
      if (Number(row.source_deleted) === 0) {
        const claimed = await query(
          `UPDATE sockdrive_conversion_jobs SET source_deleted = 2
          WHERE id = ? AND source_deleted = 0
              AND (status = 'completed' OR (status = 'failed' AND updated_at < NOW() - INTERVAL 24 HOUR))`,
          [row.id],
        )
        if (claimed.affectedRows !== 1) continue
      } else if (Number(row.source_deleted) !== 2) continue
      await deleteSource(row, config)
      sourceDeleted = true
      await updateJob(row.id, {
        source_deleted: 1,
        ...(row.status === 'failed' ? { message: '临时 ZIP 已在失败 24 小时后自动清理' } : {}),
      })
    } catch (error) {
      // 远端删除没确认才退回 0；若 R2 已删而数据库暂时写不进去，留在 2，下一轮按幂等 DELETE 收尾。
      if (!sourceDeleted) await updateJob(row.id, { source_deleted: 0 }).catch(() => {})
      console.warn(`[sockdrive-convert] 清理 ${row.source_key} 失败：${error.message}`)
      continue
    }
    // 本地磁盘回收与 R2 / 数据库状态分开；本地权限或 I/O 故障不能把已删的远端源误报成可重试。
    await rm(join(config.tempDir, row.id), { recursive: true, force: true }).catch(async (error) => {
      // source_deleted=2 同时作为本地目录待清理标记；下一轮不受 failed.updated_at 的 24 小时门槛影响。
      await updateJob(row.id, { source_deleted: 2 }).catch(() => {})
      console.warn(`[sockdrive-convert] 本地目录 ${row.id} 清理失败：${error.message}`)
    })
  }
  await sweepRetainedWorkDirs(config)
}

/** 完成任务与已清掉 staging 的旧失败任务仍可能因进程崩溃留有本地制作目录。 */
async function sweepRetainedWorkDirs(config) {
  const rows = await query(
    `SELECT id, status, source_deleted FROM sockdrive_conversion_jobs
      WHERE source_deleted IN (1, 2)
        AND (source_deleted = 2 OR status = 'completed' OR (status = 'failed' AND updated_at < NOW() - INTERVAL 24 HOUR))
      ORDER BY updated_at ASC LIMIT 20`,
  )
  for (const row of rows) {
    if (Number(row.source_deleted) === 1) {
      const claim = await query(
        `UPDATE sockdrive_conversion_jobs SET source_deleted = 2
          WHERE id = ? AND source_deleted = 1
            AND (status = 'completed' OR (status = 'failed' AND updated_at < NOW() - INTERVAL 24 HOUR))`,
        [row.id],
      )
      if (claim.affectedRows !== 1) continue
    } else if (Number(row.source_deleted) !== 2) continue
    try {
      await rm(join(config.tempDir, row.id), { recursive: true, force: true })
      await updateJob(row.id, { source_deleted: 1 })
    } catch (error) {
      // 留在 2 让下一轮立即续收；rm 可重复执行，失败任务的重试入口也会在这期间阻止启动。
      console.warn(`[sockdrive-convert] 本地制作目录 ${row.id} 清理失败：${error.message}`)
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
  if (pumping) {
    // 任务可能在异步领取期间再次唤醒队列；延后而不是并行启动第二个制盘循环。
    schedulePump(50)
    return
  }
  pumping = true
  pumpTimer = undefined
  try {
    const config = sockdriveConversionConfig()
    while (activeWorkers < config.concurrency) {
      let claimFailed = false
      const job = await claimNext().catch((error) => {
        claimFailed = true
        console.error('[sockdrive-convert] 领取任务失败：', error.message)
        return null
      })
      if (!job) {
        if (claimFailed) {
          schedulePump(claimRetryMs)
          claimRetryMs = Math.min(claimRetryMs * 2, 60_000)
        } else claimRetryMs = 5_000
        break
      }
      claimRetryMs = 5_000
      activeWorkers++
      void processJob(job).finally(() => { activeWorkers--; schedulePump(50) })
    }
  } finally {
    pumping = false
  }
}

function schedulePump(delay = 0) {
  if (!started || pumpTimer) return
  pumpTimer = setTimeout(() => {
    pumpTimer = undefined
    void pump()
  }, delay)
  pumpTimer.unref?.()
}

export async function startSockdriveConversionQueue() {
  if (started || starting) return
  starting = true
  try {
    const capability = await sockdriveConversionCapability(process.env, true)
    if (!capability.available) {
      if (lastCapabilityWarning !== capability.reason) {
        console.warn(`[sockdrive-convert] 暂未启用：${capability.reason}；60 秒后重新检查`)
        lastCapabilityWarning = capability.reason
      }
      if (!startupRetryTimer) {
        startupRetryTimer = setTimeout(() => {
          startupRetryTimer = undefined
          void startSockdriveConversionQueue().catch((error) => console.error('[sockdrive-convert] 队列启动重试失败：', error))
        }, 60_000)
        startupRetryTimer.unref?.()
      }
      return
    }
    await mkdir(sockdriveConversionConfig().tempDir, { recursive: true })
    await query(
      `UPDATE sockdrive_conversion_jobs
        SET status = 'queued', progress = LEAST(progress, 98), message = '服务器重启，任务自动重新排队'
        WHERE status IN (${INTERRUPTED.map(() => '?').join(', ')})`,
      INTERRUPTED,
    )
    started = true
    lastCapabilityWarning = ''
    clearTimeout(startupRetryTimer)
    startupRetryTimer = undefined
    console.log('[sockdrive-convert] DOS / Windows ZIP → Sockdrive 后台队列已启用')
    schedulePump()
    void sweepStaleSources().catch((error) => console.warn('[sockdrive-convert] staging 清扫失败：', error.message))
    sweepTimer = setInterval(() => {
      void sweepStaleSources().catch((error) => console.warn('[sockdrive-convert] staging 清扫失败：', error.message))
    }, 6 * 60 * 60 * 1000)
    sweepTimer.unref?.()
  } catch (error) {
    if (!startupRetryTimer) {
      startupRetryTimer = setTimeout(() => {
        startupRetryTimer = undefined
        void startSockdriveConversionQueue().catch((retryError) => console.error('[sockdrive-convert] 队列启动重试失败：', retryError))
      }, 30_000)
      startupRetryTimer.unref?.()
    }
    throw error
  } finally {
    starting = false
  }
}
