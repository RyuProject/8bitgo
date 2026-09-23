/*
  自检 PvZ 资源是否真的上传到位。

  为什么需要它：2026-09-23 线上 PvZ 完全打不开，根因是 pvz-manifest.json 列了
  2117 个 reanim/ 文件、**存储端一个都没有**，而页面表现只是「自动加载失败（reanim/xxx HTTP 404）」，
  不跑一遍请求根本看不出是哪一层缺失。这个脚本就是那一次的事故工具。

  它按 manifest 逐条发 HEAD（不是 GET，不下载字节），按顶层目录汇总可达/缺失：
    - main.pak 是必需资源，缺了直接判失败（退出码 2）
    - reanim/ 等属于可选，缺了只告警（退出码 1），但会明确告诉你缺了多少

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

function isRequired(fs) { return fs === 'main.pak' }
function topDir(fs) { return fs.indexOf('/') > 0 ? fs.split('/')[0] : '(根)' }

async function head(url) {
  try {
    const ctl = new AbortController()
    const timer = setTimeout(() => ctl.abort(), 15000)
    const r = await fetch(url, { method: 'HEAD', redirect: 'follow', signal: ctl.signal })
    clearTimeout(timer)
    return { ok: r.ok, status: r.status }
  } catch (e) {
    return { ok: false, status: 'ERR ' + (e && e.name === 'AbortError' ? 'timeout' : e.message) }
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
  console.log('    清单条目: ' + manifest.length)

  const entries = manifest.map((e) => (typeof e === 'string' ? { r2: e, fs: e } : e))

  // 必需资源全查；其余按顶层目录抽样 —— 缺失通常是整目录的，抽样足够定位
  const byDir = new Map()
  for (const e of entries) {
    const d = topDir(e.fs)
    if (!byDir.has(d)) byDir.set(d, [])
    byDir.get(d).push(e)
  }
  const picked = []
  for (const [, list] of byDir) {
    for (const e of list) if (isRequired(e.fs)) picked.push(e)
    const rest = list.filter((e) => !isRequired(e.fs))
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
      const r = await head(DATA_BASE + e.r2)
      results.push({ fs: e.fs, r2: e.r2, ...r })
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
    console.log('       ' + DATA_BASE + r.r2 + '  → ' + r.status)
  }

  const missRequired = missing.some((r) => isRequired(r.fs))
  if (missRequired) {
    console.log('    ⛔ main.pak 不可达：玩家一定进不去游戏')
    process.exitCode = 2
  } else {
    console.log('    ⚠️  缺的是可选资源：游戏能进但可能在运行中崩溃（缺 reanim/ 会 CppException）')
    process.exitCode = process.exitCode || 1
  }

  const allReanimMissing = byMissingDir.get('reanim') && byMissingDir.get('reanim') >= (sampleTotal.get('reanim') || 0)
  if (allReanimMissing) {
    console.log('\n    修复：把资源目录里的 reanim/ 整个目录上传到 DATA_BASE 下的 reanim/，')
    console.log('    即 ' + DATA_BASE + 'reanim/<文件名> 必须能取到。')
    console.log('    上传后重跑本脚本确认，再让已访问过的玩家加 ?nocache=1 刷新（或 bump PVZ_DATA_VERSION）。')
  }
}

for (const locale of LOCALES) await checkLocale(locale)
console.log('')
