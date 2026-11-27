#!/usr/bin/env node
/**
 * 给旧 R2 ROM / BIOS 对象补齐真实 SHA-256 分块清单。
 * 默认只盘点；只有显式传 --apply 才写 sidecar。摘要由 Worker 从 ETag 锁定的 R2 Range 生成，
 * 不用管理机下载整盘后自证，避免把 CDN / 本地传输里的坏字节误登记成可信基线。
 */
import process from 'node:process'

const args = new Set(process.argv.slice(2).filter((arg) => !arg.includes('=')))
const valueArg = (name) => process.argv.slice(2).find((arg) => arg.startsWith(`${name}=`))?.slice(name.length + 1)
const apply = args.has('--apply')
const requireComplete = args.has('--require-complete')
const apiValue = String(valueArg('--api') || process.env.ROM_INTEGRITY_API || '').trim()
const token = String(process.env.ROM_INTEGRITY_TOKEN || '').trim()
const keyFilter = String(valueArg('--key') || '').trim()
const prefixFilter = String(valueArg('--prefix') || '').trim()
const limit = Number(valueArg('--limit') || Number.POSITIVE_INFINITY)

function fail(message) {
  console.error(`✖ ${message}`)
  process.exit(1)
}

function validKey(key) {
  return typeof key === 'string' && key.startsWith('roms/') && !key.startsWith('roms/covers/') &&
    key.length <= 1024 && !key.includes('..') && !key.includes('\\') && !key.endsWith('/') && !/[\x00-\x1f\x7f]/.test(key)
}

if (!apiValue) fail('请设置 ROM_INTEGRITY_API，指向当前 ROM Worker 的根地址')
if (!token) fail('请通过 ROM_INTEGRITY_TOKEN 环境变量提供 Worker ADMIN_TOKEN')
if (Boolean(keyFilter) === Boolean(prefixFilter)) fail('请且只请指定 --key=roms/... 或 --prefix=roms/...')
if (requireComplete && apply) fail('--require-complete 是只读覆盖率门禁，不能与 --apply 同用')
if (requireComplete && (keyFilter || prefixFilter !== 'roms/' || limit !== Number.POSITIVE_INFINITY)) {
  fail('--require-complete 必须完整盘点 --prefix=roms/，不能用 --key 或 --limit')
}
if (keyFilter && !validKey(keyFilter)) fail('--key 必须是 roms/ 下的合法 ROM / BIOS key（不含 covers）')
if (prefixFilter && (!prefixFilter.startsWith('roms/') || prefixFilter.startsWith('roms/covers/') ||
    prefixFilter.includes('..') || prefixFilter.includes('\\') || /[\x00-\x1f\x7f]/.test(prefixFilter))) {
  fail('--prefix 必须位于 roms/ 下，且不能指向 covers')
}
if (!(limit > 0) || (!Number.isSafeInteger(limit) && limit !== Number.POSITIVE_INFINITY)) fail('--limit 必须是正整数')

const api = new URL(apiValue.endsWith('/') ? apiValue : `${apiValue}/`)
const authHeaders = { Authorization: `Bearer ${token}` }
const timeout = () => AbortSignal.timeout(60_000)

async function request(url, init = {}) {
  const response = await fetch(url, { ...init, signal: init.signal || timeout() })
  return response
}

async function readJson(response, label) {
  const body = await response.json().catch(() => null)
  if (!body || typeof body !== 'object') throw new Error(`${label} 返回的 JSON 无效（HTTP ${response.status}）`)
  return body
}

function objectUrl(key) {
  return new URL(key.split('/').map(encodeURIComponent).join('/'), api)
}

function integrityUrl(key) {
  const url = new URL('integrity', api)
  url.searchParams.set('key', key)
  return url
}

async function hasManifest(key) {
  const response = await request(integrityUrl(key), { headers: authHeaders, cache: 'no-store' })
  if (response.status === 200) return true
  if (response.status === 404) return false
  const body = await response.json().catch(() => null)
  if (response.status === 503 && body?.code === 'integrity_manifest_missing') return false
  throw new Error(`读取 ${key} 清单失败（HTTP ${response.status}）：${JSON.stringify(body).slice(0, 180)}`)
}

async function backfillOne(key, index, total) {
  if (await hasManifest(key)) {
    console.log(`[${index}/${total}] 已有清单：${key}`)
    return 'present'
  }
  const head = await request(objectUrl(key), { method: 'HEAD', headers: authHeaders, cache: 'no-store' })
  if (!head.ok) throw new Error(`HEAD ${key} 失败（HTTP ${head.status}）`)
  const etag = head.headers.get('ETag') || ''
  const size = Number(head.headers.get('Content-Length'))
  if (!etag || !Number.isSafeInteger(size) || size <= 0) throw new Error(`${key} 缺少有效 ETag / 文件长度`)
  const totalBlocks = Math.ceil(size / (2 * 1024 * 1024))
  if (totalBlocks > 2_560) throw new Error(`${key} 有 ${totalBlocks} 个分块，超过 Worker 支持的 2560 块`)

  if (!apply) {
    console.log(`[${index}/${total}] 待回填：${key} · ${(size / 1024 / 1024).toFixed(1)} MiB · ${totalBlocks} 块`)
    return 'missing'
  }

  const blocks = []
  let startIndex = 0
  while (startIndex < totalBlocks) {
    const response = await request(integrityUrl(key), {
      method: 'POST',
      headers: { ...authHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'hash-blocks', key, etag, size, startIndex, batchBlocks: 8 }),
    })
    const result = await readJson(response, `为 ${key} 生成摘要`)
    if (!response.ok || result.ok !== true || result.etag !== etag || result.size !== size ||
        result.startIndex !== startIndex || result.blockBytes !== 2 * 1024 * 1024 ||
        !Array.isArray(result.blocks) || !result.blocks.length || result.nextIndex !== startIndex + result.blocks.length ||
        result.nextIndex > totalBlocks || result.totalBlocks !== totalBlocks ||
        result.blocks.some((hash) => typeof hash !== 'string' || !/^[a-f0-9]{64}$/.test(hash))) {
      throw new Error(`${key} 的 R2 分块摘要响应不完整或版本不一致（HTTP ${response.status}）`)
    }
    blocks.push(...result.blocks)
    startIndex = result.nextIndex
    console.log(`  ${key}: 已从 R2 核对 ${startIndex}/${totalBlocks} 块`)
  }

  const manifest = { v: 1, alg: 'sha256', key, size, blockBytes: 2 * 1024 * 1024, blocks }
  const published = await request(integrityUrl(key), {
    method: 'POST',
    headers: { ...authHeaders, 'Content-Type': 'application/json' },
    body: JSON.stringify({ key, etag, size, manifest }),
  })
  const confirmation = await readJson(published, `发布 ${key} 清单`)
  if (!published.ok || confirmation.ok !== true || confirmation.key !== key ||
      confirmation.etag !== etag || confirmation.size !== size) {
    throw new Error(`${key} 清单未能绑定到当前对象版本（HTTP ${published.status}）`)
  }
  console.log(`[${index}/${total}] 已绑定 R2 SHA-256 清单：${key} · ${totalBlocks} 块`)
  return 'published'
}

async function listKeys() {
  if (keyFilter) return [keyFilter]
  const keys = []
  let cursor = ''
  do {
    const url = new URL('list', api)
    url.searchParams.set('prefix', prefixFilter)
    if (cursor) url.searchParams.set('cursor', cursor)
    const response = await request(url, { headers: authHeaders, cache: 'no-store' })
    if (!response.ok) throw new Error(`列出 ${prefixFilter} 失败（HTTP ${response.status}）`)
    const page = await readJson(response, `列出 ${prefixFilter}`)
    if (!Array.isArray(page.objects)) throw new Error('Worker 列表响应缺少 objects 数组')
    for (const object of page.objects) {
      if (object.bucket && object.bucket !== 'ROMS') continue
      if (validKey(object.key)) keys.push(object.key)
    }
    cursor = page.truncated ? String(page.cursor || '') : ''
    if (page.truncated && !cursor) throw new Error('Worker 列表被截断但没有返回 cursor')
  } while (cursor)
  return [...new Set(keys)].sort()
}

try {
  const pingResponse = await request(new URL('ping', api), { cache: 'no-store' })
  if (!pingResponse.ok) throw new Error(`Worker ping 失败（HTTP ${pingResponse.status}）`)
  const ping = await readJson(pingResponse, 'Worker ping')
  if (!apply && !ping.features?.integrityManifest) throw new Error('当前 Worker 不支持 ROM SHA-256 清单')
  if (apply && (!ping.writable || !ping.features?.integrityBackfill || !ping.features?.integrityManifest)) {
    throw new Error('当前 Worker 未宣告 integrityBackfill 或没有写入权限；请先部署支持版本')
  }

  const keys = await listKeys()
  if (!keys.length) throw new Error('没有找到符合条件的 ROM / BIOS 对象')
  const selected = keys.slice(0, limit)
  let present = 0
  let missing = 0
  let published = 0
  console.log(`${apply ? '回填' : '只读盘点'} ${selected.length} 个对象${keys.length > selected.length ? `（共发现 ${keys.length} 个，受 --limit 限制）` : ''}`)
  for (let index = 0; index < selected.length; index++) {
    const result = await backfillOne(selected[index], index + 1, selected.length)
    if (result === 'present') present++
    else if (result === 'missing') missing++
    else published++
  }
  console.log(`完成：已有 ${present}，缺少 ${missing}，本次补齐 ${published}`)
  if (!apply && missing) console.log('预览未修改 R2；确认范围后再加 --apply。')
  if (requireComplete) {
    if (missing) {
      console.error(`✖ ROM / BIOS 完整性清单仍缺 ${missing} 项；暂时不能开启全局严格校验。`)
      process.exitCode = 2
    } else {
      console.log('✔ roms/ 下所有 ROM / BIOS 都有 ETag 绑定清单；可以评估开启 REQUIRE_ALL_ROM_INTEGRITY=true。')
    }
  }
} catch (error) {
  console.error(`✖ ${error instanceof Error ? error.message : String(error)}`)
  process.exitCode = 1
}
