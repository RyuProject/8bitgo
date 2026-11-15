/**
 * 可供 js-dos 使用的系统镜像副本配置。
 *
 * 外部地址由管理员在浏览器里测速和校验；服务端只保存配置，不会替任意 URL 发请求，
 * 因此这条能力不会变成 SSRF / R2 开放代理。玩家公开接口只发布已与 R2 原件 SHA-256
 * 对齐的副本；未校验或已停用的地址只会出现在后台接口里。
 */
import { Router } from 'express'
import { requireAbility } from './auth.js'
import { DOS_SYSTEM_IMAGE_CATALOG, DOS_SYSTEM_IMAGE_MAX_MIRRORS, DEFAULT_DOS_SYSTEM_IMAGE_SOURCES } from '../../shared/dos-system-images.js'
import { getSiteSetting, setSiteSetting } from './site-settings.js'

export const SYSTEM_IMAGE_SOURCES_SETTING = 'dos-system-image-sources'
export const systemImageSourcesRouter = Router()
export const adminSystemImageSourcesRouter = Router()

const FILES = new Set(DOS_SYSTEM_IMAGE_CATALOG.map(({ file }) => file))
const SHA256_RE = /^[a-f0-9]{64}$/i

function sha256(value) {
  const normalized = String(value ?? '').trim().toLowerCase()
  return SHA256_RE.test(normalized) ? normalized : ''
}

function mirrorUrl(value) {
  const raw = String(value ?? '').trim()
  if (!raw || raw.length > 2048) return ''
  try {
    const url = new URL(raw)
    const host = url.hostname.toLowerCase()
    if (
      url.protocol !== 'https:' ||
      url.username ||
      url.password ||
      url.hash ||
      (url.port && url.port !== '443') ||
      !host ||
      host === 'localhost' ||
      host.endsWith('.localhost') ||
      host.endsWith('.local') ||
      host.endsWith('.internal') ||
      host.endsWith('.test') ||
      host.startsWith('[') ||
      /^\d+(?:\.\d+){3}$/.test(host)
    ) return ''
    return url.toString()
  } catch {
    return ''
  }
}

function normalizeSettings(input) {
  const filesInput = input && typeof input === 'object' && input.files && typeof input.files === 'object'
    ? input.files
    : {}
  const files = {}
  for (const file of FILES) {
    const item = filesInput[file] && typeof filesInput[file] === 'object' ? filesInput[file] : {}
    const seenIds = new Set()
    const seenUrls = new Set()
    const mirrors = []
    const rawMirrors = Array.isArray(item.mirrors) ? item.mirrors.slice(0, DOS_SYSTEM_IMAGE_MAX_MIRRORS) : []
    for (let index = 0; index < rawMirrors.length; index++) {
      const raw = rawMirrors[index]
      if (!raw || typeof raw !== 'object') continue
      const url = mirrorUrl(raw.url)
      const id = String(raw.id ?? '').trim().toLowerCase()
      const label = String(raw.label ?? '').trim()
      if (!url || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(id) || !label || label.length > 64) continue
      if (seenIds.has(id) || seenUrls.has(url)) continue
      seenIds.add(id)
      seenUrls.add(url)
      mirrors.push({
        id,
        label,
        url,
        enabled: raw.enabled !== false,
        verifiedSha256: sha256(raw.verifiedSha256),
      })
    }
    const r2Version = String(item.r2Version ?? '').trim().slice(0, 256)
    files[file] = { sha256: sha256(item.sha256), r2Version, mirrors }
  }
  return { version: 1, files }
}

async function readSavedSettings() {
  const raw = await getSiteSetting(SYSTEM_IMAGE_SOURCES_SETTING)
  if (raw == null) return structuredClone(DEFAULT_DOS_SYSTEM_IMAGE_SOURCES)
  try {
    return normalizeSettings(JSON.parse(raw))
  } catch {
    // 配置损坏时安全地禁用外部源；R2 主 / 兜底源仍由播放器代码固定提供。
    return normalizeSettings(null)
  }
}

systemImageSourcesRouter.get('/', async (_req, res, next) => {
  try {
    const settings = await readSavedSettings()
    const files = {}
    for (const [file, item] of Object.entries(settings.files)) {
      files[file] = {
        sha256: item.sha256,
        r2Version: item.r2Version,
        mirrors: item.mirrors
          .filter((mirror) => mirror.enabled && item.sha256 && item.r2Version && mirror.verifiedSha256 === item.sha256)
          .map(({ id, label, url, verifiedSha256 }) => ({ id, label, url, sha256: verifiedSha256 })),
      }
    }
    res.set('Cache-Control', 'no-store')
    res.json({ version: 1, files })
  } catch (error) {
    next(error)
  }
})

adminSystemImageSourcesRouter.get('/', requireAbility('site:manage'), async (_req, res, next) => {
  try {
    res.set('Cache-Control', 'private, no-store')
    res.json(await readSavedSettings())
  } catch (error) {
    next(error)
  }
})

adminSystemImageSourcesRouter.put('/', requireAbility('site:manage'), async (req, res, next) => {
  try {
    const settings = normalizeSettings(req.body)
    await setSiteSetting(SYSTEM_IMAGE_SOURCES_SETTING, JSON.stringify(settings))
    res.set('Cache-Control', 'private, no-store')
    res.json(settings)
  } catch (error) {
    next(error)
  }
})
