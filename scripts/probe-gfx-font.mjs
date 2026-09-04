#!/usr/bin/env node
/**
 * 猜一块「来路不明」的街机字库 ROM 到底是什么排布。
 *
 * ── 为什么需要它 ─────────────────────────────────────────────
 * 汉化改版包常常新增一两块图形 ROM 装中文字库，而**原始排布没人知道**
 * （HBMAME 的 tk2h5 在源码里就直说 "The load procedure for the chinese
 * language is unknown"）。靠猜 RomData 的行序去试，一次要走「改 dat →
 * 上传 → 进游戏 → 看对话框」一整圈，还只能得到「花了 / 没花」一个比特的信息。
 *
 * 这个脚本把那一圈缩短成一次本地渲染：把 ROM 里的数据段按若干种候选格式
 * 画成 PNG，人眼一看就知道哪种排布能出现可读的汉字。**先确定源格式，
 * 再去算 CPS1 四路 lane 怎么填** —— 顺序反了就是在黑箱里试排列。
 *
 * ── FBNeo 那边的目标格式（src/burn/drv/capcom/cps.cpp，已核对源码）──
 *   CpsLoadTiles(Tile, n) 固定吃四条清单项：
 *     CpsLoadOne(Tile    , n+0, 1, 0)   16x16 图块的【左半 8 列】bitplane 0,1
 *     CpsLoadOne(Tile    , n+1, 1, 2)   左半 8 列                bitplane 2,3
 *     CpsLoadOne(Tile + 4, n+2, 1, 0)   【右半 8 列】            bitplane 0,1
 *     CpsLoadOne(Tile + 4, n+3, 1, 2)   右半 8 列                bitplane 2,3
 *   CpsLoadOne 每次吃 2 字节（nWord=1）出 8 像素：
 *     Pix = SepTable[b0] | SepTable[b1] << 1;  Pix <<= nShift;  *(UINT32*)pt |= Pix;  pt += 8;
 *   也就是图块内存是「每像素 4 bit、每行 16 像素 = 8 字节」，
 *   一块 16x16 = 128 字节，四条清单项各出 32 字节。
 *
 * ── 用法 ─────────────────────────────────────────────────────
 *   node scripts/probe-gfx-font.mjs <包.zip|目录> --rom tk2_gfx5cn.rom [--rom tk2_gfx6cn.rom]
 *        [--glyphs 256] [--cols 16] [--scale 2] [--out /tmp/gfxprobe]
 *
 * 生成 <out>/<候选名>.png，逐个看哪张能读出汉字。
 */
import { readFileSync, writeFileSync, mkdirSync, readdirSync, statSync } from 'node:fs'
import { join, basename } from 'node:path'
import { deflateSync, inflateRawSync } from 'node:zlib'

/* ---------------- 命令行 ---------------- */
const argv = process.argv.slice(2)
const flag = (n, d) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : d }
const flags = (n) => argv.reduce((a, v, i) => (v === `--${n}` ? [...a, argv[i + 1]] : a), [])
const src = argv.find((a) => !a.startsWith('--') && !argv[argv.indexOf(a) - 1]?.startsWith('--'))
if (!src) {
  console.error('用法: node scripts/probe-gfx-font.mjs <包.zip|目录> [--rom 名字]... [--glyphs 256] [--cols 16] [--scale 2] [--out 目录]')
  process.exit(1)
}
const nGlyph = Number(flag('glyphs', 256))
const cols = Number(flag('cols', 16))
const scale = Number(flag('scale', 2))
const outDir = flag('out', '/tmp/gfxprobe')

/* ---------------- 取 ROM ---------------- */
/** 最小 zip 读取：只认 stored(0) 和 deflate(8)，够读街机包了 */
function readZip(buf) {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength)
  let eocd = -1
  for (let i = buf.length - 22; i >= 0 && i >= buf.length - 22 - 0xffff; i--) {
    if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break }
  }
  if (eocd < 0) throw new Error('不是 zip')
  const count = dv.getUint16(eocd + 10, true)
  let p = dv.getUint32(eocd + 16, true)
  const out = new Map()
  for (let i = 0; i < count; i++) {
    const method = dv.getUint16(p + 10, true)
    const crc = dv.getUint32(p + 16, true)
    const csize = dv.getUint32(p + 20, true)
    const size = dv.getUint32(p + 24, true)
    const nameLen = dv.getUint16(p + 28, true)
    const extraLen = dv.getUint16(p + 30, true)
    const commentLen = dv.getUint16(p + 32, true)
    const lho = dv.getUint32(p + 42, true)
    const name = buf.subarray(p + 46, p + 46 + nameLen).toString('latin1')
    if (!name.endsWith('/')) {
      const lNameLen = dv.getUint16(lho + 26, true)
      const lExtraLen = dv.getUint16(lho + 28, true)
      const start = lho + 30 + lNameLen + lExtraLen
      const raw = buf.subarray(start, start + csize)
      out.set(name, { crc, size, data: method === 8 ? inflateRawSync(raw) : Buffer.from(raw) })
    }
    p += 46 + nameLen + extraLen + commentLen
  }
  return out
}

const st = statSync(src)
const files = new Map()
if (st.isDirectory()) {
  for (const n of readdirSync(src)) {
    const f = join(src, n)
    if (statSync(f).isFile()) files.set(n, { data: readFileSync(f) })
  }
} else if (src.toLowerCase().endsWith('.zip')) {
  for (const [k, v] of readZip(readFileSync(src))) files.set(k, v)
} else {
  files.set(basename(src), { data: readFileSync(src) })
}

let want = flags('rom')
if (!want.length) want = [...files.keys()]
const roms = want.map((n) => {
  const hit = [...files.keys()].find((k) => k === n || k.endsWith('/' + n))
  if (!hit) throw new Error(`包里没有 ${n}；有的是: ${[...files.keys()].join(', ')}`)
  return { name: hit, data: files.get(hit).data }
})

/* ---------------- 数据段在哪 ---------------- */
function extents(buf) {
  const runs = []
  let s = -1
  for (let i = 0; i < buf.length; i++) {
    if (buf[i] !== 0) { if (s < 0) s = i }
    else if (s >= 0 && i - s >= 0) {
      // 允许段内有零，按 4KB 粒度合并
      runs.push([s, i]); s = -1
    }
  }
  if (s >= 0) runs.push([s, buf.length])
  const merged = []
  for (const [a, b] of runs) {
    const last = merged[merged.length - 1]
    if (last && a - last[1] < 0x1000) last[1] = b
    else merged.push([a, b])
  }
  return merged
}

const crcTable = (() => {
  const t = new Uint32Array(256)
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0 }
  return t
})()
const crc32 = (buf) => { let c = 0xffffffff; for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0 }

console.log('# ROM 概况')
for (const r of roms) {
  const ex = extents(r.data)
  console.log(`\n${r.name}  ${r.data.length} 字节 (0x${r.data.length.toString(16)})  crc=${crc32(r.data).toString(16).padStart(8, '0')}`)
  console.log('  非零数据段:')
  for (const [a, b] of ex) console.log(`    0x${a.toString(16).padStart(6, '0')} .. 0x${(b - 1).toString(16).padStart(6, '0')}   长 0x${(b - a).toString(16)} (${b - a})`)
}
if (roms.length === 2) {
  const [A, B] = roms
  const n = Math.min(A.data.length, B.data.length)
  let same = 0
  for (let i = 0; i < n; i++) if (A.data[i] === B.data[i]) same++
  console.log(`\n两块 ROM 逐字节相同率: ${(same / n * 100).toFixed(2)}%`)
}

/* ---------------- 最小 PNG（8 位灰度） ---------------- */
function png(w, h, gray) {
  const raw = Buffer.alloc((w + 1) * h)
  for (let y = 0; y < h; y++) { raw[y * (w + 1)] = 0; gray.copy(raw, y * (w + 1) + 1, y * w, y * w + w) }
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length)
    const td = Buffer.concat([Buffer.from(type, 'latin1'), data])
    const c = Buffer.alloc(4); c.writeUInt32BE(crc32(td))
    return Buffer.concat([len, td, c])
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 0
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0)),
  ])
}

/** glyphs: Uint8Array[] 每个 gw*gh，值 0..15；铺成网格出 PNG */
function sheet(name, glyphs, gw, gh, maxLevel) {
  const rows = Math.ceil(glyphs.length / cols)
  const W = cols * (gw + 1) * scale, H = rows * (gh + 1) * scale
  const img = Buffer.alloc(W * H, 32)
  for (let g = 0; g < glyphs.length; g++) {
    const ox = (g % cols) * (gw + 1) * scale, oy = Math.floor(g / cols) * (gh + 1) * scale
    for (let y = 0; y < gh; y++) for (let x = 0; x < gw; x++) {
      const v = Math.round((glyphs[g][y * gw + x] / maxLevel) * 255)
      for (let sy = 0; sy < scale; sy++) for (let sx = 0; sx < scale; sx++) {
        img[(oy + y * scale + sy) * W + ox + x * scale + sx] = v
      }
    }
  }
  const p = join(outDir, `${name}.png`)
  writeFileSync(p, png(W, H, img))
  console.log(`  ${p}  (${glyphs.length} 图，${gw}x${gh})`)
}

mkdirSync(outDir, { recursive: true })
console.log('\n# 候选渲染')

const start = Number(flag('start', '0x10000'))
const bit = (b, i, msb) => (msb ? (b >> (7 - i)) & 1 : (b >> i) & 1)

/** 候选 1/2：裸 1bpp 16x16，每字 32 字节，一行两字节 */
for (const msb of [true, false]) {
  for (const r of roms) {
    const gl = []
    for (let g = 0; g < nGlyph; g++) {
      const o = start + g * 32
      if (o + 32 > r.data.length) break
      const px = new Uint8Array(256)
      for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) {
        px[y * 16 + x] = bit(r.data[o + y * 2 + (x >> 3)], x & 7, msb)
      }
      gl.push(px)
    }
    sheet(`1bpp16x16-${msb ? 'msb' : 'lsb'}-${r.name.replace(/\W+/g, '_')}`, gl, 16, 16, 1)
  }
}

/** 候选 3：裸 1bpp 8x8，每字 8 字节 */
for (const r of roms) {
  const gl = []
  for (let g = 0; g < nGlyph * 4; g++) {
    const o = start + g * 8
    if (o + 8 > r.data.length) break
    const px = new Uint8Array(64)
    for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) px[y * 8 + x] = bit(r.data[o + y], x, true)
    gl.push(px)
  }
  sheet(`1bpp8x8-${r.name.replace(/\W+/g, '_')}`, gl, 8, 8, 1)
}

/** 候选 4：两块 ROM 当两个 bitplane（2bpp 16x16） */
if (roms.length === 2) {
  const [A, B] = roms
  const gl = []
  for (let g = 0; g < nGlyph; g++) {
    const o = start + g * 32
    if (o + 32 > A.data.length || o + 32 > B.data.length) break
    const px = new Uint8Array(256)
    for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) {
      px[y * 16 + x] = bit(A.data[o + y * 2 + (x >> 3)], x & 7, true) | (bit(B.data[o + y * 2 + (x >> 3)], x & 7, true) << 1)
    }
    gl.push(px)
  }
  sheet('2bpp16x16-A=p0-B=p1', gl, 16, 16, 3)
}

/**
 * 候选 5：按 FBNeo 现在的装法「原样」渲染，即把清单四条
 * (e0,e1,e2,e3) 各喂一块 ROM，看解出来是不是就是截图里那种碎块。
 * 传 --lanes a,b,c,d，a..d 是 roms 的下标（可重复），默认 0,1,0,1（= 现在 dat 的写法）。
 */
{
  const lanes = (flag('lanes', '0,1,0,1')).split(',').map(Number)
  const gl = []
  for (let t = 0; t < nGlyph; t++) {
    const o = start + t * 32
    const px = new Uint8Array(256)
    let ok = true
    for (let e = 0; e < 4; e++) {
      const r = roms[lanes[e]]
      if (!r || o + 32 > r.data.length) { ok = false; break }
      const half = e < 2 ? 0 : 8          // Tile 还是 Tile+4 → 左半/右半 8 列
      const shift = e % 2 === 0 ? 0 : 2   // bitplane 0,1 还是 2,3
      for (let y = 0; y < 16; y++) {
        const b0 = r.data[o + y * 2], b1 = r.data[o + y * 2 + 1]
        for (let x = 0; x < 8; x++) {
          const v = (bit(b0, x, false) | (bit(b1, x, false) << 1)) << shift
          px[y * 16 + half + x] |= v
        }
      }
    }
    if (!ok) break
    gl.push(px)
  }
  sheet(`fbneo-lanes-${(flag('lanes', '0,1,0,1')).replace(/,/g, '')}`, gl, 16, 16, 15)
}

console.log('\n看哪张 PNG 里能读出汉字，那张的解释方式就是源格式。')
