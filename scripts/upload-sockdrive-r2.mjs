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
 *     --encoding br
 *
 * `sockify -b` 用 br，`sockify -g` 用 gzip；没压缩就写 identity（默认）。
 */
import { execFileSync } from 'node:child_process'
import { createReadStream, existsSync, readFileSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { brotliDecompressSync, createBrotliDecompress, createGunzip, gunzipSync } from 'node:zlib'

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
const dryRun = process.argv.includes('--dry-run')

if (!sourceDir || !prefix || (!dryRun && !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(bucket))) {
  console.error(
    '用法：npm run sockdrive:upload -- --src <含 sockdrive.metaj 的目录> --bucket <R2桶名> ' +
      '--prefix sockdrives/<游戏>-v1 [--encoding br|gzip|identity] [--dry-run]',
  )
  process.exit(2)
}
if (!['br', 'gzip', 'identity'].includes(encoding)) throw new Error('--encoding 只能是 br、gzip 或 identity')
// R2 key 最终会原样进入公开 URL 与 DOSBox-X 配置；路径穿越、查询串和空白都不是可发布的目录名。
if (
  /[^\x21-\x7e]|[?#"'%&|<>^()\\]/.test(prefix) ||
  prefix.split('/').some((part) => !part || part === '.' || part === '..')
) {
  throw new Error('--prefix 必须是安全的 ASCII 对象目录，不能含空白、DOS 保留字符、反斜杠或 . / .. 段')
}
if (!/(?:^|[-_/])v\d+(?:[-_.]|$)|[a-f0-9]{8,}$/i.test(prefix)) {
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
if (!Number.isSafeInteger(metadata.size * 1024) || Math.ceil(metadata.size * 1024 / metadata.ahead_read) !== rangeCount) {
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
const need = (name) => {
  const file = join(sourceDir, name)
  if (!existsSync(file) || !statSync(file).isFile() || statSync(file).size <= 0) throw new Error(`Sockdrive 缺少有效文件：${name}`)
  files.push(name)
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
for (const name of files) {
  if (name.endsWith('.metaj')) continue
  const expected = name === 'preload.raw' ? small.size * metadata.ahead_read : metadata.ahead_read
  const actual = await decodedFileSize(name, expected)
  if (actual !== expected) throw new Error(`${name} 解码后是 ${actual} 字节，应为 ${expected} 字节`)
}

const totalBytes = files.reduce((sum, name) => sum + statSync(join(sourceDir, name)).size, 0)
console.log(`✔ Sockdrive 结构完整：${rangeCount} 个范围，发布 ${files.length} 个文件 / ${(totalBytes / 1024 / 1024).toFixed(1)} MiB`)
if (dryRun) process.exit(0)

let existing
try {
  existing = await fetch(`${publicRoot}/sockdrive.metaj`, { method: 'GET', cache: 'no-store' })
} catch (error) {
  throw new Error(`无法确认公开目录是否已存在，已停止发布：${error instanceof Error ? error.message : String(error)}`)
}
if (existing.ok) throw new Error(`公开目录已经存在：${publicRoot}。请换新版本路径，不能覆盖流式磁盘`)
if (existing.status !== 404) throw new Error(`公开目录预检返回 HTTP ${existing.status}，已停止发布以免覆盖未知内容`)

const wrangler = join(root, 'node_modules/.bin/wrangler')
// 元数据最后上传，它相当于“这块磁盘已经完整可见”的提交点。
const ordered = [...files.filter((name) => name !== 'sockdrive.metaj'), 'sockdrive.metaj']
for (const name of ordered) {
  const json = name.endsWith('.metaj')
  // sockify 会连元数据一起压缩；漏掉这个响应头时，浏览器拿到的是压缩字节而不是 JSON。
  const encoded = encoding !== 'identity'
  const args = [
    'r2', 'object', 'put', `${bucket}/${prefix}/${name}`,
    '--file', join(sourceDir, name),
    '--content-type', json ? 'application/json; charset=utf-8' : 'application/octet-stream',
    '--cache-control', 'public, max-age=31536000, immutable',
    '--remote', '--force',
  ]
  if (encoded) args.push('--content-encoding', encoding)
  console.log(`上传 ${prefix}/${name}…`)
  execFileSync(wrangler, args, { cwd: root, stdio: 'inherit' })
}

const verifyMeta = await fetch(`${publicRoot}/sockdrive.metaj?verify=${Date.now()}`, {
  headers: { Origin: 'https://8bitgo.com' },
  cache: 'no-store',
})
if (!verifyMeta.ok) throw new Error(`公开 sockdrive.metaj 读取失败：HTTP ${verifyMeta.status}`)
const publicMetadata = await verifyMeta.json()
if (publicMetadata.range_count !== rangeCount) throw new Error('公开 sockdrive.metaj 与本地产物不一致')
const cors = verifyMeta.headers.get('access-control-allow-origin')
if (cors !== '*' && cors !== 'https://8bitgo.com') throw new Error('公开 Sockdrive 没有允许 8bitgo.com 的 CORS')

if (preloadProfile) {
  const verifyPreload = await fetch(`${publicRoot}/${preloadProfileName}?verify=${Date.now()}`, {
    headers: { Origin: 'https://8bitgo.com' },
    cache: 'no-store',
  })
  if (!verifyPreload.ok) throw new Error(`公开 ${preloadProfileName} 读取失败：HTTP ${verifyPreload.status}`)
  const publicPreload = await verifyPreload.json()
  if (JSON.stringify(publicPreload) !== JSON.stringify(preloadProfile)) {
    throw new Error(`公开 ${preloadProfileName} 与本地产物不一致`)
  }
}

const sample = ordered.find((name) => name.endsWith('.raw'))
if (sample) {
  const response = await fetch(`${publicRoot}/${sample}?verify=${Date.now()}`, {
    method: 'HEAD',
    headers: { Origin: 'https://8bitgo.com' },
    cache: 'no-store',
  })
  if (!response.ok) throw new Error(`公开分块 ${sample} 读取失败：HTTP ${response.status}`)
  const actualEncoding = response.headers.get('content-encoding') || 'identity'
  if (actualEncoding !== encoding) throw new Error(`${sample} 的 Content-Encoding 是 ${actualEncoding}，应为 ${encoding}`)
}

console.log(`✔ Sockdrive 已发布并通过公开读取校验：${publicRoot}`)
