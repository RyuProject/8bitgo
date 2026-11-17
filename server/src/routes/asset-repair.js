/**
 * POST /api/asset-repair  { build, files: [文件名] }
 *
 * 坏 chunk 自修复（public/assets/asset-repair-v6.js）发现「普通地址导入失败、带查询串地址校验正常」时调这里：
 * Cloudflare 边缘可能缓存了坏字节或 HTTP 错误响应，
 * 而这些文件一年 immutable，不清的话那个节点的所有访客都会一直拿到坏的。
 *
 * 这个接口不需要登录，所以：
 * - 只接受当前磁盘上**这一版构建清单里有**的文件名，且磁盘上的文件和清单的 SHA-256 一致才清
 *   （磁盘本身就坏了那是部署问题，清边缘没用，打一行错误日志）；
 * - 按 IP、全站、单个文件三道限流：清一个本来正常的文件，代价也只是下一批访客回源一次；
 * - 只清 Cloudflare。大陆入口 EdgeOne 没有清缓存通道，那边靠客户端的 import map 改走回源地址。
 * 响应先回 202，清缓存在后台做，不让访客等 Cloudflare API。
 */
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { Router } from 'express'
import { CACHE } from '../cache.js'
import { edgePurgeEnabled, purgeUrlsNow } from '../edge-purge.js'
import { clientKey, take } from '../rateLimit.js'

const BUILD_RE = /^[A-Za-z0-9_-]{4,32}$/
const FILE_RE = /^[A-Za-z0-9_.-]{1,120}\.(?:js|mjs|css|wasm)$/
const MAX_FILES = 8
const FILE_COOLDOWN_MS = 15 * 60 * 1000
const MANIFEST_CACHE = 8

export function parseRepairRequest(body) {
  const build = typeof body?.build === 'string' ? body.build : ''
  if (!BUILD_RE.test(build) || build.startsWith('legacy-')) return null
  const raw = Array.isArray(body?.files) ? body.files : []
  const files = [...new Set(raw.filter((f) => typeof f === 'string' && FILE_RE.test(f) && !f.startsWith('integrity-')))].slice(0, MAX_FILES)
  return files.length ? { build, files } : null
}

export function createAssetRepairRouter({
  clientDir,
  siteOrigin,
  purge = purgeUrlsNow,
  purgeEnabled = edgePurgeEnabled,
  now = () => Date.now(),
  log = console,
} = {}) {
  const router = Router()
  const manifests = new Map()
  const lastPurged = new Map()

  async function manifestFor(build) {
    if (manifests.has(build)) return manifests.get(build)
    let data = null
    try {
      data = JSON.parse(await readFile(join(clientDir, 'assets', `integrity-${build}.json`), 'utf8'))
      if (!data || (data.v !== 1 && data.v !== 2) || !data.files) data = null
    } catch {
      data = null
    }
    manifests.set(build, data)
    while (manifests.size > MANIFEST_CACHE) manifests.delete(manifests.keys().next().value)
    return data
  }

  async function diskMatches(name, expected) {
    try {
      const bytes = await readFile(join(clientDir, 'assets', name))
      return createHash('sha256').update(bytes).digest('base64') === expected
    } catch {
      return false
    }
  }

  router.post('/', async (req, res) => {
    res.set('Cache-Control', CACHE.none)
    const parsed = parseRepairRequest(req.body)
    if (!parsed) return res.status(400).json({ ok: false })
    const ip = clientKey(req)
    if (!take(`asset-repair:ip:${ip}`, 6, 3_600_000).ok || !take('asset-repair:all', 60, 3_600_000).ok) {
      return res.status(429).json({ ok: false })
    }
    const manifest = clientDir ? await manifestFor(parsed.build) : null
    if (!manifest) return res.status(404).json({ ok: false })

    const known = parsed.files.filter((name) => typeof manifest.files[name] === 'string')
    res.status(202).json({ ok: true, accepted: known.length })

    const urls = []
    for (const name of known) {
      if (!(await diskMatches(name, manifest.files[name]))) {
        log.error(`[asset-repair] 源站磁盘上的 assets/${name} 和构建清单对不上，清边缘缓存没用，检查部署`)
        continue
      }
      const last = lastPurged.get(name) || 0
      if (now() - last < FILE_COOLDOWN_MS) continue
      lastPurged.set(name, now())
      urls.push(`${siteOrigin}/assets/${name}`)
    }
    if (lastPurged.size > 2000) lastPurged.clear()
    if (!urls.length) return
    log.warn(`[asset-repair] 访客报告边缘缓存了坏的 chunk（构建 ${parsed.build}）：${urls.map((u) => u.split('/').pop()).join(', ')}`)
    if (!purgeEnabled()) {
      log.warn('[asset-repair] 没配 CF_ZONE_ID / CF_PURGE_API_TOKEN，无法清边缘缓存，只能等访客侧改走回源地址')
      return
    }
    try {
      await purge(urls)
      log.warn(`[asset-repair] 已清除 Cloudflare 边缘缓存：${urls.length} 个文件`)
    } catch (e) {
      log.error('[asset-repair] 清边缘缓存失败：', e?.message || e)
    }
  })

  return router
}
