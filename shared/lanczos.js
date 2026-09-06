/**
 * Lanczos 重采样 —— 后台压封面用的那套算法本体。
 *
 * 为什么单独放在 shared/ 的纯 .js 里：浏览器那边（src/lib/imageResize.ts）负责
 * 拿像素、编码 WebP，算法本身不碰任何 DOM，放这儿才能被 node 直接跑测试
 * （见 [[本地环境限制]]：把算法本体放进 shared/ 是让测试摆脱 esbuild 的通用办法）。
 *
 * 实现刻意对齐 Pillow 的 `Image.LANCZOS`（`precompute_coeffs`）——
 * 用户要的就是「LANCZOS 高质量缩放」那个效果，自己另发明一套没有意义。
 * 两个细节是这套算法的全部要害，缺一个出来的图就不是 Lanczos：
 *
 *   1. 核是 **两个 sinc 相乘**：L(x) = sinc(x)·sinc(x/a)。
 *      写成相除的话 x→a 时分母趋近 0，权重不衰减反而涨到 1 附近，
 *      远处像素和中心像素一样重 —— 出来的是一圈一圈的振铃和重影。
 *   2. **缩小时滤波半径要跟着放大**：把 1200 压到 300 时，一个目标像素背后
 *      是 4 个源像素，滤波窗口必须张到 ±3×4 个源像素。窗口不放大就等于
 *      只挑了中间那几个源像素、其余全丢 —— 那是最典型的欠采样，
 *      细密纹理会糊成摩尔纹，质量还不如浏览器自带的 drawImage。
 */

/** Lanczos 的默认半径（a=3，也就是常说的 Lanczos3 / Pillow 的 LANCZOS） */
export const LANCZOS_RADIUS = 3

/**
 * Lanczos 核：L(x) = sinc(x)·sinc(x/a)，|x| ≥ a 处为 0。
 *
 * 展开成 a·sin(πx)·sin(πx/a) / (πx)² 是为了少算两次除法，
 * 数学上和两个 sinc 相乘完全等价。
 *
 * @param {number} x       与采样中心的距离（源像素为单位）
 * @param {number} [radius] 半径 a
 * @returns {number} 权重，可能为负（Lanczos 本来就有负瓣，锐度就是从这儿来的）
 */
export function lanczos(x, radius = LANCZOS_RADIUS) {
  if (x === 0) return 1
  const ax = x < 0 ? -x : x
  if (ax >= radius) return 0
  const px = Math.PI * x
  return (radius * Math.sin(px) * Math.sin(px / radius)) / (px * px)
}

/**
 * 预算一趟（一个维度）的采样权重表。
 *
 * @param {number} srcLen   源在这个维度上的总长度（像素）
 * @param {number} dstLen   目标长度
 * @param {number} radius   Lanczos 半径
 * @param {number} [offset] 只从源的 [offset, offset+span) 采样（裁切用）
 * @param {number} [span]   同上，默认整条
 * @returns {{ starts: Int32Array, counts: Int32Array, weights: Float32Array, ksize: number }}
 */
export function buildWeights(srcLen, dstLen, radius, offset = 0, span = srcLen) {
  // >1 表示缩小。Pillow 的 filterscale 就是这个数，也是滤波窗口要张大的倍数。
  const scale = span / dstLen
  const filterScale = scale < 1 ? 1 : scale
  const support = radius * filterScale
  const ksize = Math.ceil(support) * 2 + 1

  const starts = new Int32Array(dstLen)
  const counts = new Int32Array(dstLen)
  const weights = new Float32Array(dstLen * ksize)
  // 核参数要按 filterScale 归一，否则窗口张大了、核却还按原半径衰减
  const inv = 1 / filterScale

  /**
   * 采样范围钳在**裁切区域内**，而不是整幅源图内。
   *
   * Pillow 的 box 参数是钳在整幅图上的，也就是说滤波窗口会越过 box 的边界去读
   * 被裁掉的那部分。对「居中裁一刀」来说那是错的：右半边的第一列会渗进左半边的颜色。
   * 一列而已，但那一列正好在封面的边上，最显眼。
   */
  const lo = Math.max(0, Math.min(srcLen, offset))
  const hi = Math.max(lo, Math.min(srcLen, offset + span))

  for (let i = 0; i < dstLen; i++) {
    const center = offset + (i + 0.5) * scale
    let min = Math.floor(center - support + 0.5)
    if (min < lo) min = lo
    let max = Math.floor(center + support + 0.5)
    if (max > hi) max = hi
    const count = Math.max(1, max - min)

    let sum = 0
    const base = i * ksize
    for (let k = 0; k < count; k++) {
      const w = lanczos((k + min - center + 0.5) * inv, radius)
      weights[base + k] = w
      sum += w
    }
    /**
     * 归一化。sum 理论上恒为正，但极端窄的窗口（1×1 源图之类）可能算出 0；
     * 那时退回「中心那个像素权重 1」，总比整幅图除出 NaN 变全黑强。
     */
    if (sum !== 0) {
      for (let k = 0; k < count; k++) weights[base + k] /= sum
    } else {
      weights[base] = 1
    }
    starts[i] = min
    counts[i] = count
  }

  return { starts, counts, weights, ksize }
}

/**
 * 可分离 Lanczos 重采样（先横后竖），输入输出都是 RGBA 的 Uint8ClampedArray。
 *
 * ⚠️ 内部按**预乘 alpha** 计算。不预乘的话，全透明像素里那些没意义的 RGB
 * （PNG 里经常是纯黑或纯白）会照样参与加权，透明边缘会渗出一圈黑边或白边。
 *
 * @param {Uint8ClampedArray|Uint8Array} src 源像素（RGBA，长度 srcW*srcH*4）
 * @param {number} srcW
 * @param {number} srcH
 * @param {number} dstW
 * @param {number} dstH
 * @param {{radius?:number, sx?:number, sy?:number, sw?:number, sh?:number}} [opts]
 *        sx/sy/sw/sh 指定只重采样源图的某个矩形（居中裁切就靠它，不用先复制一张）
 * @returns {Uint8ClampedArray} 目标像素（RGBA，长度 dstW*dstH*4）
 */
export function resampleRGBA(src, srcW, srcH, dstW, dstH, opts = {}) {
  const radius = opts.radius ?? LANCZOS_RADIUS
  const sx = Math.max(0, Math.min(srcW, Math.round(opts.sx ?? 0)))
  const sy = Math.max(0, Math.min(srcH, Math.round(opts.sy ?? 0)))
  const sw = Math.max(1, Math.min(srcW - sx, Math.round(opts.sw ?? srcW - sx)))
  const sh = Math.max(1, Math.min(srcH - sy, Math.round(opts.sh ?? srcH - sy)))

  const hx = buildWeights(srcW, dstW, radius, sx, sw)
  const vy = buildWeights(srcH, dstH, radius, sy, sh)

  /**
   * 横向一趟的中间结果。只覆盖裁切用到的那几行（rowTop..rowBottom），
   * 整幅源图有 8000 行、裁切只用中间 3000 行时，能省掉一多半内存。
   */
  const rowTop = vy.starts[0]
  let rowBottom = 0
  for (let i = 0; i < dstH; i++) {
    const end = vy.starts[i] + vy.counts[i]
    if (end > rowBottom) rowBottom = end
  }
  const rows = rowBottom - rowTop
  const mid = new Float32Array(dstW * rows * 4)

  for (let y = 0; y < rows; y++) {
    const srcRow = (y + rowTop) * srcW * 4
    const midRow = y * dstW * 4
    for (let x = 0; x < dstW; x++) {
      const start = hx.starts[x]
      const count = hx.counts[x]
      const wBase = x * hx.ksize
      let r = 0
      let g = 0
      let b = 0
      let a = 0
      for (let k = 0; k < count; k++) {
        const w = hx.weights[wBase + k]
        if (w === 0) continue
        const si = srcRow + (start + k) * 4
        // 预乘：RGB 先乘上自己的 alpha 再参与加权
        const al = src[si + 3]
        const pw = w * al
        r += src[si] * pw
        g += src[si + 1] * pw
        b += src[si + 2] * pw
        a += al * w
      }
      const mi = midRow + x * 4
      mid[mi] = r
      mid[mi + 1] = g
      mid[mi + 2] = b
      mid[mi + 3] = a
    }
  }

  const out = new Uint8ClampedArray(dstW * dstH * 4)
  for (let y = 0; y < dstH; y++) {
    const start = vy.starts[y] - rowTop
    const count = vy.counts[y]
    const wBase = y * vy.ksize
    const outRow = y * dstW * 4
    for (let x = 0; x < dstW; x++) {
      let r = 0
      let g = 0
      let b = 0
      let a = 0
      for (let k = 0; k < count; k++) {
        const w = vy.weights[wBase + k]
        if (w === 0) continue
        const mi = ((start + k) * dstW + x) * 4
        r += mid[mi] * w
        g += mid[mi + 1] * w
        b += mid[mi + 2] * w
        a += mid[mi + 3] * w
      }
      const oi = outRow + x * 4
      /**
       * 还原预乘。a 可能因为负瓣算成微小的负数或者 0 —— 那时 RGB 没有意义，
       * 直接给全透明黑，别去除一个接近 0 的数（会炸出满屏噪点）。
       */
      if (a > 0.5) {
        out[oi] = r / a
        out[oi + 1] = g / a
        out[oi + 2] = b / a
        out[oi + 3] = a
      } else {
        out[oi] = 0
        out[oi + 1] = 0
        out[oi + 2] = 0
        out[oi + 3] = 0
      }
    }
  }

  return out
}

/**
 * 居中裁出最大的正方形。原图本来就是正方形时返回整幅（不做任何裁切）。
 *
 * @param {number} w
 * @param {number} h
 * @returns {{sx:number, sy:number, size:number}}
 */
export function centerSquare(w, h) {
  const size = Math.min(w, h)
  return { sx: Math.floor((w - size) / 2), sy: Math.floor((h - size) / 2), size }
}
