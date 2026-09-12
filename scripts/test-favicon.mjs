// 站标的回归测试。跑：npm run test:favicon
//
// ## 为什么值得单独写一份
//
// 站标是两个文件（public/favicon.svg + public/favicon.ico），画的是同一张图 ——
// 一个 10×12 的像素「8」。它们会分别坏，而且**坏了没有人会发现**：
//
//   · index.html 里的 <link> 指向一个不存在的文件 → 每次开页面多一个 404，
//     浏览器安静地退回默认图标，控制台里也不一定有红字。
//   · 只改了 svg 没改 ico（或反过来）→ 两个尺寸下站标长得不一样，
//     而你自己的浏览器大概率一直在用其中一个，另一个要换台机器才看得见。
//   · viewBox 被人「优化」成贴边的 12×12 → 16/12 不是整数，
//     每个像素格被摊成 1px 或 2px，宽窄不匀。截图放大才看得出来。
//
// 所以这份测试只盯三件事：引用的文件在不在、svg 的格子是不是整数、
// ico 里那层 16×16 和 svg 画出来的是不是同一张图。
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)))
const html = readFileSync(path.join(root, 'index.html'), 'utf8')
const svgText = readFileSync(path.join(root, 'public/favicon.svg'), 'utf8')
const ico = readFileSync(path.join(root, 'public/favicon.ico'))

let pass = 0
const fails = []
const check = (name, fn) => {
  try {
    fn()
    pass++
    console.log('  ✓ ' + name)
  } catch (e) {
    fails.push({ name, e })
    console.log('  ✗ ' + name + ' —— ' + (e?.message ?? e))
  }
}

const SIDE = 16 // svg 的 viewBox 和 ico 最小那层都是 16

console.log('\n── index.html 引的图标必须真的存在 ──')

check('⚠️ 每个 rel="icon" 指向的文件都在 public/ 里', () => {
  const hrefs = [...html.matchAll(/<link[^>]*rel="icon"[^>]*>/g)].map((m) => {
    const h = /href="([^"]+)"/.exec(m[0])
    assert.ok(h, `这条 link 没有 href：${m[0]}`)
    return h[1]
  })
  assert.ok(hrefs.length >= 1, 'index.html 里一个 rel="icon" 都没有')
  for (const href of hrefs) {
    assert.ok(href.startsWith('/'), `${href} 不是根路径，vite 的 public/ 不会这么映射`)
    const file = path.join(root, 'public', href.slice(1))
    assert.ok(existsSync(file), `index.html 引了 ${href}，但 public/${href.slice(1)} 不存在`)
  }
  // 同时保证 ico 那条没被谁顺手删掉 —— 它是小尺寸下唯一清晰的那份
  assert.ok(hrefs.includes('/favicon.ico'), '少了 /favicon.ico')
  assert.ok(hrefs.includes('/favicon.svg'), '少了 /favicon.svg')
})

console.log('\n── svg：格子必须落在整数上 ──')

// 把 svg 里的 rect 铺成一张 16×16 的颜色表，'' 表示透明
function paintSvg(text) {
  const vb = /viewBox="([^"]+)"/.exec(text)
  assert.ok(vb, 'svg 没有 viewBox')
  const [minX, minY, w, h] = vb[1].trim().split(/\s+/).map(Number)
  assert.deepEqual(
    [minX, minY, w, h],
    [0, 0, SIDE, SIDE],
    `viewBox 是 ${vb[1]}，不是 0 0 ${SIDE} ${SIDE} —— 换成非 16 的整除边长，缩到 16/32/48px 时格子会宽窄不匀`,
  )
  const grid = Array.from({ length: SIDE }, () => Array(SIDE).fill(''))
  const rects = [...text.matchAll(/<rect\b[^>]*>/g)]
  assert.ok(rects.length > 0, 'svg 里一个 rect 都没有')
  for (const [tag] of rects) {
    const num = (k) => {
      const m = new RegExp(`${k}="([^"]+)"`).exec(tag)
      assert.ok(m, `rect 少了 ${k}：${tag}`)
      const v = Number(m[1])
      assert.ok(Number.isInteger(v), `rect 的 ${k}=${m[1]} 不是整数 —— 像素格不能落在半个单位上`)
      return v
    }
    const fill = /fill="([^"]+)"/.exec(tag)
    assert.ok(fill, `rect 没有 fill：${tag}`)
    const [x, y, w2, h2] = [num('x'), num('y'), num('width'), num('height')]
    assert.ok(x >= 0 && y >= 0 && x + w2 <= SIDE && y + h2 <= SIDE, `rect 画到 viewBox 外面去了：${tag}`)
    for (let r = y; r < y + h2; r++) for (let c = x; c < x + w2; c++) grid[r][c] = fill[1].toLowerCase()
  }
  return grid
}

let svgGrid = null
check(`⚠️ viewBox 是 0 0 ${SIDE} ${SIDE}，每个 rect 的坐标和宽高都是整数`, () => {
  svgGrid = paintSvg(svgText)
  const painted = svgGrid.flat().filter(Boolean).length
  assert.ok(painted > 50, `只画了 ${painted} 格，图是不是空的`)
})

console.log('\n── ico：三层都在，且和 svg 画的是同一张图 ──')

// 解析 ICO：只认 32bpp 的 BMP(DIB) 层，够用了
function parseIco(buf) {
  assert.equal(buf.readUInt16LE(0), 0, 'ICONDIR 的 reserved 不是 0')
  assert.equal(buf.readUInt16LE(2), 1, 'ICONDIR 的 type 不是 1（图标）')
  const n = buf.readUInt16LE(4)
  const layers = []
  for (let i = 0; i < n; i++) {
    const e = 6 + 16 * i
    layers.push({
      w: buf[e] || 256,
      h: buf[e + 1] || 256,
      bits: buf.readUInt16LE(e + 6),
      size: buf.readUInt32LE(e + 8),
      off: buf.readUInt32LE(e + 12),
    })
  }
  return layers
}

// 把某一层的像素读出来（32 位 BGRA，自底向上），返回和 paintSvg 同形状的颜色表
function decodeLayer(buf, L) {
  assert.equal(buf.readUInt32LE(L.off), 40, '这一层不是 BITMAPINFOHEADER（PNG 层这里不认）')
  const w = buf.readInt32LE(L.off + 4)
  const h = buf.readInt32LE(L.off + 8) / 2 // 高度是两倍：XOR 图 + AND 掩码
  const bpp = buf.readUInt16LE(L.off + 14)
  assert.equal(bpp, 32, `这一层是 ${bpp}bpp，不是 32bpp`)
  const px = L.off + 40
  const grid = Array.from({ length: h }, () => Array(w).fill(''))
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const o = px + ((h - 1 - y) * w + x) * 4
      const [b, g, r, a] = [buf[o], buf[o + 1], buf[o + 2], buf[o + 3]]
      grid[y][x] = a === 0 ? '' : '#' + [r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('')
    }
  }
  return grid
}

let layers = null
check('⚠️ ico 里有 16 / 32 / 48 三层', () => {
  layers = parseIco(ico)
  const sizes = layers.map((l) => `${l.w}x${l.h}`).sort()
  assert.deepEqual(sizes, ['16x16', '32x32', '48x48'], `ico 里的层是 ${sizes.join(', ')}`)
  for (const l of layers) {
    assert.equal(l.w, l.h, `${l.w}x${l.h} 不是正方形`)
    assert.equal(l.w % SIDE, 0, `${l.w} 不是 ${SIDE} 的整数倍 —— 那就没法整数倍放大，小尺寸必糊`)
    assert.ok(l.off + l.size <= ico.length, '某一层的数据超出文件末尾了')
  }
})

check('⚠️ ico 的 16×16 那层和 svg 逐格一致（两边不能漂）', () => {
  const L = layers.find((l) => l.w === SIDE)
  assert.ok(L, '没有 16×16 那层')
  const got = decodeLayer(ico, L)
  const bad = []
  for (let r = 0; r < SIDE; r++) {
    for (let c = 0; c < SIDE; c++) {
      if (got[r][c] !== svgGrid[r][c]) bad.push(`(${c},${r}) ico=${got[r][c] || '透明'} svg=${svgGrid[r][c] || '透明'}`)
    }
  }
  assert.deepEqual(bad.slice(0, 8), [], `\n     ${bad.length} 格对不上：\n     ${bad.slice(0, 8).join('\n     ')}`)
})

check('⚠️ 大尺寸的层就是小尺寸的整数倍放大（最近邻，不是插值糊过去的）', () => {
  // 像素画一旦被双线性缩放，格子边上会冒出中间色。
  // 这条把 32/48 那两层按倍数采样回 16×16，要求和 16×16 那层完全相同。
  const base = decodeLayer(ico, layers.find((l) => l.w === SIDE))
  for (const L of layers.filter((l) => l.w !== SIDE)) {
    const s = L.w / SIDE
    const big = decodeLayer(ico, L)
    for (let r = 0; r < SIDE; r++) {
      for (let c = 0; c < SIDE; c++) {
        for (const [dy, dx] of [[0, 0], [s - 1, s - 1], [0, s - 1]]) {
          assert.equal(
            big[r * s + dy][c * s + dx],
            base[r][c],
            `${L.w}×${L.w} 那层在 (${c * s + dx},${r * s + dy}) 和 16×16 的 (${c},${r}) 对不上 —— 多半是被插值缩放过`,
          )
        }
      }
    }
  }
})

console.log('')
if (fails.length) {
  for (const f of fails) console.error('✗ ' + f.name + '\n' + (f.e?.stack ?? f.e))
  console.error(`\n❌ ${fails.length} 条失败 / 共 ${pass + fails.length} 条`)
  process.exit(1)
}
console.log(`✅ 站标：${pass} 条全过`)
