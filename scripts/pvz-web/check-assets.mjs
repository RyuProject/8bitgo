/*
  自检 PvZ 资源是否真的上传到位。

  为什么需要它：2026-09-23 线上 PvZ 完全打不开，根因是 pvz-manifest.json 列了
  2117 个 reanim/ 文件、**存储端一个都没有**，而页面表现只是「自动加载失败（reanim/xxx HTTP 404）」，
  不跑一遍请求根本看不出是哪一层缺失。这个脚本就是那一次的事故工具。

  它按 manifest 逐条发 HEAD（不是 GET，不下载字节），按顶层目录汇总可达/缺失：
    - main.pak 和 reanim/ 是必需资源，缺了直接判失败（退出码 2）
    - properties/ 覆盖配置缺失只告警（退出码 1）

  用法：
    node scripts/pvz-web/check-assets.mjs                  # 抽查 cn + en（每目录 30 条）
    node scripts/pvz-web/check-assets.mjs --locale cn
    node scripts/pvz-web/check-assets.mjs --limit 100      # 每目录抽查 100 条
    node scripts/pvz-web/check-assets.mjs --all            # 全量（2000+ 请求，慢）
*/
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(__dirname, '..', '..')

const argv = process.argv.slice(2)
function opt(name, dflt) {
  const i = argv.indexOf('--' + name)
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : dflt
}
const has = (name) => argv.includes('--' + name)

const LOCALES = opt('locale', null) ? [opt('locale', null)] : ['cn', 'en']
const LIMIT = has('all') ? Infinity : Number(opt('limit', 30)) || 30
const CONCURRENCY = Math.max(1, Number(opt('conc', 10)) || 10)

function isRequired(fs) { return fs === 'main.pak' || fs.startsWith('reanim/') || fs === '@bundle/reanim' }
function topDir(fs) { return fs === '@bundle/reanim' ? 'reanim-pack' : (fs.indexOf('/') > 0 ? fs.split('/')[0] : '(根)') }

function safeRelativePath(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 1024 &&
    !value.startsWith('/') && !value.includes('\\') && !value.includes('\0') &&
    !/^[a-z][a-z0-9+.-]*:/i.test(value) &&
    !value.split('/').some((part) => part === '.' || part === '..')
}

function validateManifest(locale, entries) {
  const errors = []
  const fsSeen = new Set()
  const expectedMain = locale === 'en' ? 'en-main.pak' : 'main.pak'
  for (const [index, e] of entries.entries()) {
    if (!safeRelativePath(e.r2) || !safeRelativePath(e.fs)) errors.push(`第 ${index + 1} 项路径不安全`)
    if (fsSeen.has(e.fs)) errors.push(`fs 重复：${e.fs}`)
    fsSeen.add(e.fs)
    if (!Number.isSafeInteger(e.size) || e.size <= 0) errors.push(`size 无效：${e.fs}`)
    if (!/^[0-9a-f]{64}$/.test(e.sha256 || '')) errors.push(`sha256 无效：${e.fs}`)
  }
  const mains = entries.filter((e) => e.fs === 'main.pak')
  if (mains.length !== 1) errors.push(`必须恰好有一条 fs=main.pak，实际 ${mains.length}`)
  else if (mains[0].r2 !== expectedMain) errors.push(`${locale} 的 main.pak 应映射到 ${expectedMain}，实际 ${mains[0].r2}`)
  const strayMain = entries.filter((e) => e.fs.endsWith('main.pak') && e.fs !== 'main.pak')
  if (strayMain.length) errors.push(`发现引擎不会读取的额外包：${strayMain.map((e) => e.fs).join(', ')}`)
  const bundle = entries.find((e) => e.fs === '@bundle/reanim')
  if (bundle && (bundle.format !== '8bitgo.pvz.gzip-pack.v1' || !Number.isSafeInteger(bundle.fileCount) || !Number.isSafeInteger(bundle.unpackedBytes))) {
    errors.push('reanim 流式包元数据无效')
  }
  const reanimCount = bundle ? bundle.fileCount : entries.filter((e) => e.fs.startsWith('reanim/')).length
  if (reanimCount < 2000) errors.push(`reanim/ 清单异常少：${reanimCount} 项`)
  return errors
}

async function head(url) {
  const ctl = new AbortController()
  const timer = setTimeout(() => ctl.abort(), 15000)
  try {
    const r = await fetch(url, {
      method: 'HEAD',
      redirect: 'follow',
      signal: ctl.signal,
      headers: { Origin: 'https://8bitgo.com' },
    })
    return {
      ok: r.ok,
      status: r.status,
      length: Number(r.headers.get('content-length')) || 0,
      allowOrigin: r.headers.get('access-control-allow-origin') || '',
      contentType: r.headers.get('content-type') || '',
    }
  } catch (e) {
    return { ok: false, status: 'ERR ' + (e && e.name === 'AbortError' ? 'timeout' : e.message) }
  } finally {
    clearTimeout(timer)
  }
}

async function checkLocale(locale) {
  const htmlPath = resolve(ROOT, 'public/web/PvZ', locale, 'index.html')
  const manifestPath = resolve(ROOT, 'public/web/PvZ', locale, 'pvz-manifest.json')

  let html, manifest
  try {
    html = readFileSync(htmlPath, 'utf8')
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  } catch (e) {
    console.error('[' + locale + '] 读文件失败：' + e.message)
    process.exitCode = 2
    return
  }

  // DATA_BASE 写在页面里，取它才能拼出真实 URL —— 拼错一层是最常见的部署失误
  const m = html.match(/PVZ_DATA_BASE\s*=\s*['"]([^'"]*)['"]/)
  const DATA_BASE = m ? m[1] : './'
  console.log('\n=== [' + locale + '] DATA_BASE = ' + DATA_BASE)
  const rawEntries = Array.isArray(manifest)
    ? manifest
    : manifest?.format === '8bitgo.pvz.manifest.v2' && Array.isArray(manifest.files) && Array.isArray(manifest.bundles)
      ? [...manifest.files, ...manifest.bundles]
      : null
  if (!rawEntries) {
    console.error('[' + locale + '] 清单格式不受支持')
    process.exitCode = 2
    return
  }
  console.log('    清单条目: ' + rawEntries.length + (Array.isArray(manifest) ? '' : '（v2 流式包）'))

  const entries = rawEntries.map((e) => (typeof e === 'string' ? { r2: e, fs: e } : e))
  const manifestErrors = validateManifest(locale, entries)
  if (manifestErrors.length) {
    console.log('    ⛔ 清单结构错误：')
    for (const error of manifestErrors) console.log('       - ' + error)
    process.exitCode = 2
    return
  }

  // main.pak 永远全查；大目录默认均匀抽样。reanim 虽是必需资源，但默认就发 2000+ 个 HEAD
  // 会让日常自检过慢，完整验收再显式加 --all。
  const byDir = new Map()
  for (const e of entries) {
    const d = topDir(e.fs)
    if (!byDir.has(d)) byDir.set(d, [])
    byDir.get(d).push(e)
  }
  const picked = []
  for (const [, list] of byDir) {
    for (const e of list) if (e.fs === 'main.pak') picked.push(e)
    const rest = list.filter((e) => e.fs !== 'main.pak')
    const step = Math.max(1, Math.ceil(rest.length / LIMIT))
    for (let i = 0; i < rest.length && picked.length < Infinity; i += step) picked.push(rest[i])
  }

  console.log('    本次抽查: ' + picked.length + ' 条（每目录最多 ' + LIMIT + ' 条，--all 可全量）')

  const results = []
  let cursor = 0
  async function worker() {
    for (;;) {
      const i = cursor++
      if (i >= picked.length) return
      const e = picked[i]
      const url = new URL(e.r2.split('/').map(encodeURIComponent).join('/'), DATA_BASE).href
      const r = await head(url)
      const corsOk = new URL(url).origin === 'https://8bitgo.com' || r.allowOrigin === '*' || r.allowOrigin === 'https://8bitgo.com'
      const sizeOk = !e.size || !r.length || e.size === r.length
      results.push({ fs: e.fs, r2: e.r2, expectedSize: e.size || 0, corsOk, sizeOk, ...r, ok: r.ok && corsOk && sizeOk })
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, picked.length) }, worker))

  const missing = results.filter((r) => !r.ok)
  const byMissingDir = new Map()
  for (const r of missing) {
    const d = topDir(r.fs)
    byMissingDir.set(d, (byMissingDir.get(d) || 0) + 1)
  }

  if (!missing.length) {
    console.log('    ✅ 抽查全部可达')
    return
  }

  const sampleTotal = new Map()
  for (const r of results) {
    const d = topDir(r.fs)
    sampleTotal.set(d, (sampleTotal.get(d) || 0) + 1)
  }
  console.log('    ❌ 不可达 ' + missing.length + '/' + results.length + ' 条：')
  for (const [d, n] of byMissingDir) {
    const total = sampleTotal.get(d) || 0
    const allMissing = n >= total
    console.log('       - ' + d + ': ' + n + '/' + total + (allMissing ? '  ← 整个目录都取不到' : ''))
  }
  console.log('    示例（前 5 条）：')
  for (const r of missing.slice(0, 5)) {
    let detail = String(r.status)
    if (r.ok === false && r.status === 200 && !r.corsOk) detail += '，CORS 缺少 https://8bitgo.com'
    if (r.status === 200 && !r.sizeOk) detail += `，长度 ${r.length}（清单 ${r.expectedSize}）`
    console.log('       ' + DATA_BASE + r.r2 + '  → ' + detail)
  }

  const missingRequired = missing.filter((r) => isRequired(r.fs))
  if (missingRequired.length) {
    const requiredGroups = [...new Set(missingRequired.map((r) => r.fs === 'main.pak' ? 'main.pak' : topDir(r.fs) + '/'))]
    console.log('    ⛔ 必需资源不可达（' + requiredGroups.join('、') + '）：已阻止启动，避免进入后黑屏或 CppException')
    process.exitCode = 2
  } else {
    console.log('    ⚠️  缺的是可选覆盖配置：游戏可使用引擎内置默认值启动')
    process.exitCode = process.exitCode || 1
  }

  const allReanimMissing = byMissingDir.get('reanim') && byMissingDir.get('reanim') >= (sampleTotal.get('reanim') || 0)
  const bundleMissing = byMissingDir.get('reanim-pack')
  if (allReanimMissing || bundleMissing) {
    console.log('\n    修复：运行 npm run pvz:upload -- --dry-run 校验本地包；确认后加 --yes 上传，')
    console.log('    目标对象必须能通过上面打印的完整 URL 读取。')
    console.log('    上传后重跑本脚本确认，再让已访问过的玩家加 ?nocache=1 刷新（或 bump PVZ_DATA_VERSION）。')
  }
}

for (const locale of LOCALES) await checkLocale(locale)
console.log('')
