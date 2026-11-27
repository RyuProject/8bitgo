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
const concurrency = Number(valueArg('--concurrency') || 4)
const batchBlocks = Number(valueArg('--batch-blocks') || 8)

function fail(message) {
  console.error(`✖ ${message}`)
  process.exit(1)
}

function validKey(key) {
  return typeof key === 'string' && key.startsWith('roms/') && !key.startsWith('roms/covers/') &&
    key.length <= 1024 && !key.includes('..') && !key.includes('\\') && !key.endsWith('/') && !/[\x00-\x1f\x7f]/.test(key)
}

if (!apiValue) fail('请设置 ROM_INTEGRITY_API，指向当前 ROM Worker 的根地址')
if (!token) fail('请通过 ROM_INTEGRITY_TOKEN 环境变量提供 Worker ADMIN_TOKEN 或当前有效的 8bg1 短期 Worker 凭据')
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
if (!Number.isSafeInteger(concurrency) || concurrency < 1 || concurrency > 16) fail('--concurrency 必须是 1..16 的整数')
if (!Number.isSafeInteger(batchBlocks) || batchBlocks < 1 || batchBlocks > 8) fail('--batch-blocks 必须是 1..8 的整数')
// 每个 R2 Range 最多 2 MiB；限制并发中的缓冲区总量，避免迁移脚本把 Worker 内存顶满。
if (apply && concurrency * batchBlocks > 32) fail('--apply 的并发与批次大小超过安全内存预算（最多 32 个分块）')

const api = new URL(apiValue.endsWith('/') ? apiValue : `${apiValue}/`)
const authHeaders = { Authorization: `Bearer ${token}` }
const timeout = () => AbortSignal.timeout(60_000)
const retryableStatus = new Set([408, 425, 429, 500, 502, 503, 504])
const wait = (ms) => new Promise(resolve => setTimeout(resolve, ms))

async function request(url, init = {}) {
  let lastError
  for (let attempt = 0; attempt < 3; attempt++) {
    let response
    try {
      response = await fetch(url, { ...init, signal: init.signal || timeout() })
    } catch (error) {
      if (init.signal?.aborted || attempt === 2) {
        const method = init.method || 'GET'
        const target = new URL(url)
        throw new Error(`${method} ${target.origin}${target.pathname} 失败：${error instanceof Error ? error.message : String(error)}`)
      }
      lastError = error
      await wait(300 * (attempt + 1))
      continue
    }

    const method = String(init.method || 'GET').toUpperCase()
    if (response.ok && method !== 'HEAD' && response.status !== 204) {
      // Worker 写入可能已成功，但代理偶尔把空响应 / HTML 错误页伪装成 HTTP 200。
      // 回填的 POST 是条件写入且幂等，重试会核对已有清单，不会覆盖不同摘要。
      const body = await response.clone().json().catch(() => null)
      if ((!body || typeof body !== 'object') && attempt < 2) {
        await response.body?.cancel().catch(() => {})
        await wait(300 * (attempt + 1))
        continue
      }
      if (!body || typeof body !== 'object') return response
    }
    if (!retryableStatus.has(response.status) || attempt === 2) return response
    if (response.status === 503) {
      const body = await response.clone().json().catch(() => null)
      // 缺少清单是兼容读取 / 首次回填的正常状态，不能按瞬态 503 重试。
      if (body?.code === 'integrity_manifest_missing') return response
    }
    await response.body?.cancel().catch(() => {})
    await wait(300 * (attempt + 1))
  }
  throw lastError || new Error('Worker 请求失败')
}

async function readJson(response, label) {
  const raw = await response.text().catch(() => '')
  let body = null
  try { body = JSON.parse(raw) } catch {}
  if (!body || typeof body !== 'object') {
    const shape = !raw.trim() ? '空响应' : raw.trimStart().startsWith('<') ? 'HTML' : '非 JSON 正文'
    const contentType = response.headers.get('Content-Type') || '无 Content-Type'
    throw new Error(`${label} 返回的 JSON 无效（HTTP ${response.status}，${contentType}，${shape}，${raw.length} 字节）`)
  }
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

async function readManifestState(key) {
  const response = await request(integrityUrl(key), { headers: authHeaders, cache: 'no-store' })
  const body = await response.json().catch(() => null)
  if (!body || typeof body !== 'object') {
    throw new Error(`读取 ${key} 清单失败（HTTP ${response.status}，响应不是 JSON）`)
  }
  if (response.status === 200) {
    return { present: true, etag: String(body.etag || body.manifest?.etag || ''), size: Number(body.size) }
  }
  if (response.status === 404 || (response.status === 503 && body.code === 'integrity_manifest_missing')) {
    return { present: false, etag: String(body.etag || ''), size: Number(body.size) }
  }
  throw new Error(`读取 ${key} 清单失败（HTTP ${response.status}）：${JSON.stringify(body).slice(0, 180)}`)
}

async function readObjectMetadata(key, listedSize) {
  let last
  for (let attempt = 0; attempt < 3; attempt++) {
    const head = await request(objectUrl(key), {
      method: 'HEAD',
      headers: { ...authHeaders, 'Cache-Control': 'no-cache' },
      cache: 'no-store',
    })
    if (!head.ok) throw new Error(`HEAD ${key} 失败（HTTP ${head.status}）`)
    const etag = head.headers.get('ETag') || ''
    const rawSize = head.headers.get('Content-Length')
    const size = Number(rawSize)
    if (etag && Number.isSafeInteger(size) && size > 0) return { etag, size }
    // 有些边缘 HEAD 会保留 ETag 却省略 Content-Length；/list 的 size 来自 R2。
    // 后续 hash-blocks 会用当前 R2 的 ETag + size 双重核对，故可安全补这个缺头。
    if (etag && rawSize === null) {
      let fallbackSize = listedSize
      if (!Number.isSafeInteger(fallbackSize) || fallbackSize <= 0) {
        try { fallbackSize = await listObjectSize(key) } catch {}
      }
      if (Number.isSafeInteger(fallbackSize) && fallbackSize > 0) {
        await head.body?.cancel().catch(() => {})
        return { etag, size: fallbackSize }
      }
    }
    last = { status: head.status, hasEtag: Boolean(etag), rawSize }
    await head.body?.cancel().catch(() => {})
    if (attempt < 2) await wait(250 * (attempt + 1))
  }
  const sizeState = last?.rawSize === null ? '缺失' : Number.isSafeInteger(Number(last?.rawSize)) ? '无效' : '非数字'
  throw new Error(`${key} HEAD 连续三次缺少有效元数据（HTTP ${last?.status}，ETag ${last?.hasEtag ? '存在' : '缺失'}，长度 ${sizeState}）`)
}

async function listObjectSize(key) {
  let cursor = ''
  do {
    const url = new URL('list', api)
    url.searchParams.set('prefix', key)
    if (cursor) url.searchParams.set('cursor', cursor)
    const response = await request(url, { headers: authHeaders, cache: 'no-store' })
    if (!response.ok) throw new Error(`重新读取 ${key} 长度失败（HTTP ${response.status}）`)
    const page = await readJson(response, `重新读取 ${key} 长度`)
    if (!Array.isArray(page.objects)) throw new Error(`重新读取 ${key} 长度时列表格式无效`)
    const object = page.objects.find((item) => item.key === key && (!item.bucket || item.bucket === 'ROMS'))
    if (object) {
      const size = Number(object.size)
      if (Number.isSafeInteger(size) && size > 0) return size
      throw new Error(`${key} 的 R2 列表长度无效`)
    }
    cursor = page.truncated ? String(page.cursor || '') : ''
    if (page.truncated && !cursor) throw new Error('R2 列表被截断但没有返回 cursor')
  } while (cursor)
  throw new Error(`R2 列表中找不到 ${key}`)
}

async function backfillOne(item, index, total) {
  const { key, listedSize } = item
  let manifestState = await readManifestState(key)
  if (manifestState.present) {
    console.log(`[${index}/${total}] 已有清单：${key}`)
    return 'present'
  }
  let metadata = manifestState.etag && Number.isSafeInteger(manifestState.size) && manifestState.size > 0
    ? { etag: manifestState.etag, size: manifestState.size }
    : await readObjectMetadata(key, listedSize)
  let { etag, size } = metadata
  let totalBlocks = Math.ceil(size / (2 * 1024 * 1024))
  if (totalBlocks > 2_560) throw new Error(`${key} 有 ${totalBlocks} 个分块，超过 Worker 支持的 2560 块`)

  if (!apply) {
    console.log(`[${index}/${total}] 待回填：${key} · ${(size / 1024 / 1024).toFixed(1)} MiB · ${totalBlocks} 块`)
    return 'missing'
  }

  const blocks = []
  let startIndex = 0
  let versionRefreshes = 0
  while (startIndex < totalBlocks) {
    const response = await request(integrityUrl(key), {
      method: 'POST',
      headers: { ...authHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'hash-blocks', key, etag, size, startIndex, batchBlocks }),
    })
    const result = await readJson(response, `为 ${key} 生成摘要`)
    if (response.status === 412 && result.code === 'integrity_object_changed' && versionRefreshes < 2) {
      // 对象可能在回填期间被覆盖。重新从 Worker 的 R2 head 获取 ETag / size，整份摘要从第 0 块重算。
      manifestState = await readManifestState(key)
      if (manifestState.present) return 'present'
      metadata = manifestState.etag && Number.isSafeInteger(manifestState.size) && manifestState.size > 0
        ? { etag: manifestState.etag, size: manifestState.size }
        : await readObjectMetadata(key, await listObjectSize(key))
      etag = metadata.etag
      size = metadata.size
      totalBlocks = Math.ceil(size / (2 * 1024 * 1024))
      if (totalBlocks > 2_560) throw new Error(`${key} 有 ${totalBlocks} 个分块，超过 Worker 支持的 2560 块`)
      blocks.length = 0
      startIndex = 0
      versionRefreshes++
      continue
    }
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
  if (keyFilter) return [{ key: keyFilter, listedSize: null }]
  const keys = new Map()
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
      if (validKey(object.key)) {
        const size = Number(object.size)
        keys.set(object.key, {
          key: object.key,
          listedSize: Number.isSafeInteger(size) && size > 0 ? size : null,
        })
      }
    }
    cursor = page.truncated ? String(page.cursor || '') : ''
    if (page.truncated && !cursor) throw new Error('Worker 列表被截断但没有返回 cursor')
  } while (cursor)
  return [...keys.values()].sort((a, b) => a.key.localeCompare(b.key))
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
  let nextIndex = 0
  let firstError = null
  await Promise.all(Array.from({ length: Math.min(concurrency, selected.length) }, async () => {
    while (!firstError) {
      const index = nextIndex++
      if (index >= selected.length) return
      try {
        const result = await backfillOne(selected[index], index + 1, selected.length)
        if (result === 'present') present++
        else if (result === 'missing') missing++
        else published++
      } catch (error) {
        firstError ??= error
      }
    }
  }))
  if (firstError) throw firstError
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
