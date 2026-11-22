/**
 * 内容版本号守卫：`/emulatorjs/<文件>?v=<sha256 前 16 位>[.epoch]` 的版本号必须和磁盘上这份文件的内容一致，
 * 不一致的响应一律 no-store —— 绝不能让边缘把「别的内容」挂在这个版本号下面缓存一年。
 *
 * ── 为什么（2026-11-17 全站事故复盘）────────────────────────────────────────
 * EmulatorJS 的文件名不带哈希，版本只在查询串里（src/emulator/paths.ts 的 ejsRuntimeAsset / ejsCoreAsset），
 * 而 express.static 忽略查询串：同一路径只有磁盘上那一份。于是下面这些时刻，「版本号 A」的 URL 会拿到「内容 B」，
 * 再被 CACHE.engineVersioned（max-age=31536000, immutable）锁进 Cloudflare / EdgeOne 一年：
 *   - 部署构建期间：Vite 先把新 public/ 拷进 dist/client，旧页面（旧 HTML、已打开的标签页）还在请求旧版本号；
 *   - 构建失败 / 回滚：新引擎已经写进 dist，旧版本号被缓存成新内容 —— 回滚到旧提交也救不回来，
 *     页面引用的旧版本号在边缘里已经是坏引擎了；
 *   - 有人只改了文件、忘了重生成版本表（check-emulatorjs 会拦，但这里是运行时最后一道）。
 * 内容哈希版本号的意义就是「同一个号永远是同一份字节」；这里在源站把它变成硬保证。
 *
 * 不一致时仍然返回当前文件（可用性优先，和以前一样），只是不许任何一层缓存它。
 */
import path from 'node:path'
import { fileSha256 } from './file-hash.js'

/** 只守「同路径 + 查询串版本」的目录；其余运行时按目录换代（ruffle/v…、jsdos/v…），天然不会混 */
export const CONTENT_VERSIONED_PREFIXES = Object.freeze(['/emulatorjs/'])

/** `1183825bab02ab07.e1` → `1183825bab02ab07`；不是内容哈希格式（旧的代次号）就不管 */
export function contentHashOfVersion(v) {
  const match = /^([0-9a-f]{16})(?:\.[0-9a-z]+)?$/i.exec(String(v || ''))
  return match ? match[1].toLowerCase() : ''
}

export const NO_STORE_HEADERS = Object.freeze({
  'Cache-Control': 'no-store',
  // Cloudflare 的 Cache Rules / EdgeOne 可能按规则覆盖源站 TTL；这两个头专门给 CDN，优先级更高
  'CDN-Cache-Control': 'no-store',
  'Cloudflare-CDN-Cache-Control': 'no-store',
})

const warned = new Set()

/**
 * @param {string} root 静态根目录（dist/client）
 * @param {{ prefixes?: readonly string[], log?: (line: string) => void }} [options]
 */
export function runtimeVersionGuard(root, { prefixes = CONTENT_VERSIONED_PREFIXES, log = (line) => console.warn(line) } = {}) {
  const base = path.resolve(root)
  return async function runtimeVersionGuardMiddleware(req, res, next) {
    if (req.method !== 'GET' && req.method !== 'HEAD') return next()
    const urlPath = req.path
    const prefix = prefixes.find((candidate) => urlPath.startsWith(candidate))
    if (!prefix) return next()
    const v = typeof req.query?.v === 'string' ? req.query.v : ''
    const expected = contentHashOfVersion(v)
    if (!expected) return next()
    const file = path.resolve(base, `.${urlPath}`)
    // `..` 绕出受管目录的请求不归这里管（express.static 自己会拒绝穿越）
    if (!file.startsWith(path.resolve(base, `.${prefix}`) + path.sep)) return next()
    try {
      const info = await fileSha256(file)
      if (info && info.sha256.slice(0, 16) !== expected) {
        res.locals.runtimeVersionMismatch = true
        const key = `${urlPath}?${expected}`
        if (!warned.has(key)) {
          if (warned.size > 1000) warned.clear()
          warned.add(key)
          log(`[runtime-version] ${urlPath} 请求版本 ${expected}，磁盘内容是 ${info.sha256.slice(0, 16)}：本次响应 no-store（部署中或版本表过期）`)
        }
      } else if (info && urlPath.startsWith('/emulatorjs/cores/') && urlPath.endsWith('-wasm.data')) {
        // Range 续传要用强 ETag 证明前后两段字节相同；弱 ETag 不能用于 If-Range。
        // 仅对版本校验通过的核心使用完整 SHA-256，版本不匹配仍只发 no-store。
        res.setHeader('ETag', `"sha256-${info.sha256}"`)
      }
    } catch {
      // 算不出哈希就当不一致处理：宁可这一次不缓存，也不能把不确定的内容锁进边缘一年
      res.locals.runtimeVersionMismatch = true
    }
    next()
  }
}

/** staticCacheHeaders 里用：版本号与内容不一致的响应，覆盖成 no-store */
export function applyNoStore(res) {
  for (const [name, value] of Object.entries(NO_STORE_HEADERS)) res.setHeader(name, value)
}
