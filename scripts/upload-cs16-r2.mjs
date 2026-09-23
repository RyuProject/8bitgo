#!/usr/bin/env node

/**
 * 上传顺序必须是「全部内容寻址分片 → catalog.json」。清单若先可见，首批玩家会拿到
 * 尚未上传完的分片 404；Cloudflare 又可能缓存 404，让上传完成后仍持续启动失败。
 */
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const packDir = join(root, 'public/web/cs16/packs/zstd-v1')
const arg = (name) => {
  const at = process.argv.indexOf(`--${name}`)
  return at >= 0 ? process.argv[at + 1] : ''
}
const bucket = arg('bucket')
const prefix = (arg('prefix') || 'web/cs16/zstd-v1').replace(/^\/+|\/+$/g, '')
const dryRun = process.argv.includes('--dry-run')
if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(bucket || '')) {
  console.error('用法：npm run cs16:upload -- --bucket <R2桶名> [--prefix web/cs16/zstd-v1]')
  process.exit(2)
}

const catalogFile = join(packDir, 'catalog.json')
if (!existsSync(catalogFile)) throw new Error('缺少 zstd-v1/catalog.json；先运行 npm run cs16:zstd')
const catalog = JSON.parse(readFileSync(catalogFile, 'utf8'))
if (catalog.format !== '8bitgo.cs16.zstd-chunks.v1' || !catalog.packs) throw new Error('catalog.json 格式错误')
const chunks = new Map()
for (const pack of Object.values(catalog.packs)) {
  for (const chunk of pack.chunks) chunks.set(chunk.path, chunk)
}

for (const [path, chunk] of chunks) {
  const file = join(packDir, path)
  if (!existsSync(file) || statSync(file).size !== chunk.compressedBytes) throw new Error(`${path} 长度与清单不符`)
  const digest = createHash('sha256').update(readFileSync(file)).digest('hex')
  if (digest !== chunk.compressedSha256 || path !== `chunks/${digest}.zst`) throw new Error(`${path} SHA-256 与清单不符`)
}

const wrangler = join(root, 'node_modules/.bin/wrangler')
const upload = (relative, contentType, cacheControl) => {
  if (dryRun) {
    console.log(`校验通过 ${prefix}/${relative} (${contentType}; ${cacheControl})`)
    return
  }
  console.log(`上传 ${prefix}/${relative}…`)
  execFileSync(wrangler, [
    'r2', 'object', 'put', `${bucket}/${prefix}/${relative}`,
    '--file', join(packDir, relative),
    '--content-type', contentType,
    '--cache-control', cacheControl,
    '--remote', '--force',
  ], { cwd: root, stdio: 'inherit' })
}

for (const path of [...chunks.keys()].sort()) {
  upload(path, 'application/zstd', 'public, max-age=31536000, immutable')
}
// 不设置 Content-Encoding: zstd；浏览器把这些对象当应用数据，由加载器逐片解压。
upload('catalog.json', 'application/json; charset=utf-8', 'no-cache, max-age=0, must-revalidate')
console.log(`${dryRun ? '本地校验完成' : '上传完成'}。公开清单应为：https://assets.8bitgo.com/${prefix}/catalog.json`)
