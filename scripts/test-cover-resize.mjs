/**
 * 封面 Lanczos 重采样的自检（shared/lanczos.js）—— 不碰 DOM，node 直接跑。
 *
 *   node scripts/test-cover-resize.mjs      （或 npm run test:cover）
 *
 * 为什么值得单独测：缩放算法写错了**不会报错**，只会「看着有点糊 / 有点毛」，
 * 而肉眼在一张 300×300 的封面上很难判断这是压缩的正常代价还是算法坏了。
 * 这里测的两条恰好就是之前真的写错的两条：
 *
 *   1. 核必须是两个 sinc **相乘**。写成相除的话 x 趋近半径时权重不衰减、
 *      反而涨回 1 附近 —— 远处像素和中心像素一样重，出来的是一圈圈振铃和重影。
 *      下面「远端权重必须衰减到接近 0」那条就是专门盯它的。
 *   2. 缩小时滤波窗口必须按比例张大。不张大等于只挑了中间几个源像素、其余全丢，
 *      细密纹理会糊成摩尔纹。下面「1px 竖条纹压 4 倍应该变成均匀灰」那条盯的是它。
 *
 * 变异检查（值得每次改完手动做一遍）：把 buildWeights 里的 filterScale 强行改成 1，
 * 条纹那条必须变红；把核里的乘号改成除号，远端权重那条必须变红。
 */
import assert from 'node:assert/strict'
import { lanczos, buildWeights, resampleRGBA, centerSquare } from '../shared/lanczos.js'

let n = 0
const ok = (cond, msg) => {
  assert.ok(cond, msg)
  n++
  console.log('  OK ' + msg)
}

/** 独立写一遍参考实现，故意不复用被测代码的写法 */
function refLanczos(x, a) {
  if (x === 0) return 1
  if (Math.abs(x) >= a) return 0
  const sinc = (t) => Math.sin(Math.PI * t) / (Math.PI * t)
  return sinc(x) * sinc(x / a)
}

console.log('-- 核本身 --')
for (const x of [0.1, 0.25, 0.5, 0.75, 1.2, 1.5, 2.0, 2.5, 2.9]) {
  const got = lanczos(x, 3)
  const want = refLanczos(x, 3)
  assert.ok(Math.abs(got - want) < 1e-9, `L(${x}) 应为 ${want}，得到 ${got}`)
}
n++
console.log('  OK 核与参考实现 sinc(x)*sinc(x/a) 逐点一致')
ok(lanczos(0, 3) === 1, 'L(0) = 1')
ok(Math.abs(lanczos(1, 3)) < 1e-12 && Math.abs(lanczos(2, 3)) < 1e-12, '整数处过零')
ok(lanczos(3, 3) === 0 && lanczos(-3, 3) === 0 && lanczos(4, 3) === 0, '半径之外恒为 0')
ok(lanczos(1.5, 3) < 0, '第一负瓣确实是负的（锐度就是从这儿来的）')
// 这一条盯的是「相乘写成了相除」：那个写法在 2.9 处会给出 0.985
ok(Math.abs(lanczos(2.9, 3)) < 0.01, '远端（x=2.9）权重必须衰减到接近 0')
ok(Math.abs(lanczos(2.5, 3)) < Math.abs(lanczos(0.5, 3)) / 10, '越远权重越小，量级差一个数量级以上')

console.log('\n-- 权重表 --')
{
  const w = buildWeights(1200, 300, 3)
  for (let i = 0; i < 300; i++) {
    let sum = 0
    for (let k = 0; k < w.counts[i]; k++) sum += w.weights[i * w.ksize + k]
    assert.ok(Math.abs(sum - 1) < 1e-5, `第 ${i} 个目标像素的权重和应为 1，得到 ${sum}`)
  }
  n++
  console.log('  OK 每个目标像素的权重和都是 1（不归一就会整体偏亮或偏暗）')
  // 缩小 4 倍 -> 窗口要张到 ±12 个源像素，也就是 24 个左右
  ok(w.counts[150] >= 20, `缩小 4 倍时窗口张到了 ${w.counts[150]} 个源像素（不张大只会有 7 个）`)
  ok(w.starts[0] === 0, '第一个目标像素从源像素 0 开始取')
  const last = w.starts[299] + w.counts[299]
  ok(last === 1200, `最后一个目标像素取到源像素 ${last}（正好到边界，不越界也不少取）`)
}
{
  const up = buildWeights(100, 400, 3)
  ok(up.counts[200] <= 7, '放大时窗口不张大，仍是 ±3 个源像素')
}

/** 造一张 RGBA 图，pixel(x, y) 返回 [r, g, b, a] */
function makeImage(w, h, pixel) {
  const d = new Uint8ClampedArray(w * h * 4)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const [r, g, b, a] = pixel(x, y)
      const i = (y * w + x) * 4
      d[i] = r
      d[i + 1] = g
      d[i + 2] = b
      d[i + 3] = a
    }
  }
  return d
}

console.log('\n-- 纯色不该被改动 --')
{
  const src = makeImage(800, 600, () => [120, 200, 60, 255])
  const out = resampleRGBA(src, 800, 600, 300, 300, { sx: 100, sy: 0, sw: 600, sh: 600 })
  let worst = 0
  for (let i = 0; i < out.length; i += 4) {
    worst = Math.max(worst, Math.abs(out[i] - 120), Math.abs(out[i + 1] - 200), Math.abs(out[i + 2] - 60))
    assert.equal(out[i + 3], 255)
  }
  ok(worst <= 1, `纯色缩完还是同一个颜色（最大偏差 ${worst}）`)
}

console.log('\n-- 抗锯齿：1px 竖条纹压 4 倍 --')
{
  // 源频率正好在奈奎斯特上：正确滤波会把它整体抹成中灰；窗口不张大则会留下明显条纹
  const src = makeImage(400, 400, (x) => (x % 2 === 0 ? [0, 0, 0, 255] : [255, 255, 255, 255]))
  const out = resampleRGBA(src, 400, 400, 100, 100)
  let worst = 0
  for (let i = 0; i < out.length; i += 4) worst = Math.max(worst, Math.abs(out[i] - 128))
  ok(worst < 20, `条纹被滤成了均匀灰（离中灰最远 ${worst}，欠采样时会大于 100）`)
}

console.log('\n-- 边缘不该有振铃 --')
{
  // 左黑右白的硬边。Lanczos 有负瓣，边上出现一点点过冲是正常的（那正是它锐的原因），
  // 但过冲必须被钳在 0..255 内，而且不能出现「黑边里冒出一条更黑的线」那种明显的重影。
  const src = makeImage(600, 8, (x) => (x < 300 ? [0, 0, 0, 255] : [255, 255, 255, 255]))
  const out = resampleRGBA(src, 600, 8, 150, 8)
  const row = 4
  let leftFlat = true
  // 离边界足够远的地方必须是干净的纯黑 / 纯白
  for (let x = 0; x < 60; x++) if (out[(row * 150 + x) * 4] !== 0) leftFlat = false
  let rightFlat = true
  for (let x = 90; x < 150; x++) if (out[(row * 150 + x) * 4] !== 255) rightFlat = false
  ok(leftFlat && rightFlat, '远离边界处是干净的纯黑 / 纯白，没有一圈圈的振铃')
}

console.log('\n-- 透明边缘不能渗色（预乘 alpha）--')
{
  // 左半：不透明白。右半：全透明的黑（PNG 里最常见的那种「看不见但 RGB 是黑」）
  const src = makeImage(400, 400, (x) => (x < 200 ? [255, 255, 255, 255] : [0, 0, 0, 0]))
  const out = resampleRGBA(src, 400, 400, 100, 100)
  let worst = 255
  let checked = 0
  for (let i = 0; i < out.length; i += 4) {
    if (out[i + 3] > 8) {
      worst = Math.min(worst, out[i])
      checked++
    }
  }
  ok(checked > 0, '确实有不透明的像素可供检查')
  ok(worst >= 250, `所有还看得见的像素都还是白的（最暗 ${worst}；不预乘会在交界处渗出灰边）`)
}

console.log('\n-- 居中裁切 --')
ok(JSON.stringify(centerSquare(400, 300)) === JSON.stringify({ sx: 50, sy: 0, size: 300 }), '横图从左右各切掉 50')
ok(JSON.stringify(centerSquare(300, 400)) === JSON.stringify({ sx: 0, sy: 50, size: 300 }), '竖图从上下各切掉 50')
ok(JSON.stringify(centerSquare(256, 256)) === JSON.stringify({ sx: 0, sy: 0, size: 256 }), '正方形原样不动')

console.log('\n-- 裁切区域真的被用上了 --')
{
  // 左半红右半蓝，只取右半 -> 结果应该全是蓝的。裁切参数要是被忽略，这里会是紫的
  const src = makeImage(200, 100, (x) => (x < 100 ? [255, 0, 0, 255] : [0, 0, 255, 255]))
  const out = resampleRGBA(src, 200, 100, 50, 50, { sx: 100, sy: 0, sw: 100, sh: 100 })
  let maxRed = 0
  for (let i = 0; i < out.length; i += 4) maxRed = Math.max(maxRed, out[i])
  ok(maxRed <= 2, `只取右半时结果里没有红色（最大红分量 ${maxRed}）`)
}

console.log('\n-- 极端尺寸不崩 --')
{
  const one = resampleRGBA(makeImage(1, 1, () => [10, 20, 30, 255]), 1, 1, 300, 300)
  ok(one[0] === 10 && one[1] === 20 && one[2] === 30 && one[3] === 255, '1×1 放大到 300×300 不出 NaN')
  const thin = resampleRGBA(makeImage(1000, 1, () => [40, 40, 40, 255]), 1000, 1, 300, 300)
  ok(thin[0] === 40, '1 像素高的长条也能缩')
}

console.log(`\n全部通过（${n} 项）`)
