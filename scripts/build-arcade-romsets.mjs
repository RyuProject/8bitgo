#!/usr/bin/env node
/**
 * 从 FBNeo 源码生成街机 romset 指纹索引 → public/arcade-romsets.bin
 *
 * ── 为什么需要它 ─────────────────────────────────────────────
 * 街机核心（FBNeo / MAME 系）**靠压缩包的文件名认游戏**：叫 kof97.zip 才会去跑
 * kof97 这个驱动，叫 the-king-of-fighters-97.zip 就直接「Romset is unknown」。
 * 而管理员手里的文件十有八九是从别处下来的、名字千奇百怪的包 —— 靠人肉记
 * 8000 多个 romset 的短名是不现实的。
 *
 * 好在**答案就藏在包里**：zip 的中央目录里每个成员都带着 CRC-32，不用解压就能读。
 * 拿这些 CRC 和 FBNeo 的驱动表一比，是哪个 romset 一目了然，连克隆集都能分清
 *（kof97 与 kof97h 只差一个 ROM）。这个脚本就是把 FBNeo 的驱动表榨成一张索引。
 *
 * ── 数据从哪来 ───────────────────────────────────────────────
 * FBNeo 的 DAT 是运行时生成的，仓库里没有现成的。但驱动源码里就是明文：
 *
 *     static struct BurnRomInfo kof97RomDesc[] = {
 *         { "232-p1.p1", 0x100000, 0x7db81ad9, 1 | BRF_ESS | BRF_PRG },
 *         ...
 *     };
 *     struct BurnDriver BurnDrvKof97 = {
 *         "kof97", NULL, "neogeo", NULL, "1997",     ← 短名、父集、BIOS
 *         ...
 *         NULL, kof97RomInfo, kof97RomName, ...      ← 指回上面那张表
 *     };
 *
 * ⚠️ 短名**必须**从 BurnDriver 的第一个字段取，不能拿数组名当短名：CPS 系的数组
 *    叫 DinoRomDesc，而 romset 其实叫 dino，大小写都对不上。
 *
 * ── 怎么重新生成（FBNeo 更新后）─────────────────────────────
 *     git clone --filter=blob:none --no-checkout --depth 1 \
 *       https://github.com/finalburnneo/FBNeo.git /tmp/fbn
 *     cd /tmp/fbn && git sparse-checkout init --cone && \
 *       git sparse-checkout set src/burn/drv && git checkout
 *     node scripts/build-arcade-romsets.mjs /tmp/fbn/src/burn/drv
 *
 * 产物提交进 git（约 600KB）—— 和核心一样，构建机上不会有 FBNeo 源码。
 */
import { readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const srcDir = process.argv[2]
if (!srcDir) {
  console.error('用法: node scripts/build-arcade-romsets.mjs <FBNeo>/src/burn/drv')
  console.error('（怎么取 FBNeo 源码见本文件头注释）')
  process.exit(1)
}

/** 这些驱动目录不是街机，站点走别的核心跑，不该混进街机索引 */
const SKIP = new Set(['megadrive', 'nes', 'snes', 'sms', 'pce', 'spectrum', 'msx', 'coleco', 'sg1000', 'channelf', 'gba'])

const DESC = /static\s+struct\s+BurnRomInfo\s+(\w+?)RomDesc\s*\[\s*\]\s*=\s*\{([\s\S]*?)\n\};/g
const ROW = /\{\s*"([^"]+)"\s*,\s*(0x[0-9a-fA-F]+|\d+)\s*,\s*(0x[0-9a-fA-F]+|\d+)\s*,/g
const DRV = /struct\s+BurnDriver\w*\s+BurnDrv\w+\s*=\s*\{([\s\S]*?)\n\};/g
// 开头三个字段：szShortName, szParent, szBoardROM（BIOS 包名）
const HEAD = /^\s*(?:"((?:[^"\\]|\\.)*)"|NULL)\s*,\s*(?:"((?:[^"\\]|\\.)*)"|NULL)\s*,\s*(?:"((?:[^"\\]|\\.)*)"|NULL)\s*,/
const ROMINFO = /\b(\w+)RomInfo\b/

function walk(dir, out = []) {
  for (const n of readdirSync(dir)) {
    const p = join(dir, n)
    if (statSync(p).isDirectory()) walk(p, out)
    else if (n.endsWith('.cpp')) out.push(p)
  }
  return out
}

/**
 * FBNeo 把不少 CPS-3 等大 ROM 清单写成跨行宏，再在 BurnRomInfo 数组里引用。
 * 只扫数组正文会把《街头霸王 III》这类清单缩成一颗 BIOS ROM，后台就会拿这个
 * 偶然共享的 BIOS CRC 去误认 MAME/CHD。这里只展开源码文件内的对象宏；不执行
 * C 预处理器，也不把宏参数/编译条件当成 ROM 数据。
 */
function objectMacros(source) {
  const macros = new Map()
  const lines = source.split(/\r?\n/)
  for (let i = 0; i < lines.length; i++) {
    const match = /^\s*#\s*define\s+([A-Za-z_]\w*)(.*)$/.exec(lines[i])
    if (!match || match[2].startsWith('(')) continue // 函数式宏不参与 ROM 清单展开
    const parts = []
    let body = match[2]
    let continued = /\\\s*$/.test(body)
    parts.push(body.replace(/\\\s*$/, ''))
    while (continued && i + 1 < lines.length) {
      body = lines[++i]
      continued = /\\\s*$/.test(body)
      parts.push(body.replace(/\\\s*$/, ''))
    }
    macros.set(match[1], parts.join('\n'))
  }
  return macros
}

function expandObjectMacros(input, macros, expanding = new Set()) {
  return input.replace(/\b[A-Za-z_]\w*\b/g, (token) => {
    const body = macros.get(token)
    if (body === undefined || expanding.has(token)) return token
    const next = new Set(expanding)
    next.add(token)
    return expandObjectMacros(body, macros, next)
  })
}

const descs = new Map() // 数组名 -> CRC[]
const drivers = [] // { short, parent, bios, key }
for (const f of walk(srcDir)) {
  if (SKIP.has(relative(srcDir, f).split(sep)[0])) continue
  const src = readFileSync(f, 'utf8')
  const macros = objectMacros(src)
  for (const m of src.matchAll(DESC)) {
    const crcs = []
    const expanded = expandObjectMacros(m[2], macros)
    for (const r of expanded.matchAll(ROW)) {
      const crc = Number(r[3])
      if (crc) crcs.push(crc >>> 0) // CRC 为 0 = 未 dump 的占位项，跳过
    }
    if (crcs.length) descs.set(m[1], crcs)
  }
  for (const m of src.matchAll(DRV)) {
    const h = HEAD.exec(m[1])
    if (!h || !h[1]) continue
    const ri = ROMINFO.exec(m[1])
    if (!ri) continue
    drivers.push({ short: h[1], parent: h[2] || '', bios: h[3] || '', key: ri[1] })
  }
}

const sets = drivers.filter((d) => descs.has(d.key))
if (sets.length < 5000) {
  console.error(`✖ 只解析出 ${sets.length} 个 romset，明显偏少 —— FBNeo 源码结构可能变了，正则要跟着改`)
  process.exit(1)
}

// (crc, setId) 全量对，按 crc 排序。**不能每个 CRC 只留一个 romset**：
// 克隆集和父集共享绝大多数 ROM，只留一个的话 kof97h 会被误判成 kof97。
const pairs = []
sets.forEach((s, i) => {
  for (const c of descs.get(s.key)) pairs.push([c, i])
})
pairs.sort((a, b) => a[0] - b[0] || a[1] - b[1])

const names = Buffer.from(sets.map((s) => `${s.short}\t${s.parent}\t${s.bios}`).join('\n'), 'utf8')

const body = []
const varint = (n) => {
  for (;;) {
    const b = n & 0x7f
    n >>>= 7
    body.push(n ? b | 0x80 : b)
    if (!n) return
  }
}
let prev = 0
for (const [c, i] of pairs) {
  varint(c - prev)
  prev = c
  varint(i)
}

const head = Buffer.alloc(20)
head.write('8BRS', 0, 'ascii')
head.writeUInt8(1, 4) // 格式版本
head.writeUInt32LE(sets.length, 8)
head.writeUInt32LE(names.length, 12)
head.writeUInt32LE(pairs.length, 16)

const out = join(root, 'public', 'arcade-romsets.bin')
writeFileSync(out, Buffer.concat([head, names, Buffer.from(body)]))
console.log(`✔ ${sets.length} 个 romset / ${pairs.length} 条 CRC → public/arcade-romsets.bin`)
console.log(`  (名字表 ${(names.length / 1024) | 0}KB + 索引 ${(body.length / 1024) | 0}KB)`)
