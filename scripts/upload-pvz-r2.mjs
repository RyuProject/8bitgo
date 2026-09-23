#!/usr/bin/env node

/*
  上传 PvZ 的内容寻址 reanim 流式包。清单只在代码部署后生效；包名带 SHA-256，重复执行安全。

  默认从 .env.production 读取 Worker 地址、从 server/.env 读取 ADMIN_TOKEN；不会打印口令。
  真上传必须显式加 --yes，避免把本地商业资源误发布到公开桶。
*/
import { createHash } from 'node:crypto'
import { createReadStream, existsSync, readFileSync, statSync } from 'node:fs'
import { resolve } from 'node:path'

const repo = resolve(import.meta.dirname, '..')
const dryRun = process.argv.includes('--dry-run')
const probeOnly = process.argv.includes('--probe')
const confirmed = process.argv.includes('--yes')
const arg = (name) => {
  const at = process.argv.indexOf(`--${name}`)
  return at >= 0 ? process.argv[at + 1] : ''
}
function readEnv(file) {
  const out = {}
  if (!existsSync(file)) return out
  for (const raw of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const line = raw.trim()
    if (!line || line.startsWith('#') || !line.includes('=')) continue
    const at = line.indexOf('=')
    out[line.slice(0, at).trim()] = line.slice(at + 1).trim().replace(/^(['"])(.*)\1$/, '$2')
  }
  return out
}

const catalog = JSON.parse(readFileSync(resolve(repo, 'public/web/PvZ/pvz-pack.json'), 'utf8'))
const file = resolve(repo, catalog.localFile || '')
if (catalog.format !== '8bitgo.pvz.gzip-pack.v1' || !/^packs\/reanim-[0-9a-f]{16}\.pvzpack\.gz$/.test(catalog.r2 || '')) {
  throw new Error('pvz-pack.json 格式错误；先运行 npm run pvz:pack')
}
if (!existsSync(file) || statSync(file).size !== catalog.size) throw new Error(`本地包缺失或长度不符：${file}`)
const digest = createHash('sha256').update(readFileSync(file)).digest('hex')
if (digest !== catalog.sha256 || !catalog.r2.includes(digest.slice(0, 16))) throw new Error('本地包 SHA-256 与清单不符')
for (const locale of ['cn', 'en']) {
  const manifest = JSON.parse(readFileSync(resolve(repo, `public/web/PvZ/${locale}/pvz-manifest.json`), 'utf8'))
  const bundle = manifest.bundles?.[0]
  if (!bundle || bundle.r2 !== catalog.r2 || bundle.sha256 !== catalog.sha256 || bundle.size !== catalog.size) {
    throw new Error(`${locale} 清单与 pvz-pack.json 不一致`)
  }
}

const key = `PvZ/properties/${catalog.r2}`
console.log(`PvZ 包校验通过：${key}，${(catalog.size / 1048576).toFixed(1)} MB，${catalog.fileCount} 个文件`)
if (dryRun) process.exit(0)
if (!confirmed && !probeOnly) {
  console.error('这是对公开 R2 的写操作；确认后重跑并加 --yes')
  process.exit(2)
}

const production = readEnv(resolve(repo, '.env.production'))
const server = readEnv(resolve(repo, 'server/.env'))
const api = (arg('api') || production.VITE_ROM_API_URL || '').replace(/\/+$/, '')
const token = process.env.PVZ_R2_TOKEN || server.ADMIN_TOKEN || ''
if (!api.startsWith('https://') || !token) throw new Error('缺少有效 VITE_ROM_API_URL 或 ADMIN_TOKEN')
const headers = { Authorization: `Bearer ${token}` }

const ping = await fetch(`${api}/ping`, { cache: 'no-store' })
const pingBody = await ping.json().catch(() => null)
if (!ping.ok || pingBody?.service !== '8bitgo-roms' || !pingBody.writable) throw new Error('Worker 不可写或地址不属于本项目')
// list 是受保护接口，用它确认本机 ADMIN_TOKEN 与 Worker 的口令一致，避免传 50MB 后才收到 401。
const authProbe = await fetch(`${api}/list?prefix=${encodeURIComponent(key)}`, { headers, cache: 'no-store' })
if (!authProbe.ok) throw new Error(`Worker 鉴权失败：HTTP ${authProbe.status}`)
if (probeOnly) {
  console.log('Worker 地址与 ADMIN_TOKEN 鉴权通过；未执行上传')
  process.exit(0)
}

const existing = await fetch(`${api}/${key.split('/').map(encodeURIComponent).join('/')}`, { method: 'HEAD', cache: 'no-store' })
if (existing.ok && Number(existing.headers.get('content-length')) === catalog.size) {
  console.log('R2 已有同长度的内容寻址对象，跳过上传')
  process.exit(0)
}

console.log('开始上传 PvZ 流式包…')
const response = await fetch(`${api}/${key.split('/').map(encodeURIComponent).join('/')}`, {
  method: 'PUT',
  headers: {
    ...headers,
    'content-type': 'application/gzip',
    'content-length': String(catalog.size),
  },
  body: createReadStream(file),
  duplex: 'half',
})
const result = await response.json().catch(() => null)
if (!response.ok || result?.ok !== true || result.key !== key || result.size !== catalog.size) {
  throw new Error(`上传响应无效：HTTP ${response.status}`)
}
const verify = await fetch(`${api}/${key.split('/').map(encodeURIComponent).join('/')}`, { method: 'HEAD', cache: 'no-store' })
if (!verify.ok || Number(verify.headers.get('content-length')) !== catalog.size) throw new Error('上传后 HEAD 长度不符')
console.log('PvZ 流式包上传完成并通过 HEAD 验收')
