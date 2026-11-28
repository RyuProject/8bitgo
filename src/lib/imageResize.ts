/**
 * 后台上传封面图时，把原图压成 300×300 的 WebP（quality=60）再丢给 R2。
 *
 * 为什么在前端压、为什么自己写 LANCZOS：
 * 站点没有图片处理服务，封面是浏览器直接 PUT 给 Worker 的，后端不碰二进制。
 * 浏览器原生的 canvas 缩放只是双线性近似，达不到「高质量」；用户明确要 LANCZOS，
 * 所以算法本体写在 shared/lanczos.js（对齐 Pillow 的 Image.LANCZOS），这里只负责
 * 取像素、裁切、编码。
 *
 * 三个容易被忽略、但都真的会咬人的地方：
 *
 *   1. **非正方形要居中裁切，不能拉伸。** 前台卡片是 object-cover 的 1:1 方框，
 *      裁切出来的结果和现在肉眼看到的完全一致；拉伸则会把竖版盒绘压扁，
 *      而且压扁之后再被 object-cover 裁一次，等于错两遍。
 *   2. **超大原图先降一档再 Lanczos。** 一是 Safari / iOS 的 canvas 面积上限
 *      （约 16.7M 像素）会让 6000×6000 的图 getImageData 直接拿到空白；
 *      二是纯 JS 的 Lanczos 是按源像素数线性增长的，4000×4000 要跑好几秒。
 *      先用浏览器的高质量缩放降到目标的 4 倍（1200），再交给 Lanczos —— 肉眼没有差别。
 *   3. **toBlob 不支持 WebP 时会静默退回 PNG。** 规范就是这么写的（类型不认识就当
 *      image/png），blob 不为 null，所以「编码失败」的判断根本抓不住它 ——
 *      结果是 .webp 的 key 里装着 PNG 字节。这里必须查 blob.type，
 *      对不上就退成 JPEG 并把扩展名一起换掉。
 */
import { centerSquare, resampleRGBA } from '../../shared/lanczos.js'

/** R2 只存一份 300px 方形主图；480 响应档在 CDN 插值放大，不另存大图占容量。 */
const TARGET = 300
/** WebP 质量。0.6 = quality 60 */
const QUALITY = 0.6
/** 退回 JPEG 时的质量。JPEG 在同等观感下要比 WebP 高一点才不出块 */
const JPEG_QUALITY = 0.82
/**
 * 交给 Lanczos 之前允许的最大边长。取目标的 4 倍：
 * 再大对最终 300×300 的观感已经没有贡献，只是白烧 CPU 和内存。
 */
const PRE_MAX = TARGET * 4

export interface CompressedImage {
  /** 压好的图片数据 */
  blob: Blob
  /** 对应的扩展名，**必须**用它来拼 key，别写死 .webp（见文件头第 3 条） */
  ext: '.webp' | '.jpg'
  /** 浏览器不支持 WebP 编码、退回 JPEG 了。调用方应该把这件事显示给管理员 */
  fellBackToJpeg: boolean
  /** 原图尺寸，给提示文案用 */
  sourceWidth: number
  sourceHeight: number
}

function toBlobAsync(canvas: HTMLCanvasElement, type: string, quality: number): Promise<Blob | null> {
  return new Promise((resolve) => canvas.toBlob(resolve, type, quality))
}

type DecodedImage = {
  source: CanvasImageSource
  width: number
  height: number
  close: () => void
}

/**
 * createImageBitmap 到 Safari 15 才算稳定，旧 iPhone 退回 <img> + object URL。
 * 两条路统一成 CanvasImageSource，后面的裁切和编码不用分叉。
 */
async function decodeImage(file: Blob): Promise<DecodedImage> {
  if (typeof createImageBitmap === 'function') {
    try {
      const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' })
      return {
        source: bitmap,
        width: bitmap.width,
        height: bitmap.height,
        close: () => bitmap.close?.(),
      }
    } catch {
      // 有些 WebKit 暴露了函数却不接受 imageOrientation；直接走兼容路径比重试参数更稳。
    }
  }

  const url = URL.createObjectURL(file)
  const image = new Image()
  image.decoding = 'async'
  try {
    await new Promise<void>((resolve, reject) => {
      image.onload = () => resolve()
      image.onerror = () => reject(new Error('图片解码失败'))
      image.src = url
    })
  } catch (error) {
    URL.revokeObjectURL(url)
    throw error
  }
  return {
    source: image,
    width: image.naturalWidth,
    height: image.naturalHeight,
    close: () => {
      image.src = ''
      URL.revokeObjectURL(url)
    },
  }
}

/** 只读尺寸也共用同一条兼容解码路径，避免后台预检把旧 Safari 的合法图片误判成未知。 */
export async function readImageDimensions(file: Blob): Promise<{ width: number; height: number }> {
  const decoded = await decodeImage(file)
  try {
    return { width: decoded.width, height: decoded.height }
  } finally {
    decoded.close()
  }
}

/** 建一个 2D 画布；拿不到上下文一律当浏览器不支持，报人话 */
function makeCanvas(w: number, h: number): { canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D } {
  const canvas = document.createElement('canvas')
  canvas.width = w
  canvas.height = h
  const ctx = canvas.getContext('2d', { willReadFrequently: true })
  if (!ctx) throw new Error('浏览器不支持 2D 画布，无法压缩封面')
  return { canvas, ctx }
}

/**
 * 把任意图片压成 300×300 的正方形封面。
 *
 * 非正方形按短边**居中裁切**（不拉伸、不留白）。带透明通道的图会保留透明，
 * 除非退回了 JPEG —— JPEG 没有 alpha，那时透明处按白色合成。
 *
 * @throws 图片解不开、画布不可用、编码全部失败时抛 Error，消息可直接显示给管理员
 */
export async function compressCoverToWebp(file: Blob): Promise<CompressedImage> {
  let decoded: DecodedImage
  try {
    decoded = await decodeImage(file)
  } catch {
    throw new Error('这个文件解不开，换一张 PNG / JPG / WebP 试试（SVG 和动图可能不受支持）')
  }
  let decodedClosed = false
  const closeDecoded = () => {
    if (decodedClosed) return
    decodedClosed = true
    decoded.close()
  }

  try {
    const srcW = decoded.width
    const srcH = decoded.height
    if (!srcW || !srcH) throw new Error('图片尺寸为 0，文件可能已损坏')

    // 1) 居中裁出正方形；同时把过大的原图降到 PRE_MAX，两步在一次 drawImage 里做完
    const crop = centerSquare(srcW, srcH)
    const stage = Math.min(crop.size, PRE_MAX)
    const { canvas: stageCanvas, ctx: sctx } = makeCanvas(stage, stage)
    sctx.imageSmoothingEnabled = true
    sctx.imageSmoothingQuality = 'high'
    sctx.drawImage(decoded.source, crop.sx, crop.sy, crop.size, crop.size, 0, 0, stage, stage)
    // 源图已画进中间画布，尽早关闭解码位图，避免它与像素缓冲同时占内存。
    closeDecoded()

    // 2) Lanczos3 缩到 300×300（stage 已经是正方形，所以这里只是等比缩小）
    const rgba = (() => {
      const stagedImage = sctx.getImageData(0, 0, stage, stage)
      // 1200×1200 中间画布约占 5.5 MiB；像素已复制出来，立即释放其 backing store，
      // 避免它和 ImageData、Lanczos 输出及最终编码画布同时占内存。
      stageCanvas.width = 0
      stageCanvas.height = 0
      return resampleRGBA(stagedImage.data, stage, stage, TARGET, TARGET)
    })()

    const { canvas: dest, ctx: dctx } = makeCanvas(TARGET, TARGET)
    // 先建好 ImageData 再 set：绕开 new ImageData(data,…) 对底层 ArrayBuffer 类型的苛刻要求
    const img = new ImageData(TARGET, TARGET)
    img.data.set(rgba)
    dctx.putImageData(img, 0, 0)

    // 3) 编码。WebP 不被支持时 toBlob 会**静默**给一张 PNG，所以要查 type
    const webp = await toBlobAsync(dest, 'image/webp', QUALITY)
    if (webp && webp.type === 'image/webp') {
      dest.width = 0
      dest.height = 0
      return {
        blob: webp,
        ext: '.webp',
        fellBackToJpeg: false,
        sourceWidth: srcW,
        sourceHeight: srcH,
      }
    }

    // JPEG 没有 alpha：先铺白底再合成，否则透明处会变成黑块
    const { canvas: flat, ctx: fctx } = makeCanvas(TARGET, TARGET)
    fctx.fillStyle = '#ffffff'
    fctx.fillRect(0, 0, TARGET, TARGET)
    fctx.drawImage(dest, 0, 0)
    dest.width = 0
    dest.height = 0
    const jpeg = await toBlobAsync(flat, 'image/jpeg', JPEG_QUALITY)
    flat.width = 0
    flat.height = 0
    if (!jpeg) throw new Error('封面编码失败：这个浏览器既不支持 WebP 也不支持 JPEG 编码')

    return {
      blob: jpeg,
      ext: '.jpg',
      fellBackToJpeg: true,
      sourceWidth: srcW,
      sourceHeight: srcH,
    }
  } finally {
    closeDecoded()
  }
}
