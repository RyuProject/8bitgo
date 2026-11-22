#!/usr/bin/env node

/**
 * 把 R2 的历史 `<ROM>.8bg` 逐份解开并发布为同名明文对象。
 *
 * 新对象写到去掉 `.8bg` 的原 key，旧容器始终保留。因此任一步失败时播放器仍会回退到
 * 旧对象；再次运行会从 R2 对象长度、公网 Range 读取和本地状态账本继续，不会把未验证的文件当作完成。
 *
 * 用法（生产机）：
 *   node scripts/migrate-8bg-to-plain-r2.mjs --dry-run
 *   node scripts/migrate-8bg-to-plain-r2.mjs --apply \
 *     --state /var/lib/8bitgo-data/rom-plain-migration.jsonl
 *
 * 前提：可信机器具备 server/.env 中的 ROM_PACK_SECRET[_Vn]，并已配置 rclone 的 R2 remote。
 * 本脚本只处理 roms/ 下以 `.8bg` 结尾的对象，不删除、移动或重命名任何历史容器。
 */
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { appendFile, mkdir, open, readFile, rm, stat } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { ROM_PACK_HEADER_PREFIX_BYTES, parseRomPackHeader, romPackHeaderLength } from '../shared/rom-pack-format.js'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
try { process.loadEnvFile(path.join(root, 'server/.env')) } catch { /* 生产环境可由 systemd 注入。 */ }

const args = process.argv.slice(2)
const value = (name, fallback = '') => {
  const index = args.indexOf(`--${name}`)
  return index < 0 ? fallback : String(args[index + 1] || '')
}
const has = (name) => args.includes(`--${name}`)
const usage = () => {
  console.log(`用法：node scripts/migrate-8bg-to-plain-r2.mjs [选项]

默认是只读预览；真正写入必须显式传 --apply。

  --apply                 解密并上传明文 ROM
  --dry-run               列出待迁移对象（默认）
  --remote <名称>          rclone remote，默认 r2
  --bucket <名称>          R2 bucket，默认 8bitgo
  --prefix <路径>          仅扫描此路径，默认 roms
  --rclone-bin <路径>       rclone 可执行文件，默认 PATH 中的 rclone
  --state <文件>           续跑账本，默认 ~/.local/state/8bitgo/rom-plain-migration.jsonl
  --work-dir <目录>        每次只存一份密文和一份明文的临时目录
  --public-base <地址>     玩家读取明文的公开根地址，默认 https://rom.8bitgo.com
  --limit <数量>           只处理前 N 个，用于小批量验证
  --keep-work              成功后也保留临时文件（排查用）
  --help                   显示本说明`)
}
if (has('help')) { usage(); process.exit(0) }

const known = new Set(['--apply', '--dry-run', '--remote', '--bucket', '--prefix', '--rclone-bin', '--state', '--work-dir', '--public-base', '--limit', '--keep-work', '--help'])
for (const arg of args) {
  if (arg.startsWith('--') && !known.has(arg)) throw new Error(`不认识的参数：${arg}`)
}
const apply = has('apply')
if (has('dry-run') && apply) throw new Error('--apply 与 --dry-run 不能同时使用')

const remote = value('remote', 'r2').replace(/:$/, '')
const bucket = value('bucket', '8bitgo')
const prefix = value('prefix', 'roms').replace(/^\/+|\/+$/g, '')
const rcloneBin = value('rclone-bin', process.env.RCLONE_BIN || 'rclone')
const defaultStateDir = path.join(process.env.XDG_STATE_HOME || path.join(os.homedir(), '.local', 'state'), '8bitgo')
const stateFile = path.resolve(value('state', path.join(defaultStateDir, 'rom-plain-migration.jsonl')))
const workDir = path.resolve(value('work-dir', path.join(os.tmpdir(), '8bitgo-plain-rom-migration')))
const publicBase = String(value('public-base', 'https://rom.8bitgo.com')).replace(/\/+$/, '')
const keepWork = has('keep-work')
const rawLimit = value('limit')
const limit = rawLimit ? Number(rawLimit) : Infinity

if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(remote)) throw new Error('--remote 不是有效的 rclone remote 名称')
if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(bucket)) throw new Error('--bucket 不合法')
if (!prefix || prefix.split('/').some(part => !part || part === '.' || part === '..' || /[\\\0-\x1f]/.test(part))) {
  throw new Error('--prefix 必须是安全的对象路径')
}
if (!Number.isSafeInteger(limit) && limit !== Infinity || limit <= 0) throw new Error('--limit 必须是正整数')
let publicBaseUrl
try {
  publicBaseUrl = new URL(publicBase)
  if (!['http:', 'https:'].includes(publicBaseUrl.protocol) || publicBaseUrl.username || publicBaseUrl.password || publicBaseUrl.search || publicBaseUrl.hash) {
    throw new Error('地址必须是无认证、无查询串的 HTTP(S) 根地址')
  }
} catch (error) {
  throw new Error(`--public-base 不合法：${error instanceof Error ? error.message : String(error)}`)
}

const remotePath = (key = '') => `${remote}:${bucket}/${key}`
const underPrefix = (key) => key === prefix || key.startsWith(`${prefix}/`)
const safeKey = (key) => typeof key === 'string' && underPrefix(key) && !key.split('/').some(part => !part || part === '.' || part === '..' || /[\\\0-\x1f]/.test(part))

function run(command, commandArgs, { quiet = false } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, commandArgs, { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] })
    const stdout = []
    const stderr = []
    child.stdout.on('data', chunk => stdout.push(Buffer.from(chunk)))
    child.stderr.on('data', chunk => stderr.push(Buffer.from(chunk)))
    child.on('error', error => reject(error))
    child.on('close', code => {
      const out = Buffer.concat(stdout).toString('utf8')
      const err = Buffer.concat(stderr).toString('utf8')
      if (code === 0) return resolve({ stdout: out, stderr: err })
      const detail = err.trim() || out.trim() || `退出码 ${code}`
      const error = new Error(`${command} ${commandArgs[0] || ''} 失败：${detail}`)
      error.code = code
      if (!quiet) process.stderr.write(`${detail}\n`)
      reject(error)
    })
  })
}

async function listPackedObjects() {
  /*
   * R2 上约一千余对象时 `lsjson` 会逐项补齐 MIME 信息；旧版 rclone 连 lsf 的 `t`（修改时间）
   * 也会逐项补请求，预览看起来像卡住。只取 ListObjects 本身就提供的 size 和路径。ROM key
   * 不允许控制字符，路径放最后并用 TAB 分隔不会有歧义；发布约定也禁止原地换同 key 的 ROM。
   */
  const { stdout } = await run(rcloneBin, [
    'lsf', '--recursive', '--files-only', '--format', 'sp', '--separator', '\t', remotePath(prefix),
  ])
  return stdout.split(/\r?\n/).flatMap((line) => {
    if (!line) return []
    const [rawSize, objectPath, ...extra] = line.split('\t')
    if (extra.length || !/\.8bg$/i.test(objectPath || '')) return []
    return [{
      key: `${prefix}/${objectPath}`.replace(/\/+/g, '/'),
      size: Number(rawSize),
      modTime: '',
    }]
  }).filter(object => safeKey(object.key) && Number.isSafeInteger(object.size) && object.size > ROM_PACK_HEADER_PREFIX_BYTES)
    .sort((a, b) => a.key.localeCompare(b.key))
}

async function readState() {
  let raw = ''
  try { raw = await readFile(stateFile, 'utf8') } catch (error) {
    if (error?.code === 'ENOENT') return new Map()
    throw error
  }
  const latest = new Map()
  for (const [index, line] of raw.split(/\r?\n/).entries()) {
    if (!line.trim()) continue
    try {
      const record = JSON.parse(line)
      if (record?.status === 'published' && typeof record.sourceKey === 'string' && typeof record.targetKey === 'string') {
        latest.set(record.sourceKey, record)
      }
    } catch {
      throw new Error(`状态账本第 ${index + 1} 行不是有效 JSON：${stateFile}`)
    }
  }
  return latest
}

async function appendState(record) {
  await mkdir(path.dirname(stateFile), { recursive: true })
  await appendFile(stateFile, `${JSON.stringify(record)}\n`, { encoding: 'utf8', mode: 0o600 })
}

async function remoteObject(key) {
  try {
    const { stdout } = await run(rcloneBin, ['lsjson', '--stat', '--metadata', remotePath(key)], { quiet: true })
    const value = JSON.parse(stdout)
    return value && !value.IsDir && Number.isSafeInteger(Number(value.Size)) ? value : null
  } catch {
    return null
  }
}

function originalHashFromMetadata(metadata) {
  if (!metadata || typeof metadata !== 'object') return ''
  for (const [key, value] of Object.entries(metadata)) {
    const normalized = key.toLowerCase().replace(/[^a-z0-9]/g, '')
    if (normalized === '8bitgooriginalsha256' && /^[a-f0-9]{64}$/i.test(String(value))) return String(value).toLowerCase()
  }
  return ''
}

async function readPackHeader(file) {
  const handle = await open(file, 'r')
  try {
    const prefixBytes = Buffer.allocUnsafe(ROM_PACK_HEADER_PREFIX_BYTES)
    const first = await handle.read(prefixBytes, 0, prefixBytes.byteLength, 0)
    if (first.bytesRead !== prefixBytes.byteLength) throw new Error('8BG 文件头不完整')
    const length = romPackHeaderLength(prefixBytes)
    const headerBytes = Buffer.allocUnsafe(ROM_PACK_HEADER_PREFIX_BYTES + length)
    prefixBytes.copy(headerBytes)
    const rest = await handle.read(headerBytes, ROM_PACK_HEADER_PREFIX_BYTES, length, ROM_PACK_HEADER_PREFIX_BYTES)
    if (rest.bytesRead !== length) throw new Error('8BG 文件头不完整')
    return parseRomPackHeader(headerBytes).header
  } finally { await handle.close() }
}

async function sha256File(file) {
  const digest = createHash('sha256')
  for await (const chunk of createReadStream(file)) digest.update(chunk)
  return digest.digest('hex')
}

async function readFileRange(file, start, length) {
  const handle = await open(file, 'r')
  try {
    const bytes = Buffer.allocUnsafe(length)
    const read = await handle.read(bytes, 0, length, start)
    if (read.bytesRead !== length) throw new Error(`本地明文读取不完整：${read.bytesRead}/${length}`)
    return bytes
  } finally { await handle.close() }
}

function publicObjectUrl(key, nonce) {
  const url = new URL(`${publicBaseUrl.href.replace(/\/$/, '')}/${key.split('/').map(encodeURIComponent).join('/')}`)
  // 每次验收请求都绕过边缘的旧 404 / 旧对象，确认玩家此刻可读取刚上传的对象。
  url.searchParams.set('8bg-migration-check', nonce)
  return url
}

/**
 * 验收不是只看 R2 的 HEAD：播放器通过这个公开域名用 Range 拉 ROM。新上传的对象会抽取首尾
 * 各 64 KiB 与刚解出的明文逐字节比对；续跑时虽没有本地明文，也要重新确认该公开路径能返回
 * 正确的 206 和总长度。任何一项失败都会停止后续发布，遗留的 .8bg 仍可作为播放器回退来源。
 */
async function verifyPublicPlain(key, expectedSize, localPlain = '') {
  if (!Number.isSafeInteger(expectedSize) || expectedSize <= 0) throw new Error('公网验收的明文长度无效')
  const sampleSize = Math.min(expectedSize, 64 * 1024)
  const ranges = [{ start: 0, length: sampleSize }]
  if (expectedSize > sampleSize) ranges.push({ start: expectedSize - sampleSize, length: sampleSize })
  for (const [index, range] of ranges.entries()) {
    const end = range.start + range.length - 1
    const response = await fetch(publicObjectUrl(key, `${Date.now()}-${index}-${Math.random().toString(16).slice(2)}`), {
      headers: { Range: `bytes=${range.start}-${end}`, 'Cache-Control': 'no-cache' },
      cache: 'no-store',
      signal: AbortSignal.timeout(30_000),
    })
    const contentRange = response.headers.get('content-range') || ''
    const contentLength = Number(response.headers.get('content-length'))
    const contentEncoding = response.headers.get('content-encoding')
    const allowOrigin = response.headers.get('access-control-allow-origin') || ''
    if (response.status !== 206 || contentRange !== `bytes ${range.start}-${end}/${expectedSize}` ||
      contentLength !== range.length || (contentEncoding && contentEncoding !== 'identity') ||
      !['*', 'https://8bitgo.com', 'https://www.8bitgo.com'].includes(allowOrigin)) {
      throw new Error(`公网 ROM Range 验收失败：HTTP ${response.status}，Content-Range=${contentRange || '(无)'}，Content-Length=${contentLength || '(无)'}，CORS=${allowOrigin || '(无)'}`)
    }
    const body = Buffer.from(await response.arrayBuffer())
    if (body.byteLength !== range.length) throw new Error(`公网 ROM Range 正文长度不符：${body.byteLength}/${range.length}`)
    if (localPlain) {
      const local = await readFileRange(localPlain, range.start, range.length)
      if (!body.equals(local)) throw new Error('公网 ROM Range 内容与已校验明文不符')
    }
  }
}

async function runUnpack(input, output) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(root, 'scripts/unpack-rom.mjs'), input, output], {
      cwd: root,
      stdio: ['ignore', 'inherit', 'inherit'],
      env: process.env,
    })
    child.on('error', reject)
    child.on('close', code => code === 0 ? resolve() : reject(new Error(`解包器退出码 ${code}`)))
  })
}

function stateMatches(record, source, target) {
  return record && record.targetKey === target && record.sourceSize === source.size &&
    record.sourceModTime === source.modTime && Number.isSafeInteger(record.plainSize) &&
    /^[a-f0-9]{64}$/i.test(record.sha256 || '')
}

async function alreadyPublished(record, source, target) {
  if (!stateMatches(record, source, target)) return false
  const object = await remoteObject(target)
  if (object?.Size !== record.plainSize) return false
  // 账本只会在上传后 HEAD 长度通过、且明文 SHA-256 已和容器头比对后写入；若有其它
  // 维护工具留下摘要元数据，也必须相等，不能把另一份同长度文件误判成已完成。
  const metadataHash = originalHashFromMetadata(object.Metadata)
  if (metadataHash && metadataHash !== record.sha256) return false
  await verifyPublicPlain(target, record.plainSize)
  return true
}

async function migrateOne(source, state) {
  const target = source.key.slice(0, -4)
  if (!safeKey(target) || !target.startsWith('roms/')) throw new Error(`拒绝写入 ROM 根目录以外的对象：${target}`)
  const previous = state.get(source.key)
  if (await alreadyPublished(previous, source, target)) {
    console.log(`跳过（已验收） ${source.key}`)
    return 'skipped'
  }

  const job = path.join(workDir, createHash('sha256').update(source.key).digest('hex').slice(0, 24))
  const packed = path.join(job, 'source.8bg')
  const plain = path.join(job, 'plain.rom')
  await rm(job, { recursive: true, force: true })
  await mkdir(job, { recursive: true })
  let success = false
  try {
    console.log(`下载 ${source.key}`)
    await run(rcloneBin, ['copyto', remotePath(source.key), packed, '--no-traverse', '--retries', '5', '--low-level-retries', '10'])
    const packedInfo = await stat(packed)
    if (packedInfo.size !== source.size) throw new Error(`下载长度不符：${packedInfo.size}，应为 ${source.size}`)
    const header = await readPackHeader(packed)
    if (header.originalSize <= 0) throw new Error('8BG 文件头中的原始大小无效')

    console.log(`解包 ${source.key} -> ${target}`)
    await runUnpack(packed, plain)
    const plainInfo = await stat(plain)
    if (plainInfo.size !== header.originalSize) throw new Error(`明文长度不符：${plainInfo.size}，应为 ${header.originalSize}`)
    const sha256 = await sha256File(plain)
    if (header.originalSha256 && sha256 !== header.originalSha256.toLowerCase()) throw new Error('明文 SHA-256 与 8BG 文件头不符')

    console.log(`发布 ${target}`)
    await run(rcloneBin, [
      'copyto', plain, remotePath(target), '--ignore-times', '--no-traverse', '--retries', '5', '--low-level-retries', '10',
    ])
    const published = await remoteObject(target)
    if (!published || published.Size !== plainInfo.size) throw new Error('上传后 R2 对象不存在或长度不符')
    const metadataHash = originalHashFromMetadata(published.Metadata)
    if (metadataHash && metadataHash !== sha256) throw new Error('上传后 R2 对象的 SHA-256 元数据不符')
    await verifyPublicPlain(target, plainInfo.size, plain)
    const record = {
      status: 'published', at: new Date().toISOString(), sourceKey: source.key, sourceSize: source.size,
      sourceModTime: source.modTime, targetKey: target, plainSize: plainInfo.size, sha256,
    }
    await appendState(record)
    state.set(source.key, record)
    success = true
    console.log(`完成 ${source.key} -> ${target} (${(plainInfo.size / 1048576).toFixed(1)} MiB)`)
    return 'published'
  } finally {
    if (success && !keepWork) await rm(job, { recursive: true, force: true })
  }
}

console.log(`R2: ${remotePath(prefix)}；模式：${apply ? '写入明文对象' : '只读预览'}`)
const all = await listPackedObjects()
const sources = all.slice(0, limit)
console.log(`发现 ${all.length} 个 .8bg 容器${Number.isFinite(limit) ? `；本次最多处理 ${sources.length} 个` : ''}`)
if (!apply) {
  for (const source of sources.slice(0, 25)) console.log(`  ${source.key} (${(source.size / 1048576).toFixed(1)} MiB 密文)`)
  if (sources.length > 25) console.log(`  …另有 ${sources.length - 25} 个`)
  console.log('预览结束。确认后用 --apply 执行；旧 .8bg 对象会保留。')
  process.exit(0)
}

if (!process.env.ROM_PACK_SECRET && !process.env.ROM_PACK_SECRET_V1) {
  throw new Error('缺少 ROM_PACK_SECRET；请在持有生产 server/.env 的可信机器上运行')
}
await mkdir(workDir, { recursive: true })
const state = await readState()
let published = 0
let skipped = 0
for (const source of sources) {
  try {
    const result = await migrateOne(source, state)
    if (result === 'published') published++
    else skipped++
  } catch (error) {
    console.error(`失败：${source.key}\n${error instanceof Error ? error.stack || error.message : String(error)}`)
    console.error('已停止。旧 .8bg 未删除；修复后重新运行会从已验收对象继续。')
    process.exitCode = 1
    break
  }
}
console.log(`迁移结束：新发布 ${published}，已验收跳过 ${skipped}，计划 ${sources.length}`)
