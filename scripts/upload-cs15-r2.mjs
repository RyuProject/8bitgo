#!/usr/bin/env node

/**
 * 把 repack-cs15.py 产出的内容哈希包上传到 R2，最后才替换 index.json。
 * 清单最后上传很重要：否则边缘可能先看到新清单，却还取不到清单指向的大包。
 */
import { createHash } from 'node:crypto'
import { createReadStream, existsSync, readFileSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const packDir = join(root, 'public/web/cs15/packs')
const arg = (name) => {
  const at = process.argv.indexOf(`--${name}`)
  return at >= 0 ? process.argv[at + 1] : ''
}
const bucket = arg('bucket')
const prefix = (arg('prefix') || 'web/cs15/packs').replace(/^\/+|\/+$/g, '')
const publicBase = (arg('public-base') || 'https://assets.8bitgo.com').replace(/\/+$/, '')
const skipPublicCheck = process.argv.includes('--skip-public-check')
if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(bucket || '')) {
  console.error('用法：npm run cs15:upload -- --bucket <R2桶名> [--prefix web/cs15/packs]')
  process.exit(2)
}

const manifestPath = join(packDir, 'index.json')
if (!existsSync(manifestPath)) throw new Error('缺少 packs/index.json；先运行 npm run cs15:repack')
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
if (manifest.schema !== 2 || !manifest.profiles?.cs || !manifest.packs) throw new Error('packs/index.json 不是 CS15 v2 清单')

const digest = (file) => new Promise((resolve, reject) => {
  const hash = createHash('sha256')
  const stream = createReadStream(file)
  stream.on('data', (chunk) => hash.update(chunk))
  stream.on('error', reject)
  stream.on('end', () => resolve(hash.digest('hex')))
})
const wrangler = join(root, 'node_modules/.bin/wrangler')
const upload = (file, contentType, contentEncoding, cacheControl) => {
  const args = [
    'r2', 'object', 'put', `${bucket}/${prefix}/${file}`,
    '--file', join(packDir, file), '--content-type', contentType,
    '--cache-control', cacheControl, '--remote', '--force',
  ]
  if (contentEncoding) args.push('--content-encoding', contentEncoding)
  console.log(`上传 ${prefix}/${file}…`)
  execFileSync(wrangler, args, { cwd: root, stdio: 'inherit' })
}

// 先逐字节核对本地产物，避免把一次中断留下的半截文件发布成当前版本。
for (const item of Object.values(manifest.packs)) {
  const primary = join(packDir, item.file)
  if (!existsSync(primary) || statSync(primary).size !== item.encodedBytes || await digest(primary) !== item.sha256) {
    throw new Error(`${item.file} 与清单不符，请重新打包`)
  }
  if (item.fallback) {
    const fallback = join(packDir, item.fallback)
    if (!existsSync(fallback) || statSync(fallback).size !== item.fallbackBytes || await digest(fallback) !== item.fallbackSha256) {
      throw new Error(`${item.fallback} 与清单不符，请重新打包`)
    }
  }
}

for (const item of Object.values(manifest.packs)) {
  upload(item.file, 'application/zip', 'br', 'public, max-age=31536000, immutable')
  if (item.fallback) upload(item.fallback, 'application/gzip', '', 'public, max-age=31536000, immutable')
}
// 清单没有内容哈希文件名，必须允许客户端和边缘每次重新验证。
upload('index.json', 'application/json; charset=utf-8', '', 'no-cache, max-age=0, must-revalidate')
const publicRoot = `${publicBase}/${prefix}`
if (!skipPublicCheck) {
  console.log(`从公开域名复核 CORS、长度和 Content-Encoding…`)
  for (const item of Object.values(manifest.packs)) {
    const response = await fetch(`${publicRoot}/${item.file}?verify=${Date.now()}`, {
      method: 'HEAD', headers: { Origin: 'https://8bitgo.com' }, cache: 'no-store',
    })
    if (!response.ok) throw new Error(`${item.file} 公开读取失败：HTTP ${response.status}`)
    if (response.headers.get('content-encoding') !== 'br') throw new Error(`${item.file} 缺 Content-Encoding: br`)
    const length = Number(response.headers.get('content-length') || 0)
    if (length && length !== item.encodedBytes) throw new Error(`${item.file} 公开长度不符：${length}/${item.encodedBytes}`)
    const cors = response.headers.get('access-control-allow-origin')
    if (cors !== '*' && cors !== 'https://8bitgo.com') throw new Error(`${item.file} 没有允许 8bitgo.com 的 CORS`)
  }
  const publicIndex = await fetch(`${publicRoot}/index.json?verify=${Date.now()}`, { cache: 'no-store' })
  if (!publicIndex.ok || (await publicIndex.json())?.packs?.['base-cs']?.file !== manifest.packs['base-cs'].file) {
    throw new Error('公开 index.json 仍不是刚上传的版本（检查自定义域名与边缘缓存）')
  }
}
console.log(`完成。公开资源根：${publicRoot}`)
