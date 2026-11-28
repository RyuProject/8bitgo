/**
 * 构建时给 /assets/ 下的现代版产物写一份 SHA-256 清单：assets/integrity-<入口哈希>.json。
 *
 * 为什么（2026-11-15，PK / TH 两位访客）：详情页懒加载 EmulatorPlayer 时报
 * `The requested module './live-Cqhc9j-k.js' does not provide an export named 'x'`。源站那份文件明明有这个导出，
 * 构建也是确定性的 —— 浏览器手里那份字节和源站不一样（某一跳缓存给了坏内容）。文件名带哈希、一年 immutable，
 * 普通刷新拿回的还是同一份坏字节。修复脚本（public/assets/asset-repair-v7.js）出错时才读这份清单，
 * 逐个核对本页已经用过的 chunk 与报错 chunk 的静态依赖，坏的绕过缓存重取。
 *
 * 几条约束：
 * - **正常加载不读它**：清单只在出错时才下载，不往 HTML 里塞任何东西，不拖慢首屏。
 * - **名字跟着入口走**：入口 index-<哈希>.js 的哈希会随任何 chunk 变化而变（chunk 名逐级写进引用方），
 *   所以修复脚本只看页面上的入口 src 就能找到「这一版」的清单，不用另外下发地址。
 * - **哈希的是写到磁盘上的字节**：在 writeBundle 里读文件算，不信内存里的 chunk.code，
 *   免得以后有插件在更晚的阶段改产物、清单却还是旧的。
 * - 只管现代版（format es）：legacy 版走 SystemJS，旧浏览器上这套修复脚本本来也不跑。
 * - 先写临时文件再改名：部署时旧进程可能正在回这个文件，不能让它读到半份 JSON。
 */
import { createHash } from 'node:crypto'
import { readFileSync, renameSync, writeFileSync } from 'node:fs'
import path from 'node:path'

export const INTEGRITY_MANIFEST_VERSION = 2

/** 入口文件名 → 清单文件名（不带目录）；不是现代版入口返回 null */
export function integrityManifestName(entryFileName) {
  const base = path.basename(String(entryFileName || ''))
  const m = /^index-([A-Za-z0-9_-]+)\.js$/.exec(base)
  if (!m || m[1].startsWith('legacy-')) return null
  return `integrity-${m[1]}.json`
}

export function sha256Base64(bytes) {
  return createHash('sha256').update(bytes).digest('base64')
}

/** 只收 /assets/ 下会被浏览器当子资源取的东西；清单自己、source map 不收 */
export function isIntegrityTarget(fileName) {
  return /^assets\/[^/]+\.(?:js|mjs|css|wasm)$/.test(fileName) && !fileName.startsWith('assets/integrity-')
}

export function buildIntegrityManifest(entryFileName, files, imports = {}) {
  const sorted = Object.keys(files).sort()
  const out = {}
  for (const name of sorted) out[name] = files[name]
  const graph = {}
  for (const name of Object.keys(imports).sort()) {
    if (!out[name] || !name.endsWith('.js')) continue
    graph[name] = [...new Set(imports[name]
      .map((dependency) => path.basename(dependency))
      .filter((dependency) => dependency.endsWith('.js') && out[dependency]))].sort()
  }
  return { v: INTEGRITY_MANIFEST_VERSION, alg: 'sha256', entry: path.basename(entryFileName), files: out, imports: graph }
}

/** 当前 SSR 语言包 → 本次构建的动态 chunk；服务端据此提前预载正在访问的那一份。 */
export function localeAssetsFromBundle(bundle) {
  const locales = {}
  for (const item of Object.values(bundle ?? {})) {
    if (item?.type !== 'chunk') continue
    const id = String(item.facadeModuleId ?? '').replace(/\\/g, '/')
    const match = /(?:^|\/)src\/locales\/(zh-Hans|zh-Hant|en|es|fr|it|de|ja)\.ts$/.exec(id)
    const fileName = String(item.fileName ?? '')
    if (!match || !/^assets\/[A-Za-z0-9_.-]+\.js$/.test(fileName)) continue
    locales[match[1]] = fileName
  }
  return Object.fromEntries(Object.entries(locales).sort(([a], [b]) => a.localeCompare(b)))
}

export function assetIntegrityPlugin() {
  return {
    name: 'asset-integrity-manifest',
    apply: 'build',
    writeBundle(options, bundle) {
      if (options.format && options.format !== 'es') return
      const dir = options.dir
      if (!dir) return
      const entry = Object.values(bundle).find((item) => item.type === 'chunk' && item.isEntry && integrityManifestName(item.fileName))
      if (!entry) return
      const manifestName = integrityManifestName(entry.fileName)
      const files = {}
      const imports = {}
      for (const fileName of Object.keys(bundle)) {
        if (!isIntegrityTarget(fileName)) continue
        files[path.basename(fileName)] = sha256Base64(readFileSync(path.join(dir, fileName)))
      }
      for (const item of Object.values(bundle)) {
        if (item.type !== 'chunk' || !files[path.basename(item.fileName)]) continue
        imports[path.basename(item.fileName)] = item.imports || []
      }
      const locales = localeAssetsFromBundle(bundle)
      const target = path.join(dir, 'assets', manifestName)
      const tmp = `${target}.${process.pid}.tmp`
      const manifest = buildIntegrityManifest(entry.fileName, files, imports)
      if (Object.keys(locales).length) manifest.locales = locales
      writeFileSync(tmp, JSON.stringify(manifest))
      renameSync(tmp, target)
    },
  }
}
