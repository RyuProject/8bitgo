#!/usr/bin/env node

/**
 * Windows / WSL 制作机的 Sockdrive 发布代理。
 *
 * 豆包等本地编码助手只能调用这一个入口：原始 ZIP 先下载到 Linux 工作盘并核验，随后复用
 * 站内的制盘、R2 发布和游戏绑定脚本。令牌只从环境变量读取，配置文件可以安全地交给助手。
 */
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createReadStream, createWriteStream, existsSync, statSync } from 'node:fs'
import { mkdir, readFile, rename } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const argv = process.argv.slice(2)
const arg = (name) => {
  const index = argv.indexOf(`--${name}`)
  return index < 0 ? '' : argv[index + 1]
}
const configPath = arg('config')
const prepareOnly = argv.includes('--prepare-only')
const uploadOnly = argv.includes('--upload-only')

const usage = () => {
  console.error('用法：npm run sockdrive:agent -- --config <job.json> [--prepare-only|--upload-only]')
  process.exit(2)
}

if (!configPath || (prepareOnly && uploadOnly)) usage()

const fail = (message) => { throw new Error(`Sockdrive 外部制作任务无效：${message}`) }
const isSafeEnvName = (value) => /^[A-Z][A-Z0-9_]{0,127}$/.test(value)
const isSha256 = (value) => /^[a-f0-9]{64}$/i.test(value)
const isVersion = (value) => /^v[1-9]\d*$/.test(value) || /^[a-f0-9]{8,64}$/i.test(value)
const isGameSlug = (value) => /^[a-z0-9][a-z0-9-]{0,79}$/.test(value)
const isExecutable = (value) => /^[^:<>"|?*\x00-\x1f]+\.exe$/i.test(value) && value.split('/').every((part) => part && part !== '.' && part !== '..')
const isLanguage = (value) => !value || /^[a-z]{2,3}(?:-[A-Za-z]{2,8})?$/.test(value)

let job
try { job = JSON.parse(await readFile(resolve(configPath), 'utf8')) } catch (error) {
  fail(`无法读取 JSON 配置：${error instanceof Error ? error.message : String(error)}`)
}
if (!job || job.schema !== 1 || typeof job !== 'object') fail('schema 必须为 1')

const source = job.source && typeof job.source === 'object' ? job.source : fail('缺少 source')
const game = job.game && typeof job.game === 'object' ? job.game : fail('缺少 game')
const publish = job.publish && typeof job.publish === 'object' ? job.publish : fail('缺少 publish')
const workDirRaw = String(job.workDir || '').trim()
const workDir = workDirRaw ? resolve(workDirRaw) : ''
const sourceUrl = String(source.url || '').trim()
const sourcePath = String(source.path || '').trim()
const sourceSize = Number(source.bytes)
const sourceSha256 = String(source.sha256 || '').trim().toLowerCase()
const sourceTokenEnv = String(source.tokenEnv || '').trim()
const sourceEtag = String(source.etag || '').trim()
const slug = String(game.slug || '').trim().toLowerCase()
const version = String(game.version || '').trim().toLowerCase()
const executable = String(game.executable || '').trim().replace(/\\/g, '/').replace(/^\/+|\/+$/g, '')
const lang = String(game.lang || '').trim()
const cli = resolve(String(job.cli || ''))
const encoding = String(publish.encoding || 'br').trim().toLowerCase()
const publicBase = String(publish.publicBase || 'https://assets.8bitgo.com').trim().replace(/\/+$/, '')
const apiBase = String(publish.apiBase || 'https://8bitgo.com').trim().replace(/\/+$/, '')
const workerUrl = String(publish.workerUrl || '').trim().replace(/\/+$/, '')
const compressionConcurrency = Number(publish.compressionConcurrency || 2)
const brotliQuality = Number(publish.brotliQuality || 9)
const uploadConcurrency = Number(publish.uploadConcurrency || 6)
const freeSpace = String(publish.freeSpace || '128M').trim().toUpperCase()

if ((sourceUrl ? 1 : 0) + (sourcePath ? 1 : 0) !== 1) fail('source 必须二选一提供 url 或 path')
if (sourceUrl) {
  let parsed
  try { parsed = new URL(sourceUrl) } catch { fail('source.url 必须是 HTTP(S) 地址') }
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) fail('source.url 必须是不带账号口令的 HTTP(S) 地址')
  if (!Number.isSafeInteger(sourceSize) || sourceSize < 32 * 1024) fail('下载源必须提供 source.bytes')
  if (!isSha256(sourceSha256)) fail('下载源必须提供 64 位 source.sha256')
}
if (sourceTokenEnv && !isSafeEnvName(sourceTokenEnv)) fail('source.tokenEnv 必须是大写环境变量名')
if (sourceEtag && /[\r\n]/.test(sourceEtag)) fail('source.etag 不能含换行')
if (!workDir || workDir === resolve('/')) fail('workDir 必须是专用工作目录')
if (!isGameSlug(slug) || !isVersion(version)) fail('game.slug 或 game.version 无效')
if (!isExecutable(executable)) fail('game.executable 必须是游戏盘内安全的 .exe 相对路径')
if (!isLanguage(lang)) fail('game.lang 无效')
if (!uploadOnly && (!existsSync(cli) || !statSync(cli).isFile())) fail(`找不到 Sockdrive CLI：${cli}`)
if (!['br', 'gzip', 'identity'].includes(encoding)) fail('publish.encoding 只能是 br、gzip 或 identity')
if (!/^https?:\/\//i.test(publicBase) || !/^https?:\/\//i.test(apiBase) || !/^https?:\/\//i.test(workerUrl)) fail('publish 的三个地址必须是 HTTP(S) 地址')
if (!Number.isSafeInteger(compressionConcurrency) || compressionConcurrency < 1 || compressionConcurrency > 8) fail('compressionConcurrency 必须是 1..8')
if (!Number.isSafeInteger(brotliQuality) || brotliQuality < 1 || brotliQuality > 11) fail('brotliQuality 必须是 1..11')
if (!Number.isSafeInteger(uploadConcurrency) || uploadConcurrency < 1 || uploadConcurrency > 16) fail('uploadConcurrency 必须是 1..16')
if (!/^[1-9]\d*(?:[KMG])$/i.test(freeSpace)) fail('freeSpace 必须是 128M 这类容量')

const prefix = `sockdrives/${slug}${lang ? `-${lang.toLowerCase()}` : ''}-${version}`
const jobRoot = join(workDir, `${slug}-${version}`)
const inputRoot = join(jobRoot, 'input')
const downloadedSource = join(inputRoot, 'source.zip')
const publishDir = join(jobRoot, 'work', `${slug}-${version}`, 'publish')

const run = (command, args, label, env = process.env) => new Promise((resolveRun, rejectRun) => {
  const child = spawn(command, args, { cwd: repoRoot, env, stdio: 'inherit' })
  child.once('error', (error) => rejectRun(new Error(`${label} 无法启动：${error.message}`)))
  child.once('exit', (code, signal) => {
    if (code === 0) resolveRun()
    else rejectRun(new Error(`${label}失败：${signal || `exit ${code}`}`))
  })
})

const digestFile = async (path) => {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) hash.update(chunk)
  return hash.digest('hex')
}

async function downloadSource() {
  await mkdir(inputRoot, { recursive: true })
  if (existsSync(downloadedSource)) {
    const info = statSync(downloadedSource)
    const digest = sourceSha256 ? await digestFile(downloadedSource) : ''
    if ((!sourceSize || info.size === sourceSize) && (!sourceSha256 || digest === sourceSha256)) {
      console.log(`✔ 已复用已校验的原始 ZIP：${downloadedSource}`)
      return downloadedSource
    }
    fail('已有 source.zip 与配置的大小或 SHA-256 不一致；请人工删除后再试')
  }

  const partial = `${downloadedSource}.part`
  let offset = existsSync(partial) ? statSync(partial).size : 0
  if (offset > sourceSize) fail('残留的 source.zip.part 超过配置大小；请人工删除后再试')
  const headers = { 'Cache-Control': 'no-store' }
  if (sourceTokenEnv) {
    const token = process.env[sourceTokenEnv]
    if (!token) fail(`缺少下载令牌环境变量 ${sourceTokenEnv}`)
    headers.Authorization = `Bearer ${token}`
  }
  if (sourceEtag) headers['If-Match'] = sourceEtag
  if (offset) headers.Range = `bytes=${offset}-`
  let response = await fetch(sourceUrl, { headers, signal: AbortSignal.timeout(10 * 60_000) })
  if (offset && response.status === 200) {
    // 服务器不支持 Range 时从头下载，绝不能把两份内容接在一起。
    offset = 0
    delete headers.Range
    response = await fetch(sourceUrl, { headers, signal: AbortSignal.timeout(10 * 60_000) })
  }
  if (!response.ok || !response.body) fail(`下载原始 ZIP 失败：HTTP ${response.status}`)
  if (offset && response.status !== 206) fail(`续传原始 ZIP 时服务端返回 HTTP ${response.status}`)
  if (offset && !new RegExp(`^bytes ${offset}-\\d+/${sourceSize}$`).test(response.headers.get('content-range') || '')) {
    fail('续传响应 Content-Range 与已有文件不一致')
  }
  const hash = createHash('sha256')
  if (offset) {
    for await (const chunk of createReadStream(partial)) hash.update(chunk)
  }
  let received = offset
  await pipeline(
    Readable.fromWeb(response.body),
    new Transform({
      transform(chunk, _encoding, callback) {
        received += chunk.length
        if (received > sourceSize) {
          callback(new Error('下载内容超过配置大小'))
          return
        }
        hash.update(chunk)
        callback(null, chunk)
      },
    }),
    createWriteStream(partial, { flags: offset ? 'a' : 'w', highWaterMark: 1024 * 1024 }),
  )
  if (received !== sourceSize) fail(`原始 ZIP 下载不完整：收到 ${received}/${sourceSize} 字节`)
  const digest = hash.digest('hex')
  if (digest !== sourceSha256) fail('原始 ZIP 的 SHA-256 与配置不一致')
  await rename(partial, downloadedSource)
  console.log(`✔ 已下载并校验原始 ZIP：${(received / 1024 / 1024).toFixed(1)} MiB`)
  return downloadedSource
}

const resolveSource = async () => {
  if (sourcePath) {
    const path = resolve(sourcePath)
    if (!existsSync(path) || !statSync(path).isFile()) fail(`source.path 不存在或不是文件：${path}`)
    if (sourceSha256 && await digestFile(path) !== sourceSha256) fail('本地原始 ZIP 的 SHA-256 与配置不一致')
    return path
  }
  return downloadSource()
}

if (!uploadOnly) {
  const input = await resolveSource()
  const metadata = join(publishDir, 'sockdrive.metaj')
  if (existsSync(metadata)) console.log(`✔ 已复用完成的流式盘：${publishDir}`)
  else {
    await mkdir(join(jobRoot, 'work'), { recursive: true })
    await run(process.execPath, [
      join(repoRoot, 'scripts/prepare-sockdrive.mjs'),
      '--source', input,
      '--slug', slug,
      '--version', version,
      '--exe', executable,
      '--work-dir', join(jobRoot, 'work'),
      '--cli', cli,
      '--encoding', encoding,
      '--free-space', freeSpace,
      '--public-base', publicBase,
      '--compression-concurrency', String(compressionConcurrency),
      '--brotli-quality', String(brotliQuality),
    ], '制作流式盘')
  }
}

if (prepareOnly) {
  console.log(`✔ 制作完成，待上传目录：${publishDir}`)
  process.exit(0)
}
if (!existsSync(join(publishDir, 'sockdrive.metaj'))) fail(`找不到可上传的流式盘：${publishDir}`)
if (!process.env.SOCKDRIVE_WORKER_TOKEN) fail('缺少 SOCKDRIVE_WORKER_TOKEN；它只应保存在 Windows 的本地环境变量')
if (!process.env.EIGHTBITGO_ADMIN_JWT) fail('缺少 EIGHTBITGO_ADMIN_JWT；它只应保存在 Windows 的本地环境变量')

await run(process.execPath, [
  join(repoRoot, 'scripts/upload-sockdrive-r2.mjs'),
  '--src', publishDir,
  '--prefix', prefix,
  '--encoding', encoding,
  '--public-base', publicBase,
  '--worker-url', workerUrl,
  '--concurrency', String(uploadConcurrency),
], '上传流式盘')

const bindArgs = [
  join(repoRoot, 'scripts/bind-sockdrive-game.mjs'),
  '--slug', slug,
  '--prefix', prefix,
  '--public-base', publicBase,
  '--api-base', apiBase,
]
if (lang) bindArgs.push('--lang', lang)
await run(process.execPath, bindArgs, '绑定游戏')
console.log(`✔ Windows 制作节点已完成：${slug} → ${prefix}`)
