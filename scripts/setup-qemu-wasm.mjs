#!/usr/bin/env node
/**
 * 准备 /linux 页面用的 QEMU WebAssembly 运行时（public/qemu-wasm/）。
 *
 *   npm run qemu                                  重新安装（逐个校验 SHA-256）
 *   node scripts/setup-qemu-wasm.mjs --if-missing  缺哪个补哪个；都在就跳过（dev / build 前自动跑）
 *   node scripts/setup-qemu-wasm.mjs --strict      取不到就退出码 1（默认只是警告，见下）
 *
 * ── 为什么这些文件不进 git ──────────────────────────────────
 * 整目录 140MB，其中 load-rootfs.data 一个就 79MB。它是上游（ktock/qemu-wasm-demo）
 * 编译好的产物，本站一行都没改 —— 和 ruffle / jsdos / j2me / webretro 是同一类东西，
 * 按同一套约定处理：进 .gitignore，用到时现装。仓库里只留本站自己写的 start.js
 * 和记录来源与哈希的 SOURCE.txt / licenses/。
 *
 * 140MB 进 git 的代价不只是磁盘：每次 clone、每次 git pull、每次 shallow fetch
 * 都要搬这么多，而这个仓库的带宽主要花在它上面。
 *
 * ── 哈希是硬要求 ────────────────────────────────────────────
 * SOURCE.txt 里那份「SHA-256 of vendored upstream files」是**唯一的验收依据**，
 * 本脚本逐条比对，对不上就删掉重下并报错。
 * 不校验的话，一次被劫持或半截的下载会留下一个「启动到一半崩掉」的 QEMU，
 * 而 /linux 的报错界面只会显示「启动失败」，根本看不出是文件坏了。
 *
 * ── 为什么默认不致命 ────────────────────────────────────────
 * /linux 是独立的附加页面，主站和模拟器都不依赖它。生产机上这些文件**已经在
 * public/qemu-wasm/ 里**（它们本来是进 git 的，git pull 不会删掉被忽略的文件），
 * 所以 --if-missing 会直接跳过。只有全新 clone 才需要联网。
 * 联网失败时默认只警告、不打断构建 —— 为一个附加页面挡住整次部署不划算；
 * 想要「缺了就别构建」的行为请显式传 --strict。
 */
import { createHash } from 'node:crypto'
import { createWriteStream } from 'node:fs'
import { mkdirSync, readFileSync, existsSync, rmSync, statSync } from 'node:fs'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import path from 'node:path'

const ROOT = path.resolve(import.meta.dirname, '..')
const DIR = path.join(ROOT, 'public', 'qemu-wasm')
const SOURCE = path.join(DIR, 'SOURCE.txt')
/** 上游 demo 的静态资源目录（见 SOURCE.txt 顶部） */
const BASE = 'https://ktock.github.io/qemu-wasm-demo/images/alpine-x86_64/'

const args = new Set(process.argv.slice(2))
const ifMissing = args.has('--if-missing')
const strict = args.has('--strict')

/**
 * 从 SOURCE.txt 里解析出「文件名 -> sha256」。
 * 只看最后那段哈希清单，不解析前面的说明文字。
 */
function wanted() {
  if (!existsSync(SOURCE)) {
    throw new Error(`缺少 ${path.relative(ROOT, SOURCE)}：哈希清单没了就没法校验，不敢装`)
  }
  const out = []
  let inList = false
  for (const line of readFileSync(SOURCE, 'utf8').split('\n')) {
    const l = line.trim()
    if (/^SHA-256 of vendored upstream files:/i.test(l)) {
      inList = true
      continue
    }
    if (!inList) continue
    const m = /^([0-9a-f]{64})\s+(\S+)$/i.exec(l)
    if (m) out.push({ name: m[2], sha: m[1].toLowerCase() })
    else if (l && !/^\s*$/.test(l)) break // 清单结束了
  }
  if (!out.length) throw new Error('SOURCE.txt 里没解析出任何哈希，格式变了？')
  return out
}

async function sha256Of(file) {
  const h = createHash('sha256')
  const { createReadStream } = await import('node:fs')
  await pipeline(createReadStream(file), h)
  return h.digest('hex')
}

async function download(name) {
  const url = BASE + encodeURIComponent(name)
  const res = await fetch(url, { redirect: 'follow' })
  if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`)
  const tmp = path.join(DIR, `.${name}.part`)
  await pipeline(Readable.fromWeb(res.body), createWriteStream(tmp))
  return tmp
}

const list = wanted()
mkdirSync(DIR, { recursive: true })

let fetched = 0
let failed = 0
for (const { name, sha } of list) {
  const dest = path.join(DIR, name)
  if (existsSync(dest)) {
    const ok = statSync(dest).size > 0 && (await sha256Of(dest)) === sha
    if (ok) {
      if (ifMissing) continue
      console.log(`· ${name} 已存在且哈希一致`)
      continue
    }
    console.log(`· ${name} 哈希不一致，重新下载`)
    rmSync(dest, { force: true })
  }
  try {
    const tmp = await download(name)
    const got = await sha256Of(tmp)
    if (got !== sha) {
      rmSync(tmp, { force: true })
      throw new Error(`哈希不匹配：期望 ${sha.slice(0, 12)}…，实到 ${got.slice(0, 12)}…`)
    }
    const { renameSync } = await import('node:fs')
    renameSync(tmp, dest)
    fetched++
    console.log(`✔ ${name}（${(statSync(dest).size / 1048576).toFixed(1)} MB）`)
  } catch (e) {
    failed++
    console.warn(`✘ ${name} 下载失败：${e instanceof Error ? e.message : String(e)}`)
  }
}

if (!failed) {
  console.log(fetched ? `✔ QEMU 运行时就绪（新下载 ${fetched} 个）` : '✔ QEMU 运行时已就绪')
  process.exit(0)
}

const msg = `⚠ QEMU 运行时缺 ${failed} 个文件，/linux 页面会启动失败（主站不受影响）。
  手动补：npm run qemu${ifMissing ? '' : '  （--if-missing 只补缺失的）'}`
if (strict) {
  console.error(msg)
  process.exit(1)
}
console.warn(msg)
