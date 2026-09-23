/*
  PvZ 发布前的离线完整性检查。

  线上资源可达性由 pvz:check-assets 负责；这里专门挡住不需要联网也能发现的事故：
  中英文片段分叉、英文包写错 FS 名、共用运行脚本漏进 dist、WASM 被误换，以及安全修复回退。
*/
import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const repo = resolve(here, '..')
const useDist = process.argv.includes('--dist')
const root = useDist ? resolve(repo, 'dist/client/web/PvZ') : resolve(repo, 'public/web/PvZ')
const sourceRoot = resolve(repo, 'public/web/PvZ')
const snippet = readFileSync(resolve(repo, 'scripts/pvz-web/autoplay-snippet.html'), 'utf8')
const START = '<!-- PvZ_AUTOPLAY_START -->'
const END = '<!-- PvZ_AUTOPLAY_INJECTED -->'

const errors = []
const ok = (condition, message) => { if (!condition) errors.push(message) }
const text = (path) => readFileSync(path, 'utf8')
const sha256 = (path) => createHash('sha256').update(readFileSync(path)).digest('hex')

function extractSnippet(html) {
  const start = html.indexOf(START)
  const end = html.indexOf(END)
  if (start < 0 || end < start) return ''
  return html.slice(start, end + END.length)
}

function safeRelativePath(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 1024 &&
    !value.startsWith('/') && !value.includes('\\') && !value.includes('\0') &&
    !/^[a-z][a-z0-9+.-]*:/i.test(value) &&
    !value.split('/').some((part) => part === '.' || part === '..')
}

for (const locale of ['cn', 'en']) {
  const htmlPath = resolve(root, locale, 'index.html')
  const manifestPath = resolve(root, locale, 'pvz-manifest.json')
  ok(existsSync(htmlPath), `${locale}/index.html 缺失`)
  ok(existsSync(manifestPath), `${locale}/pvz-manifest.json 缺失`)
  if (!existsSync(htmlPath) || !existsSync(manifestPath)) continue

  const html = text(htmlPath)
  const config = locale === 'cn'
    ? "window.PVZ_LOCALE='zh';window.PVZ_MANIFEST_URL='cn/pvz-manifest.json?v=4';"
    : "window.PVZ_LOCALE='en';window.PVZ_MANIFEST_URL='en/pvz-manifest.json?v=4';"
  ok(extractSnippet(html).trimEnd() === snippet.trimEnd(), `${locale}/index.html 的自动加载片段未与唯一来源同步（运行 npm run pvz:sync-snippet）`)
  ok((html.match(/PvZ_AUTOPLAY_START/g) || []).length === 1, `${locale}/index.html 自动加载片段重复`)
  ok(html.includes('<base href=/web/PvZ/>'), `${locale}/index.html 缺少固定 base`)
  ok(html.includes('<link rel=preload href=pvz-portable.wasm as=fetch crossorigin>'), `${locale}/index.html 缺少 wasm preload`)
  ok(html.includes('<script src=pvz-page.js?v=20260923-save1></script>'), `${locale}/index.html 没有引用当前版本的共用运行脚本`)
  ok(!html.includes('const collectedFiles'), `${locale}/index.html 又出现内联运行脚本，中英文会再次分叉`)
  ok(html.includes(config), `${locale}/index.html 语言或清单配置错误`)
  const engineAt = html.indexOf('<script src=pvz-portable.js async onerror=')
  const runtimeAt = html.indexOf('<script src=pvz-page.js?v=20260923-save1></script>')
  const autoplayAt = html.indexOf(START)
  ok(engineAt >= 0 && runtimeAt > engineAt && autoplayAt > runtimeAt, `${locale}/index.html 脚本顺序错误`)

  let manifest
  try { manifest = JSON.parse(text(manifestPath)) } catch (error) { errors.push(`${locale} 清单 JSON 无效：${error.message}`); continue }
  ok(manifest?.format === '8bitgo.pvz.manifest.v2', `${locale} 不是 PvZ v2 流式清单`)
  if (manifest?.format !== '8bitgo.pvz.manifest.v2' || !Array.isArray(manifest.files) || !Array.isArray(manifest.bundles)) continue
  const entries = [...manifest.files, ...manifest.bundles]
  const fsSeen = new Set()
  for (const entry of entries) {
    ok(safeRelativePath(entry.r2) && safeRelativePath(entry.fs), `${locale} 清单包含不安全路径`)
    ok(!fsSeen.has(entry.fs), `${locale} 清单 fs 重复：${entry.fs}`)
    fsSeen.add(entry.fs)
    ok(Number.isSafeInteger(entry.size) && entry.size > 0, `${locale} 清单 size 无效：${entry.fs}`)
    ok(/^[0-9a-f]{64}$/.test(entry.sha256 || ''), `${locale} 清单 sha256 无效：${entry.fs}`)
  }
  const mains = entries.filter((entry) => entry.fs === 'main.pak')
  const expectedR2 = locale === 'en' ? 'en-main.pak' : 'main.pak'
  ok(mains.length === 1, `${locale} 必须恰好有一个 FS main.pak`)
  ok(mains[0] && mains[0].r2 === expectedR2, `${locale} main.pak 应映射到 ${expectedR2}`)
  ok(mains[0] && mains[0].size > 40 * 1024 * 1024, `${locale} main.pak 缺少可信长度`)
  ok(!entries.some((entry) => entry.fs === 'en-main.pak'), `${locale} 存在引擎不会读取的 en-main.pak`)
  const bundle = entries.find((entry) => entry.fs === '@bundle/reanim')
  ok(bundle?.format === '8bitgo.pvz.gzip-pack.v1', `${locale} 缺少 reanim 流式包`)
  ok(bundle?.fileCount >= 2000 && bundle?.unpackedBytes > 100 * 1024 * 1024, `${locale} reanim 流式包元数据不完整`)
}

for (const name of ['pvz-page.js', 'pvz-portable.js', 'pvz-portable.wasm', 'jszip.min.js', 'pvz-pack.json']) {
  ok(existsSync(resolve(root, name)), `${name} 缺失`)
}

if (existsSync(resolve(root, 'pvz-page.js'))) {
  const runtime = text(resolve(root, 'pvz-page.js'))
  try { new Function(runtime) } catch (error) { errors.push(`pvz-page.js 语法错误：${error.message}`) }
  for (const marker of ['inspectZip', 'unpackPvzBundle', 'DecompressionStream', 'EXIT_SAVE_TIMEOUT_MS', 'saveSyncQueued = true', 'window.__pvzStartTs = Date.now()', 'if (!window.__pvzGuardedReload())', '8bitgo-save-bridge', 'buildSaveArchive', 'applySaveArchive']) {
    ok(runtime.includes(marker), `pvz-page.js 缺少关键保护：${marker}`)
  }
  ok(!runtime.includes('__pvzGuardedReload() || window.location.reload()'), '退出刷新守卫被兜底 reload 绕过')
}

try {
  const snippetJs = snippet.match(/<script>([\s\S]*)<\/script>/)?.[1] || ''
  new Function(snippetJs)
} catch (error) {
  errors.push(`autoplay-snippet.html 语法错误：${error.message}`)
}
ok(snippet.includes("DATA_VERSION || '4'"), 'PvZ 资源缓存代次不是 4')
ok(snippet.includes("fs.indexOf('reanim/') === 0"), 'reanim/ 没有按必需资源处理')
ok(snippet.includes("fs === '@bundle/reanim'"), 'reanim 流式包没有按必需资源处理')
ok(snippet.includes('downloaded[entry.fs] = bytes'), 'IndexedDB 写入失败时没有内存回退')

const packCatalogPath = resolve(root, 'pvz-pack.json')
if (existsSync(packCatalogPath)) {
  try {
    const catalog = JSON.parse(text(packCatalogPath))
    ok(catalog.format === '8bitgo.pvz.gzip-pack.v1', 'pvz-pack.json format 错误')
    ok(/^packs\/reanim-[0-9a-f]{16}\.pvzpack\.gz$/.test(catalog.r2 || ''), 'pvz-pack.json r2 不是内容寻址路径')
    ok(/^[0-9a-f]{64}$/.test(catalog.sha256 || '') && catalog.r2?.includes(catalog.sha256.slice(0, 16)), 'pvz-pack.json 路径与 SHA-256 不一致')
    for (const locale of ['cn', 'en']) {
      const manifest = JSON.parse(text(resolve(root, locale, 'pvz-manifest.json')))
      const bundle = manifest.bundles?.[0]
      ok(bundle?.r2 === catalog.r2 && bundle?.sha256 === catalog.sha256 && bundle?.size === catalog.size, `${locale} 清单与 pvz-pack.json 不一致`)
    }
  } catch (error) {
    errors.push(`pvz-pack.json 无效：${error.message}`)
  }
}

const expectedHashes = {
  'pvz-portable.js': 'c4b6a4928cbf3d06824b75771907d556b0f49a8b61bb23ec17a77be2d9fffadd',
  'pvz-portable.wasm': '851072d991cc7f5770244b9be7204ed03ff5ee769101446987bbd3e1329ec3a6',
  'jszip.min.js': 'acc7e41455a80765b5fd9c7ee1b8078a6d160bbbca455aeae854de65c947d59e',
}
for (const [name, expected] of Object.entries(expectedHashes)) {
  const path = resolve(root, name)
  if (existsSync(path)) ok(sha256(path) === expected, `${name} 与已验收的 PvZ Portable 0.2.3 产物不一致`)
}

if (useDist && existsSync(root)) {
  for (const name of ['pvz-page.js', 'pvz-portable.js', 'pvz-portable.wasm', 'jszip.min.js', 'pvz-pack.json']) {
    const built = resolve(root, name)
    const source = resolve(sourceRoot, name)
    if (existsSync(built) && existsSync(source)) ok(sha256(built) === sha256(source), `dist 中的 ${name} 不是 public 最新版本`)
  }
}

if (errors.length) {
  console.error(`PvZ 检查失败（${useDist ? 'dist' : 'public'}）：`)
  for (const error of errors) console.error('  - ' + error)
  process.exit(1)
}
console.log(`PvZ 检查通过（${useDist ? 'dist' : 'public'}）：中英文清单、共用运行脚本、缓存/存档保护和引擎哈希均正常`)
