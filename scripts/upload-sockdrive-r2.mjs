#!/usr/bin/env node

/**
 * 校验并发布 js-dos `sockify` 生成的**单块磁盘目录**。
 *
 * 转换工具会在输出目录下再建一层 drive-prefix 目录；这里的 --src 要指向直接包含
 * sockdrive.metaj 的那一层。清单最后上传，避免玩家先看到元数据、随后才发现某个扇区还没到 R2。
 *
 * 用法：
 *   npm run sockdrive:upload -- \
 *     --src /tmp/sockdrive/game-v1 \
 *     --bucket 8bitgo \
 *     --prefix sockdrives/game-v1 \
 *     --encoding br \
 *     --concurrency 6
 *
 * `sockify -b` 用 br，`sockify -g` 用 gzip；没压缩就写 identity（默认）。
 */
import { spawn } from 'node:child_process'
import { createReadStream, existsSync, readFileSync, statSync } from 'node:fs'
import { open } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { brotliDecompressSync, createBrotliDecompress, createGunzip, gunzipSync } from 'node:zlib'
import { isVersionedSockdriveDirectory } from '../shared/sockdrive-url.js'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const arg = (name) => {
  const at = process.argv.indexOf(`--${name}`)
  return at >= 0 ? process.argv[at + 1] : ''
}
const sourceDir = arg('src')
const bucket = arg('bucket')
const prefix = arg('prefix').replace(/^\/+|\/+$/g, '')
const encoding = (arg('encoding') || 'identity').toLowerCase()
const publicBase = (arg('public-base') || 'https://assets.8bitgo.com').replace(/\/+$/, '')
const workerUrl = (arg('worker-url') || '').replace(/\/+$/, '')
const workerToken = process.env.SOCKDRIVE_WORKER_TOKEN || ''
const dryRun = process.argv.includes('--dry-run')
const positiveInt = (raw, fallback, max) => {
  const value = Number(raw)
  return Number.isSafeInteger(value) && value > 0 && value <= max ? value : fallback
}
// 小分块逐个串行上传时，RTT 会远大于真实传输时间；六路能吃满 HTTP/2 / R2，仍把内存峰值控制在可预期范围。
const uploadConcurrency = positiveInt(arg('concurrency') || process.env.SOCKDRIVE_UPLOAD_CONCURRENCY, 6, 16)
// zlib 的异步流工作落在线程池；默认四路与 Node 默认线程池匹配，再高只会争磁盘和 CPU。
const validationConcurrency = Math.min(4, uploadConcurrency)
const PUBLIC_REQUEST_TIMEOUT_MS = 30_000
const WORKER_REQUEST_TIMEOUT_MS = 120_000

if (!sourceDir || !prefix || (!dryRun && !workerUrl && !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(bucket))) {
  console.error(
    '用法：npm run sockdrive:upload -- --src <含 sockdrive.metaj 的目录> --bucket <R2桶名> ' +
      '--prefix sockdrives/<游戏>-v1 [--encoding br|gzip|identity] [--concurrency 1..16] ' +
      '[--worker-url <写入Worker>] [--dry-run]',
  )
  process.exit(2)
}
if (!dryRun && workerUrl && !workerToken) throw new Error('--worker-url 模式需要环境变量 SOCKDRIVE_WORKER_TOKEN')
if (!['br', 'gzip', 'identity'].includes(encoding)) throw new Error('--encoding 只能是 br、gzip 或 identity')
// R2 key 最终会原样进入公开 URL 与 DOSBox-X 配置；路径穿越、查询串和空白都不是可发布的目录名。
if (
  /[^\x21-\x7e]|[?#"'%&|<>^()\\]/.test(prefix) ||
  prefix.split('/').some((part) => !part || part === '.' || part === '..')
) {
  throw new Error('--prefix 必须是安全的 ASCII 对象目录，不能含空白、DOS 保留字符、反斜杠或 . / .. 段')
}
if (!isVersionedSockdriveDirectory(prefix)) {
  throw new Error(`路径「${prefix}」必须带版本号或内容哈希；Sockdrive 分块禁止原地覆盖`)
}

let publicRoot
try {
  const base = new URL(`${publicBase}/`)
  if (!/^https?:$/.test(base.protocol) || base.username || base.password || base.search || base.hash) throw new Error()
  publicRoot = new URL(prefix, base).toString().replace(/\/+$/, '')
} catch {
  throw new Error('--public-base 必须是没有账号口令、查询参数或锚点的 HTTP(S) 地址')
}
/*
  js-dos 8.4.1 把清洗后的 URL 截成 200 字符作为 OPFS 目录名。版本号若落在截断线后，
  v1 / v2 会共用缓存并混入两代磁盘块，所以发布阶段也必须和运行时使用同一条上限。
*/
if (publicRoot.replace(/^https?:\/\//i, '').length > 200) {
  throw new Error('公开 Sockdrive URL 过长；js-dos 的本地块缓存会截断并可能混入旧版本')
}

const decodeStored = (name) => {
  const input = readFileSync(join(sourceDir, name))
  try {
    if (encoding === 'br') return brotliDecompressSync(input)
    if (encoding === 'gzip') return gunzipSync(input)
    return input
  } catch (error) {
    throw new Error(`${name} 与 --encoding ${encoding} 不一致：${error instanceof Error ? error.message : String(error)}`)
  }
}

/** 大文件只流式计数，不把整个 preload.raw 解压进内存；合法的 2GB 磁盘也可能有很大的预取包。 */
const decodedFileSize = (name, expected) => {
  const file = join(sourceDir, name)
  if (encoding === 'identity') return Promise.resolve(statSync(file).size)
  return new Promise((resolve, reject) => {
    const input = createReadStream(file)
    const decoder = encoding === 'br' ? createBrotliDecompress() : createGunzip()
    let bytes = 0
    let settled = false
    const fail = (error) => {
      if (settled) return
      settled = true
      input.destroy()
      decoder.destroy()
      reject(new Error(`${name} 与 --encoding ${encoding} 不一致：${error instanceof Error ? error.message : String(error)}`))
    }
    input.on('error', fail)
    decoder.on('error', fail)
    decoder.on('data', (chunk) => {
      bytes += chunk.length
      if (bytes > expected) fail(new Error(`解码后超过应有的 ${expected} 字节`))
    })
    decoder.on('end', () => {
      if (settled) return
      settled = true
      resolve(bytes)
    })
    input.pipe(decoder)
  })
}

const metadataFile = join(sourceDir, 'sockdrive.metaj')
if (!existsSync(metadataFile)) throw new Error(`${sourceDir} 不直接包含 sockdrive.metaj；请指向 sockify 生成的磁盘子目录`)
let metadata
try {
  metadata = JSON.parse(decodeStored('sockdrive.metaj').toString('utf8'))
} catch (error) {
  throw new Error(`sockdrive.metaj 不是有效 JSON：${error instanceof Error ? error.message : String(error)}`)
}
for (const key of ['size', 'range_count', 'ahead_read', 'sector_size']) {
  if (!Number.isSafeInteger(metadata[key]) || metadata[key] <= 0) throw new Error(`sockdrive.metaj 的 ${key} 无效`)
}
const rangeCount = metadata.range_count
if (!Number.isSafeInteger(metadata.size * 1024) || metadata.size * 1024 > 2 * 1024 ** 3 ||
    Math.ceil(metadata.size * 1024 / metadata.ahead_read) !== rangeCount) {
  throw new Error('sockdrive.metaj 的磁盘大小与分块数量不一致')
}
if (metadata.ahead_read % metadata.sector_size !== 0) {
  throw new Error('sockdrive.metaj 的分块大小不是扇区大小的整数倍')
}
const rangeArray = (key) => {
  const values = metadata[key] ?? []
  if (!Array.isArray(values)) throw new Error(`sockdrive.metaj 的 ${key} 必须是数组`)
  const unique = new Set()
  for (const value of values) {
    if (!Number.isSafeInteger(value) || value < 0 || value >= rangeCount || unique.has(value)) {
      throw new Error(`sockdrive.metaj 的 ${key} 含越界或重复分块：${String(value)}`)
    }
    unique.add(value)
  }
  return unique
}
const dropped = rangeArray('dropped_ranges')
const small = rangeArray('small_ranges')
const preload = rangeArray('preload_ranges')
for (const value of dropped) {
  if (small.has(value)) throw new Error(`sockdrive.metaj 的分块 ${value} 同时出现在 dropped_ranges 与 small_ranges`)
  if (preload.has(value)) throw new Error(`sockdrive.metaj 的预取分块 ${value} 已被标记为空范围`)
}

/*
  js-dos 的首次运行优化不是改写 sockdrive.metaj，而是在同目录放一份可选的
  preload_ranges.metaj。运行时会优先读取它覆盖转换期的默认清单；发布器若漏传，后台依然显示
  sockdrivePreload=default，却只能边玩边等网络，故这里把它当成一等发布产物校验。
*/
const preloadProfileName = 'preload_ranges.metaj'
const hasPreloadProfile = existsSync(join(sourceDir, preloadProfileName))
let preloadProfile = null
if (hasPreloadProfile) {
  try {
    const parsed = JSON.parse(decodeStored(preloadProfileName).toString('utf8'))
    if (!Array.isArray(parsed)) throw new Error('根节点必须是数组')
    const unique = new Set()
    for (const value of parsed) {
      if (!Number.isSafeInteger(value) || value < 0 || value >= rangeCount || dropped.has(value) || unique.has(value)) {
        throw new Error(`含越界、空范围或重复分块：${String(value)}`)
      }
      unique.add(value)
    }
    preloadProfile = [...unique]
  } catch (error) {
    throw new Error(`${preloadProfileName} 无效：${error instanceof Error ? error.message : String(error)}`)
  }
}

const files = []
const fileSizes = new Map()
const need = (name) => {
  const file = join(sourceDir, name)
  const info = existsSync(file) ? statSync(file) : null
  if (!info?.isFile() || info.size <= 0) throw new Error(`Sockdrive 缺少有效文件：${name}`)
  files.push(name)
  fileSizes.set(name, info.size)
}
if (small.size) need('preload.raw')
for (let range = 0; range < rangeCount; range++) {
  if (!dropped.has(range) && !small.has(range)) need(`${range}.raw`)
}
if (hasPreloadProfile) need(preloadProfileName)
need('sockdrive.metaj')

/*
  Content-Encoding 写错时，浏览器会把压缩字节直接交给 Sockdrive，表现是随机读盘错误而不是清楚的
  HTTP 失败。上传前把每个文件完整解码并核对长度，宁可本地多读一遍，也不能发布一块坏磁盘。
*/
const mapConcurrent = async (values, concurrency, task) => {
  let cursor = 0
  let failure = null
  const workers = Array.from({ length: Math.min(concurrency, values.length) }, async () => {
    while (!failure) {
      const index = cursor++
      if (index >= values.length) return
      try { await task(values[index], index) } catch (error) { failure ??= error }
    }
  })
  await Promise.all(workers)
  if (failure) throw failure
}

const rawFiles = files.filter((name) => !name.endsWith('.metaj'))
const validationStartedAt = Date.now()
await mapConcurrent(rawFiles, validationConcurrency, async (name) => {
  const range = Number.parseInt(name, 10)
  const expected = name === 'preload.raw'
    ? small.size * metadata.ahead_read
    // 最后一块允许短于 ahead_read；把它强行按整块验会让非整除尺寸的合法磁盘永远无法发布。
    : Math.min(metadata.ahead_read, metadata.size * 1024 - range * metadata.ahead_read)
  const actual = await decodedFileSize(name, expected)
  if (actual !== expected) throw new Error(`${name} 解码后是 ${actual} 字节，应为 ${expected} 字节`)
})

const totalBytes = files.reduce((sum, name) => sum + fileSizes.get(name), 0)
const validationSeconds = Math.max(0.001, (Date.now() - validationStartedAt) / 1000)
console.log(
  `✔ Sockdrive 结构完整：${rangeCount} 个范围，发布 ${files.length} 个文件 / ` +
  `${(totalBytes / 1024 / 1024).toFixed(1)} MiB；${validationConcurrency} 路解码校验 ${validationSeconds.toFixed(1)} 秒`,
)
if (dryRun) process.exit(0)

let existing
try {
  existing = await fetch(`${publicRoot}/sockdrive.metaj`, {
    method: 'GET', cache: 'no-store', signal: AbortSignal.timeout(PUBLIC_REQUEST_TIMEOUT_MS),
  })
} catch (error) {
  throw new Error(`无法确认公开目录是否已存在，已停止发布：${error instanceof Error ? error.message : String(error)}`)
}
if (existing.ok) throw new Error(`公开目录已经存在：${publicRoot}。请换新版本路径，不能覆盖流式磁盘`)
if (existing.status !== 404) throw new Error(`公开目录预检返回 HTTP ${existing.status}，已停止发布以免覆盖未知内容`)

const wrangler = join(root, 'node_modules/.bin/wrangler')
// 元数据最后上传，它相当于“这块磁盘已经完整可见”的提交点。
const ordered = [...files.filter((name) => name !== 'sockdrive.metaj'), 'sockdrive.metaj']
const PART_BYTES = 8 * 1024 * 1024
const SINGLE_PUT_BYTES = 24 * 1024 * 1024
const encodedKey = (key) => key.split('/').map(encodeURIComponent).join('/')
const workerRequest = (key, init = {}, query = '') => fetch(`${workerUrl}/${encodedKey(key)}${query}`, {
  ...init,
  signal: init.signal || AbortSignal.timeout(WORKER_REQUEST_TIMEOUT_MS),
  headers: { Authorization: `Bearer ${workerToken}`, ...init.headers },
  ...(init.body instanceof ReadableStream ? { duplex: 'half' } : {}),
})
const jsonResponse = async (response, label) => {
  const text = await response.text()
  let value
  try { value = JSON.parse(text) } catch {
    const error = new Error(`${label}返回了非 JSON 响应（HTTP ${response.status}）`)
    error.retryable = response.status === 408 || response.status === 429 || response.status >= 500
    throw error
  }
  if (!response.ok) {
    const error = new Error(`${label}失败：${value?.error || `HTTP ${response.status}`}`)
    error.retryable = response.status === 408 || response.status === 429 || response.status >= 500
    throw error
  }
  return value
}
const retry = async (task, label) => {
  let last
  for (let attempt = 0; attempt < 4; attempt++) {
    try { return await task() } catch (error) { last = error }
    if (last?.retryable === false) break
    if (attempt < 3) await new Promise((resolveWait) => setTimeout(resolveWait, 500 * 2 ** attempt))
  }
  throw new Error(`${label}失败：${last instanceof Error ? last.message : String(last)}`)
}
const requestJson = (task, label) => retry(async () => jsonResponse(await task(), label), label)
const uploadWithWorker = async (name, contentType) => {
  const file = join(sourceDir, name)
  const size = fileSizes.get(name)
  const key = `${prefix}/${name}`
  const commonHeaders = {
    'Content-Type': contentType,
    ...(encoding !== 'identity' ? { 'Content-Encoding': encoding } : {}),
  }
  if (size <= SINGLE_PUT_BYTES) {
    const result = await requestJson(
      () => workerRequest(key, {
        method: 'PUT',
        headers: { ...commonHeaders, 'Content-Length': String(size) },
        body: createReadStream(file),
        duplex: 'half',
      }),
      `上传 ${name}`,
    )
    if (result.key !== key || Number(result.size) !== size || !result.etag) throw new Error(`Worker 没有完整确认 ${name}`)
    return
  }

  const session = await requestJson(
    () => workerRequest(key, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contentType,
        contentEncoding: encoding,
        size,
        name,
      }),
    }, '?uploads'),
    `创建 ${name} 分片会话`,
  )
  if (!session.uploadId || !session.marker) throw new Error(`Worker 没有返回 ${name} 的有效分片会话`)
  const partCount = Math.ceil(size / PART_BYTES)
  const parts = Array.from({ length: partCount })
  const handle = await open(file, 'r')
  try {
    await mapConcurrent(Array.from({ length: partCount }, (_, index) => index), Math.min(3, uploadConcurrency), async (index) => {
      const partNumber = index + 1
      const position = index * PART_BYTES
      const length = Math.min(PART_BYTES, size - position)
      const bytes = Buffer.allocUnsafe(length)
      let offset = 0
      while (offset < length) {
        const { bytesRead } = await handle.read(bytes, offset, length - offset, position + offset)
        if (!bytesRead) throw new Error(`${name} 第 ${partNumber} 片读取不完整`)
        offset += bytesRead
      }
      const part = await requestJson(
        () => workerRequest(key, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/octet-stream', 'Content-Length': String(length) },
          body: bytes,
        }, `?uploadId=${encodeURIComponent(session.uploadId)}&partNumber=${partNumber}`),
        `上传 ${name} 第 ${partNumber} 片`,
      )
      if (!part.etag) throw new Error(`Worker 没有确认 ${name} 第 ${partNumber} 片`)
      parts[index] = { partNumber, etag: part.etag }
    })
    const result = await requestJson(
      () => workerRequest(key, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ parts, marker: session.marker }),
      }, `?uploadId=${encodeURIComponent(session.uploadId)}`),
      `合并 ${name} 分片`,
    )
    if (result.key !== key || Number(result.size) !== size || !result.etag) throw new Error(`Worker 没有完整确认 ${name}`)
  } catch (error) {
    await workerRequest(
      key,
      { method: 'DELETE' },
      `?uploadId=${encodeURIComponent(session.uploadId)}&marker=${encodeURIComponent(session.marker)}`,
    ).catch(() => {})
    throw error
  } finally {
    await handle.close()
  }
}

const uploadWithWrangler = (name, contentType) => new Promise((resolveUpload, rejectUpload) => {
  const encoded = encoding !== 'identity'
  const args = [
    'r2', 'object', 'put', `${bucket}/${prefix}/${name}`,
    '--file', join(sourceDir, name),
    '--content-type', contentType,
    '--cache-control', 'public, max-age=31536000, immutable',
    '--remote', '--force',
  ]
  if (encoded) args.push('--content-encoding', encoding)
  const child = spawn(wrangler, args, { cwd: root, stdio: 'inherit' })
  child.once('error', rejectUpload)
  child.once('exit', (code, signal) => {
    if (code === 0) resolveUpload()
    else rejectUpload(new Error(`wrangler 上传 ${name} 失败（${signal || `exit ${code}`}）`))
  })
})

const uploadOne = async (name) => {
  const json = name.endsWith('.metaj')
  // sockify 会连元数据一起压缩；漏掉这个响应头时，浏览器拿到的是压缩字节而不是 JSON。
  const contentType = json ? 'application/json; charset=utf-8' : 'application/octet-stream'
  if (workerUrl) {
    await uploadWithWorker(name, contentType)
  } else {
    await uploadWithWrangler(name, contentType)
  }
}

/*
  只并发数据文件；sockdrive.metaj 仍是唯一提交点，必须等全部上传成功后单独发布。
  日志按“完成数”而不是“启动序号”推进，后台进度不会因并发乱序倒退或提前显示 96%。
*/
const dataFiles = ordered.filter((name) => name !== 'sockdrive.metaj')
let completedUploads = 0
let completedBytes = 0
const uploadStartedAt = Date.now()
const logUploaded = (name) => {
  completedUploads++
  completedBytes += fileSizes.get(name)
  const seconds = Math.max(0.001, (Date.now() - uploadStartedAt) / 1000)
  const mibPerSecond = completedBytes / 1024 / 1024 / seconds
  // 前半段保留旧格式给任务进度解析，后半段用真实字节量避免压缩率差异把吞吐判断带偏。
  console.log(
    `已上传 ${prefix}/${name}（${completedUploads}/${ordered.length}） ` +
    `[${completedBytes}/${totalBytes} 字节，${mibPerSecond.toFixed(1)} MiB/s]`,
  )
}
await mapConcurrent(dataFiles, uploadConcurrency, async (name) => {
  await uploadOne(name)
  logUploaded(name)
})
await uploadOne('sockdrive.metaj')
logUploaded('sockdrive.metaj')

const verifyMeta = await fetch(`${publicRoot}/sockdrive.metaj?verify=${Date.now()}`, {
  // Cloudflare 可能按内容协商解码并移除响应头；显式请求发布格式才能可靠验收 R2 元数据。
  headers: {
    Origin: 'https://8bitgo.com',
    'Accept-Encoding': encoding === 'identity' ? 'identity' : encoding,
  },
  cache: 'no-store',
  signal: AbortSignal.timeout(PUBLIC_REQUEST_TIMEOUT_MS),
})
if (!verifyMeta.ok) throw new Error(`公开 sockdrive.metaj 读取失败：HTTP ${verifyMeta.status}`)
const publicMetadata = await verifyMeta.json()
if (publicMetadata.range_count !== rangeCount) throw new Error('公开 sockdrive.metaj 与本地产物不一致')
const cors = verifyMeta.headers.get('access-control-allow-origin')
if (cors !== '*' && cors !== 'https://8bitgo.com') throw new Error('公开 Sockdrive 没有允许 8bitgo.com 的 CORS')

/*
  带随机查询串、no-store 的验收只证明 R2 原对象正确，抓不到真实玩家会命中的边缘缓存问题。
  2026-10-18 线上曾出现 Cache API 首次 MISS 正常、随后 HIT 丢 Content-Encoding 的事故：
  浏览器拿到 Brotli 原字节后把它当 JSON，所有新会话都无法挂盘。这里再按玩家的规范 URL 连读
  两次；第一读负责触发可能存在的缓存写入，第二读负责验收 HIT，避免发布器再次宣布假成功。
*/
for (let pass = 1; pass <= 2; pass++) {
  if (pass > 1) await new Promise((resolveWait) => setTimeout(resolveWait, 250))
  const canonical = await fetch(`${publicRoot}/sockdrive.metaj`, {
    headers: {
      Origin: 'https://8bitgo.com',
      'Accept-Encoding': encoding === 'identity' ? 'identity' : encoding,
    },
    signal: AbortSignal.timeout(PUBLIC_REQUEST_TIMEOUT_MS),
  })
  if (!canonical.ok) throw new Error(`玩家路径第 ${pass} 次读取 sockdrive.metaj 失败：HTTP ${canonical.status}`)
  let canonicalMetadata
  try {
    canonicalMetadata = await canonical.json()
  } catch {
    throw new Error(`玩家路径第 ${pass} 次读取得到的不是 JSON；边缘缓存可能丢失了 Content-Encoding`)
  }
  if (canonicalMetadata.range_count !== rangeCount) {
    throw new Error(`玩家路径第 ${pass} 次读取的 sockdrive.metaj 与本地产物不一致`)
  }
}

if (preloadProfile) {
  const verifyPreload = await fetch(`${publicRoot}/${preloadProfileName}?verify=${Date.now()}`, {
    headers: {
      Origin: 'https://8bitgo.com',
      'Accept-Encoding': encoding === 'identity' ? 'identity' : encoding,
    },
    cache: 'no-store',
    signal: AbortSignal.timeout(PUBLIC_REQUEST_TIMEOUT_MS),
  })
  if (!verifyPreload.ok) throw new Error(`公开 ${preloadProfileName} 读取失败：HTTP ${verifyPreload.status}`)
  const publicPreload = await verifyPreload.json()
  if (JSON.stringify(publicPreload) !== JSON.stringify(preloadProfile)) {
    throw new Error(`公开 ${preloadProfileName} 与本地产物不一致`)
  }
}

// 优先验一个独立块并读取正文：HEAD 看不出“Content-Encoding 头在 GET/HIT 时丢失”这类事故。
// preload.raw 可能聚合大量小块；只有整张盘都没有独立块时才退回对它做 HEAD。
let sampleRange
for (let range = 0; sampleRange === undefined && range < rangeCount; range++) {
  if (!dropped.has(range) && !small.has(range)) sampleRange = range
}
const sample = sampleRange === undefined ? (small.size ? 'preload.raw' : '') : `${sampleRange}.raw`
if (sample) {
  const readsBody = sampleRange !== undefined
  const response = await fetch(`${publicRoot}/${sample}?verify=${Date.now()}`, {
    method: readsBody ? 'GET' : 'HEAD',
    headers: {
      Origin: 'https://8bitgo.com',
      'Accept-Encoding': encoding === 'identity' ? 'identity' : encoding,
    },
    cache: 'no-store',
    signal: AbortSignal.timeout(PUBLIC_REQUEST_TIMEOUT_MS),
  })
  if (!response.ok) throw new Error(`公开分块 ${sample} 读取失败：HTTP ${response.status}`)
  const actualEncoding = response.headers.get('content-encoding') || 'identity'
  if (actualEncoding !== encoding) throw new Error(`${sample} 的 Content-Encoding 是 ${actualEncoding}，应为 ${encoding}`)
  if (readsBody) {
    const expected = Math.min(metadata.ahead_read, metadata.size * 1024 - sampleRange * metadata.ahead_read)
    const actual = (await response.arrayBuffer()).byteLength
    if (actual !== expected) throw new Error(`公开分块 ${sample} 解码后是 ${actual} 字节，应为 ${expected} 字节`)
  }
}

console.log(`✔ Sockdrive 已发布并通过公开读取校验：${publicRoot}`)
