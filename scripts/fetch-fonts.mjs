#!/usr/bin/env node
/**
 * 下载「方舟像素字体」(Ark Pixel Font, SIL OFL 1.1) 到 public/fonts/ark-pixel/
 *
 *   npm run fonts                 强制重新下载最新版本
 *   node scripts/fetch-fonts.mjs --if-missing
 *                                 已有文件则跳过（npm run dev 前会自动执行）
 *
 * 无法访问 GitHub 时，可手动从
 *   https://github.com/TakWolf/ark-pixel-font/releases
 * 下载 ark-pixel-font-12px-proportional-otf.woff2-v*.zip，然后：
 *   ARK_PIXEL_ZIP=/path/to/that.zip npm run fonts
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
const outDir = join(root, 'public', 'fonts', 'ark-pixel')
const ifMissing = process.argv.includes('--if-missing')
const targets = FLAVORS.map((f) => `ark-pixel-${SIZE}px-${WIDTH}-${f}.${FORMAT}`)

if (ifMissing && targets.every((t) => existsSync(join(outDir, t)))) {
  process.exit(0)
}

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
  const root = resolve(dest)
  for (const e of entries) {
    if (e.name.endsWith('/')) continue
    const target = resolve(dest, e.name)
    if (!target.startsWith(root)) continue // 防止路径穿越
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

async function main() {
  const tmp = mkdtempSync(join(tmpdir(), 'ark-pixel-'))
  try {
    const { zipPath, version } = await resolveZip(tmp)
    const extractDir = join(tmp, 'extract')
    mkdirSync(extractDir, { recursive: true })
    unzip(zipPath, extractDir)

    mkdirSync(outDir, { recursive: true })
    for (const name of targets) {
      const src = findFile(extractDir, name)
      if (!src) throw new Error(`压缩包中没有 ${name}`)
      copyFileSync(src, join(outDir, name))
    }
    const license = findFile(extractDir, 'OFL.txt')
    if (license) copyFileSync(license, join(outDir, 'OFL.txt'))
    writeFileSync(join(outDir, 'VERSION.txt'), `${version}\n`)

    console.log(`✔ 字体已就绪：${targets.join(', ')} → public/fonts/ark-pixel/（版本 ${version}）`)
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
}

main().catch((err) => {
  const msg = err instanceof Error ? err.message : String(err)
  if (ifMissing) {
    console.warn(`⚠ 中文像素字体下载失败（${msg}），先使用系统字体。稍后可执行 npm run fonts 重试，或参考 scripts/fetch-fonts.mjs 顶部说明手动放置。`)
    process.exit(0)
  }
  console.error(`✖ 下载失败：${msg}`)
  process.exit(1)
})
