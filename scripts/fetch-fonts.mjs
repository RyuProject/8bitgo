#!/usr/bin/env node
/**
 * 把两个像素字体下载到 public/fonts/：
 *
 *   1. 方舟像素字体（Ark Pixel Font, SIL OFL 1.1）→ public/fonts/ark-pixel/
 *      中文用。12px proportional 的 zh_cn 一份。
 *   2. Geist Pixel（SIL OFL 1.1）→ public/fonts/geist-pixel/
 *      西文用。**以前是从 Google Fonts 直接引的**（index.html 里一条
 *      `<link rel="stylesheet">`），它跨源、且阻塞首屏渲染：浏览器得先连
 *      fonts.googleapis.com 取 CSS、再连 fonts.gstatic.com 取字体文件，
 *      两次握手都压在主线程之外的关键路径上。自托管之后这两跳全没了。
 *
 *   npm run fonts                   强制重新下载
 *   node scripts/fetch-fonts.mjs --if-missing   已有文件则跳过（npm run dev / prebuild 会自动执行）
 *
 * 两步互相独立：某一个下载失败不影响另一个（--if-missing 下只警告不报错）。
 * 失败时页面都会**自动退回系统字体**（index.css 的 font-family 链），不会白屏。
 *
 * 无法访问网络时手动放置：
 *   · 方舟 → https://github.com/TakWolf/ark-pixel-font/releases
 *            下载 ark-pixel-font-12px-proportional-otf.woff2-v*.zip 后
 *            `ARK_PIXEL_ZIP=/path/to/that.zip npm run fonts`
 *   · Geist → https://fonts.google.com/specimen/Geist+Pixel 取下列两个 woff2，
 *            按 index.css 里注释的文件名放进 public/fonts/geist-pixel/
 *              geist-pixel-latin.woff2
 *              geist-pixel-latin-ext.woff2
 */
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'
import { inflateRawSync } from 'node:zlib'

const SIZE = 12
const WIDTH = 'proportional'
const FORMAT = 'otf.woff2'
const FLAVORS = ['zh_cn']
const REPO = 'TakWolf/ark-pixel-font'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const arkDir = join(root, 'public', 'fonts', 'ark-pixel')
const geistDir = join(root, 'public', 'fonts', 'geist-pixel')
const ifMissing = process.argv.includes('--if-missing')
const targets = FLAVORS.map((f) => `ark-pixel-${SIZE}px-${WIDTH}-${f}.${FORMAT}`)

/* ---------------- 方舟像素（中文） ---------------- */

/** 极简 zip 解压（支持 stored / deflate），避免依赖系统 unzip / tar */
function unzip(zipPath, dest) {
  const buf = readFileSync(zipPath)
  let eocd = -1
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i
      break
    }
  }
  if (eocd < 0) throw new Error('不是有效的 zip 文件')
  const count = buf.readUInt16LE(eocd + 10)
  let offset = buf.readUInt32LE(eocd + 16)
  const entries = []
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(offset) !== 0x02014b50) throw new Error('zip 目录损坏')
    const method = buf.readUInt16LE(offset + 10)
    const compSize = buf.readUInt32LE(offset + 20)
    const nameLen = buf.readUInt16LE(offset + 28)
    const extraLen = buf.readUInt16LE(offset + 30)
    const commentLen = buf.readUInt16LE(offset + 32)
    const localOffset = buf.readUInt32LE(offset + 42)
    const name = buf.toString('utf8', offset + 46, offset + 46 + nameLen)
    entries.push({ name, method, compSize, localOffset })
    offset += 46 + nameLen + extraLen + commentLen
  }
  const base = resolve(dest)
  for (const e of entries) {
    if (e.name.endsWith('/')) continue
    const target = resolve(dest, e.name)
    if (!target.startsWith(base)) continue // 防止路径穿越
    const lh = e.localOffset
    if (buf.readUInt32LE(lh) !== 0x04034b50) throw new Error('zip 文件头损坏')
    const start = lh + 30 + buf.readUInt16LE(lh + 26) + buf.readUInt16LE(lh + 28)
    const data = buf.subarray(start, start + e.compSize)
    let out
    if (e.method === 0) out = data
    else if (e.method === 8) out = inflateRawSync(data)
    else throw new Error(`不支持的压缩方式 ${e.method}`)
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, out)
  }
}

function findFile(dir, name) {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry)
    if (statSync(p).isDirectory()) {
      const hit = findFile(p, name)
      if (hit) return hit
    } else if (entry === name) {
      return p
    }
  }
  return null
}

async function resolveZip(tmp) {
  if (process.env.ARK_PIXEL_ZIP) {
    console.log(`使用本地压缩包：${process.env.ARK_PIXEL_ZIP}`)
    return { zipPath: process.env.ARK_PIXEL_ZIP, version: 'local' }
  }

  const api = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, {
    headers: { 'User-Agent': '8bitgo-fetch-fonts', Accept: 'application/vnd.github+json' },
  })
  if (!api.ok) throw new Error(`GitHub API 返回 ${api.status}`)
  const release = await api.json()

  const pattern = new RegExp(`^ark-pixel-font-${SIZE}px-${WIDTH}-${FORMAT}-v.*\\.zip$`)
  const asset = (release.assets ?? []).find((a) => pattern.test(a.name))
  if (!asset) {
    console.error('未找到匹配的发行包，该版本提供的文件有：')
    for (const a of release.assets ?? []) console.error('  -', a.name)
    throw new Error('asset not found')
  }

  console.log(`下载 ${asset.name}（${(asset.size / 1024 / 1024).toFixed(1)} MB）…`)
  const res = await fetch(asset.browser_download_url)
  if (!res.ok) throw new Error(`下载失败：${res.status}`)
  const zipPath = join(tmp, asset.name)
  writeFileSync(zipPath, Buffer.from(await res.arrayBuffer()))
  return { zipPath, version: release.tag_name }
}

async function arkPixel() {
  const tmp = mkdtempSync(join(tmpdir(), 'ark-pixel-'))
  try {
    const { zipPath, version } = await resolveZip(tmp)
    const extractDir = join(tmp, 'extract')
    mkdirSync(extractDir, { recursive: true })
    unzip(zipPath, extractDir)

    mkdirSync(arkDir, { recursive: true })
    for (const name of targets) {
      const src = findFile(extractDir, name)
      if (!src) throw new Error(`压缩包中没有 ${name}`)
      copyFileSync(src, join(arkDir, name))
    }
    const license = findFile(extractDir, 'OFL.txt')
    if (license) copyFileSync(license, join(arkDir, 'OFL.txt'))
    writeFileSync(join(arkDir, 'VERSION.txt'), `${version}\n`)

    console.log(`  中文：${targets.join(', ')}（版本 ${version}）`)
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
}

/* ---------------- Geist Pixel（西文） ---------------- */

const GEIST_CSS_URL = 'https://fonts.googleapis.com/css2?family=Geist+Pixel&display=swap'

/**
 * ⚠️ 必须带一个**现代浏览器**的 UA。
 *
 * Google Fonts 按 UA 决定返回什么格式：老 UA 拿到的是一整份 ttf，现代 UA 才拿到
 * 切成 unicode-range 的 woff2。默认的 node fetch UA 会落到 ttf 那一支，
 * 于是下载下来的东西有几百 KB 而且和 index.css 里声明的文件名对不上。
 */
const MODERN_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'

/** 我们只取这两份子集，和 index.css 里那两条 @font-face 一一对应 */
const GEIST_SUBSETS = ['latin', 'latin-ext']
const geistFile = (subset) => join(geistDir, `geist-pixel-${subset}.woff2`)

/**
 * 从 Google 的 CSS 里挑出两份子集。
 *
 * 返回的 CSS 长这样（每块前面有一条 `/* latin *​/` 注释标明子集）：
 *   @font-face { … src: url(https://fonts.gstatic.com/…woff2) format('woff2'); … }
 * 我们按注释切块，只认要的两份。
 */
function parseGeistCss(css) {
  const out = new Map()
  const re = /\/\*\s*([a-z-]+)\s*\*\/\s*@font-face\s*\{([\s\S]*?)\}/g
  for (const m of css.matchAll(re)) {
    const subset = m[1]
    if (!GEIST_SUBSETS.includes(subset)) continue
    const url = m[2].match(/url\((https:\/\/[^)]+\.woff2)\)/)
    if (url) out.set(subset, url[1])
  }
  return out
}

async function geistPixel() {
  const cssRes = await fetch(GEIST_CSS_URL, { headers: { 'User-Agent': MODERN_UA } })
  if (!cssRes.ok) throw new Error(`Google Fonts CSS 返回 ${cssRes.status}`)
  const urls = parseGeistCss(await cssRes.text())

  const missing = GEIST_SUBSETS.filter((s) => !urls.has(s))
  if (missing.length) {
    throw new Error(`Google 返回的 CSS 里没有这些子集：${missing.join(', ')}（字体改版了？更新本脚本）`)
  }

  mkdirSync(geistDir, { recursive: true })
  const sizes = []
  for (const subset of GEIST_SUBSETS) {
    const res = await fetch(urls.get(subset), { headers: { 'User-Agent': MODERN_UA } })
    if (!res.ok) throw new Error(`下载 ${subset} 失败：${res.status}`)
    const buf = Buffer.from(await res.arrayBuffer())
    writeFileSync(geistFile(subset), buf)
    sizes.push(`${subset} ${Math.round(buf.length / 1024)}KB`)
  }
  writeFileSync(join(geistDir, 'VERSION.txt'), `google-css\nget ${GEIST_CSS_URL}\n`)
  console.log(`  西文：${sizes.join('、')}`)
}

/* ---------------- 入口 ---------------- */

const allArkPresent = targets.every((t) => existsSync(join(arkDir, t)))
const allGeistPresent = GEIST_SUBSETS.every((s) => existsSync(geistFile(s)))

if (ifMissing && allArkPresent && allGeistPresent) {
  process.exit(0)
}

const steps = [
  { name: '中文像素字体（方舟）', present: allArkPresent, run: arkPixel },
  { name: '西文像素字体（Geist Pixel）', present: allGeistPresent, run: geistPixel },
]

for (const step of steps) {
  if (ifMissing && step.present) {
    console.log(`· ${step.name} 已存在，跳过`)
    continue
  }
  try {
    await step.run()
    console.log(`✔ ${step.name} 已就绪`)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    if (!ifMissing) {
      console.error(`✖ ${step.name} 下载失败：${msg}`)
      process.exit(1)
    }
    console.warn(`⚠ ${step.name} 下载失败（${msg}），先退回系统字体。稍后可执行 npm run fonts 重试。`)
  }
}
