/**
 * 没有 WebGL 的浏览器上，给 EmulatorJS 的 RetroArch 一个「画在 2D canvas 上的假 WebGL1」。
 *
 * 为什么要有它（2026-11-13，大陆 Linux Chrome 108 / Android 12 Chrome 123，18 次「无法建立 WebGL 画面」）：
 * EmulatorJS 的核心只编进了 RetroArch 的 GL 视频驱动，建不出 WebGL 就是 `reading 'GLctx'`，
 * 播放器只能告诉玩家「打开硬件加速」。可这批机器整机就没有 WebGL（国产 Linux 发行版自带的 Chromium、
 * 车机 / 盒子的 WebView），没有设置可开。NES 与 GB/GBC 已分别改走 jsnes / binjgb；街机仍沿用
 * EmulatorJS 的核心和 ROM 流程，只给已选 FBNeo legacy 核心试这层有限的 Canvas 2D 画面后备。
 *
 * 能做成的前提：这些平台的核心都是**软件渲染**，RetroArch 每帧只做一件事——把核心交出来的像素
 * texSubImage2D 进一张纹理，再画一个铺满视口的四边形（菜单 / 字体也是贴图四边形）。
 * 所以不用实现着色器：记下每张纹理的像素、每个缓冲区的字节，drawArrays 时从顶点坐标 × MVP
 * 算出四边形落在画布上的位置、从纹理坐标算出取哪一块，用 2D canvas 的仿射变换 drawImage 过去。
 * 旋转（竖版街机）也是仿射，一并覆盖。
 *
 * 不支持的：自定义着色器的效果（照原图画）、帧缓冲对象（离屏渲染直接丢弃）、顶点颜色调制。
 * 只给 legacy（WebGL1 / GLES2）核心用；要 WebGL2 的核心（mame-current、PS1 HW、NDS…）不装。
 */

type Win = Window & typeof globalThis

// —— GL 常量（只列用到的）——
const GL = {
  NO_ERROR: 0,
  POINTS: 0, LINES: 1, TRIANGLES: 4, TRIANGLE_STRIP: 5, TRIANGLE_FAN: 6,
  DEPTH_BUFFER_BIT: 0x100, COLOR_BUFFER_BIT: 0x4000,
  BLEND: 0x0be2, SCISSOR_TEST: 0x0c11,
  ARRAY_BUFFER: 0x8892, ELEMENT_ARRAY_BUFFER: 0x8893,
  ARRAY_BUFFER_BINDING: 0x8894, ELEMENT_ARRAY_BUFFER_BINDING: 0x8895,
  BYTE: 0x1400, UNSIGNED_BYTE: 0x1401, SHORT: 0x1402, UNSIGNED_SHORT: 0x1403, INT: 0x1404, UNSIGNED_INT: 0x1405, FLOAT: 0x1406,
  UNSIGNED_SHORT_4_4_4_4: 0x8033, UNSIGNED_SHORT_5_5_5_1: 0x8034, UNSIGNED_SHORT_5_6_5: 0x8363,
  ALPHA: 0x1906, RGB: 0x1907, RGBA: 0x1908, LUMINANCE: 0x1909, LUMINANCE_ALPHA: 0x190a,
  TEXTURE_2D: 0x0de1, TEXTURE0: 0x84c0, TEXTURE_MAG_FILTER: 0x2800, NEAREST: 0x2600,
  TEXTURE_BINDING_2D: 0x8069, ACTIVE_TEXTURE: 0x84e0,
  FRAMEBUFFER: 0x8d40, FRAMEBUFFER_COMPLETE: 0x8cd5, FRAMEBUFFER_BINDING: 0x8ca6, RENDERBUFFER_BINDING: 0x8ca7,
  CURRENT_PROGRAM: 0x8b8d, VIEWPORT: 0x0ba2, SCISSOR_BOX: 0x0c10, COLOR_CLEAR_VALUE: 0x0c22,
  MAX_TEXTURE_SIZE: 0x0d33, MAX_VIEWPORT_DIMS: 0x0d3a, MAX_RENDERBUFFER_SIZE: 0x84e8,
  MAX_VERTEX_ATTRIBS: 0x8869, MAX_TEXTURE_IMAGE_UNITS: 0x8872, MAX_COMBINED_TEXTURE_IMAGE_UNITS: 0x8b4d,
  MAX_VERTEX_TEXTURE_IMAGE_UNITS: 0x8b4c, MAX_VERTEX_UNIFORM_VECTORS: 0x8dfb, MAX_FRAGMENT_UNIFORM_VECTORS: 0x8dfd,
  MAX_VARYING_VECTORS: 0x8dfc, MAX_CUBE_MAP_TEXTURE_SIZE: 0x851c,
  VENDOR: 0x1f00, RENDERER: 0x1f01, VERSION: 0x1f02, SHADING_LANGUAGE_VERSION: 0x8b8c,
  UNPACK_ALIGNMENT: 0x0cf5, PACK_ALIGNMENT: 0x0d05,
  RED_BITS: 0x0d52, GREEN_BITS: 0x0d53, BLUE_BITS: 0x0d54, ALPHA_BITS: 0x0d55, DEPTH_BITS: 0x0d56, STENCIL_BITS: 0x0d57,
  SUBPIXEL_BITS: 0x0d50, SAMPLES: 0x80a9, SAMPLE_BUFFERS: 0x80a8,
  IMPLEMENTATION_COLOR_READ_FORMAT: 0x8b9b, IMPLEMENTATION_COLOR_READ_TYPE: 0x8b9a,
  COMPILE_STATUS: 0x8b81, LINK_STATUS: 0x8b82, DELETE_STATUS: 0x8b80, VALIDATE_STATUS: 0x8b83,
  SHADER_TYPE: 0x8b4f, ATTACHED_SHADERS: 0x8b85, ACTIVE_ATTRIBUTES: 0x8b89, ACTIVE_UNIFORMS: 0x8b86,
  BUFFER_SIZE: 0x8764,
} as const

interface FakeObject { kind: string; name?: number }
interface TexObj extends FakeObject {
  kind: 'texture'
  w: number
  h: number
  data: Uint8ClampedArray | null
  canvas: HTMLCanvasElement | null
  opaque: HTMLCanvasElement | null
  dirty: boolean
  smooth: boolean
}
interface BufObj extends FakeObject { kind: 'buffer'; bytes: Uint8Array }
interface ProgObj extends FakeObject {
  kind: 'program'
  attribs: Map<string, number>
  uniforms: Map<string, Float32Array | number[] | number>
}
interface UniformLoc { kind: 'uniform'; program: ProgObj; name: string }
interface AttribPtr { buffer: BufObj | null; size: number; type: number; normalized: boolean; stride: number; offset: number }

const TYPE_BYTES: Record<number, number> = { [GL.BYTE]: 1, [GL.UNSIGNED_BYTE]: 1, [GL.SHORT]: 2, [GL.UNSIGNED_SHORT]: 2, [GL.INT]: 4, [GL.UNSIGNED_INT]: 4, [GL.FLOAT]: 4 }

/** 把一行一行的像素数据（各种 GL 格式）转成 RGBA8 */
export function convertPixels(
  src: ArrayBufferView,
  w: number,
  h: number,
  format: number,
  type: number,
  alignment: number,
): Uint8ClampedArray {
  const out = new Uint8ClampedArray(w * h * 4)
  const bytes = new Uint8Array(src.buffer, src.byteOffset, src.byteLength)
  let bpp: number
  if (type === GL.UNSIGNED_SHORT_5_6_5 || type === GL.UNSIGNED_SHORT_4_4_4_4 || type === GL.UNSIGNED_SHORT_5_5_5_1) bpp = 2
  else if (format === GL.RGBA) bpp = 4
  else if (format === GL.RGB) bpp = 3
  else if (format === GL.LUMINANCE_ALPHA) bpp = 2
  else bpp = 1
  const rowBytes = w * bpp
  const stride = Math.ceil(rowBytes / alignment) * alignment
  for (let y = 0; y < h; y++) {
    let s = y * stride
    let d = y * w * 4
    if (s + rowBytes > bytes.length) break
    for (let x = 0; x < w; x++, d += 4) {
      if (bpp === 2 && type !== GL.UNSIGNED_BYTE) {
        const v = bytes[s] | (bytes[s + 1] << 8)
        s += 2
        if (type === GL.UNSIGNED_SHORT_5_6_5) {
          const r = v >> 11, g = (v >> 5) & 63, b = v & 31
          out[d] = (r << 3) | (r >> 2); out[d + 1] = (g << 2) | (g >> 4); out[d + 2] = (b << 3) | (b >> 2); out[d + 3] = 255
        } else if (type === GL.UNSIGNED_SHORT_4_4_4_4) {
          out[d] = (v >> 12) * 17; out[d + 1] = ((v >> 8) & 15) * 17; out[d + 2] = ((v >> 4) & 15) * 17; out[d + 3] = (v & 15) * 17
        } else {
          const r = v >> 11, g = (v >> 6) & 31, b = (v >> 1) & 31
          out[d] = (r << 3) | (r >> 2); out[d + 1] = (g << 3) | (g >> 2); out[d + 2] = (b << 3) | (b >> 2); out[d + 3] = v & 1 ? 255 : 0
        }
      } else if (format === GL.RGBA) {
        out[d] = bytes[s]; out[d + 1] = bytes[s + 1]; out[d + 2] = bytes[s + 2]; out[d + 3] = bytes[s + 3]; s += 4
      } else if (format === GL.RGB) {
        out[d] = bytes[s]; out[d + 1] = bytes[s + 1]; out[d + 2] = bytes[s + 2]; out[d + 3] = 255; s += 3
      } else if (format === GL.LUMINANCE_ALPHA) {
        out[d] = out[d + 1] = out[d + 2] = bytes[s]; out[d + 3] = bytes[s + 1]; s += 2
      } else if (format === GL.LUMINANCE) {
        out[d] = out[d + 1] = out[d + 2] = bytes[s]; out[d + 3] = 255; s += 1
      } else {
        // ALPHA：字体图集。GL 里 rgb 由顶点颜色给，这里当白字
        out[d] = out[d + 1] = out[d + 2] = 255; out[d + 3] = bytes[s]; s += 1
      }
    }
  }
  return out
}

/**
 * 由三个顶点求「纹理像素坐标 → 画布坐标」的仿射变换 [a, b, c, d, e, f]
 * （x' = a·u + c·v + e，y' = b·u + d·v + f，和 setTransform 的参数顺序一致）。退化时返回 null。
 */
export function affineFromTriangle(
  t: readonly [number, number][],
  p: readonly [number, number][],
): [number, number, number, number, number, number] | null {
  const du1 = t[1][0] - t[0][0], dv1 = t[1][1] - t[0][1]
  const du2 = t[2][0] - t[0][0], dv2 = t[2][1] - t[0][1]
  const det = du1 * dv2 - du2 * dv1
  if (!det || !Number.isFinite(det)) return null
  const dx1 = p[1][0] - p[0][0], dy1 = p[1][1] - p[0][1]
  const dx2 = p[2][0] - p[0][0], dy2 = p[2][1] - p[0][1]
  // [a c; b d] = D · M⁻¹，M = [du1 du2; dv1 dv2]
  const a = (dx1 * dv2 - dx2 * dv1) / det
  const c = (dx2 * du1 - dx1 * du2) / det
  const b = (dy1 * dv2 - dy2 * dv1) / det
  const d = (dy2 * du1 - dy1 * du2) / det
  const e = p[0][0] - a * t[0][0] - c * t[0][1]
  const f = p[0][1] - b * t[0][0] - d * t[0][1]
  return [a, b, c, d, e, f]
}

function createSoftwareContext(canvas: HTMLCanvasElement, ctx2d: CanvasRenderingContext2D, attrs: Record<string, unknown>) {
  const doc = canvas.ownerDocument
  // 模拟器挂在 srcdoc iframe 里；ImageData 也要从画布所属窗口取，避免跨 realm 的 DOM 品牌检查拒收。
  const ImageDataCtor = doc.defaultView?.ImageData ?? ImageData
  let nextName = 1
  const make = <T extends FakeObject>(o: T): T => o

  let viewport = [0, 0, canvas.width, canvas.height]
  let scissor = [0, 0, canvas.width, canvas.height]
  let clearColor = [0, 0, 0, 0]
  let blend = false
  let scissorTest = false
  let program: ProgObj | null = null
  let arrayBuffer: BufObj | null = null
  let elementBuffer: BufObj | null = null
  let framebuffer: FakeObject | null = null
  let renderbuffer: FakeObject | null = null
  let activeUnit = 0
  const units: (TexObj | null)[] = new Array(16).fill(null)
  const attribs: (AttribPtr | null)[] = new Array(16).fill(null)
  let unpackAlignment = 4

  const texCanvas = (tex: TexObj, opaque: boolean): HTMLCanvasElement | null => {
    if (!tex.data || !tex.w || !tex.h) return null
    if (tex.dirty) {
      tex.dirty = false
      if (!tex.canvas) tex.canvas = doc.createElement('canvas')
      if (tex.canvas.width !== tex.w || tex.canvas.height !== tex.h) {
        tex.canvas.width = tex.w
        tex.canvas.height = tex.h
      }
      tex.canvas.getContext('2d')!.putImageData(new ImageDataCtor(tex.data as Uint8ClampedArray<ArrayBuffer>, tex.w, tex.h), 0, 0)
      tex.opaque = null
    }
    if (!opaque) return tex.canvas
    /*
      混合关着时 GL 不看 alpha。XRGB8888 在 GLES 上被 RetroArch 现场转成 ABGR，X 位往往是 0，
      照原样画就是全透明。按「不透明」另备一份。
    */
    if (!tex.opaque) {
      let hasAlpha = false
      for (let i = 3; i < tex.data.length; i += 4) if (tex.data[i] !== 255) { hasAlpha = true; break }
      if (!hasAlpha) {
        tex.opaque = tex.canvas
      } else {
        const solid = new Uint8ClampedArray(tex.data)
        for (let i = 3; i < solid.length; i += 4) solid[i] = 255
        const c = doc.createElement('canvas')
        c.width = tex.w
        c.height = tex.h
        c.getContext('2d')!.putImageData(new ImageDataCtor(solid, tex.w, tex.h), 0, 0)
        tex.opaque = c
      }
    }
    return tex.opaque
  }

  const readAttrib = (ptr: AttribPtr, index: number, out: number[]) => {
    out.length = 0
    const buf = ptr.buffer
    if (!buf) return
    const size = TYPE_BYTES[ptr.type] ?? 4
    const stride = ptr.stride || size * ptr.size
    const base = ptr.offset + index * stride
    const view = new DataView(buf.bytes.buffer, buf.bytes.byteOffset, buf.bytes.byteLength)
    for (let i = 0; i < ptr.size; i++) {
      const o = base + i * size
      if (o + size > buf.bytes.byteLength) { out.push(0); continue }
      let v: number
      switch (ptr.type) {
        case GL.FLOAT: v = view.getFloat32(o, true); break
        case GL.UNSIGNED_BYTE: v = view.getUint8(o); if (ptr.normalized) v /= 255; break
        case GL.BYTE: v = view.getInt8(o); if (ptr.normalized) v /= 127; break
        case GL.UNSIGNED_SHORT: v = view.getUint16(o, true); if (ptr.normalized) v /= 65535; break
        case GL.SHORT: v = view.getInt16(o, true); if (ptr.normalized) v /= 32767; break
        default: v = view.getFloat32(o, true)
      }
      out.push(v)
    }
  }

  const findAttrib = (re: RegExp): number => {
    if (!program) return -1
    for (const [name, loc] of program.attribs) if (re.test(name)) return loc
    return -1
  }
  const mvp = (): ArrayLike<number> | null => {
    if (!program) return null
    for (const [name, v] of program.uniforms) if (/mvp/i.test(name) && typeof v !== 'number' && v.length === 16) return v
    return null
  }
  const textureUnitForDraw = (): number => {
    if (!program) return 0
    for (const [name, v] of program.uniforms) if (/^(texture|tex|s_?texture|source)$/i.test(name) && typeof v === 'number') return v
    return 0
  }

  const toCanvas = (x: number, y: number, z: number, w: number, m: ArrayLike<number> | null): [number, number] => {
    let cx = x, cy = y, cw = 1
    if (m) {
      // GL 的矩阵是列主序
      cx = m[0] * x + m[4] * y + m[8] * z + m[12] * w
      cy = m[1] * x + m[5] * y + m[9] * z + m[13] * w
      cw = m[3] * x + m[7] * y + m[11] * z + m[15] * w
      if (cw) { cx /= cw; cy /= cw }
    }
    const [vx, vy, vw, vh] = viewport
    const px = vx + ((cx + 1) / 2) * vw
    const py = canvas.height - (vy + ((cy + 1) / 2) * vh)
    return [px, py]
  }

  const drawQuad = (indices: number[], tex: TexObj) => {
    const posLoc = findAttrib(/vertex|position|pos$/i)
    const texLoc = findAttrib(/texcoord|tex_?coord|uv/i)
    const posPtr = posLoc >= 0 ? attribs[posLoc] : null
    const texPtr = texLoc >= 0 ? attribs[texLoc] : null
    if (!posPtr || !texPtr) return
    const m = mvp()
    const pts: [number, number][] = []
    const uvs: [number, number][] = []
    const tmp: number[] = []
    for (const i of indices) {
      readAttrib(posPtr, i, tmp)
      pts.push(toCanvas(tmp[0] ?? 0, tmp[1] ?? 0, tmp[2] ?? 0, posPtr.size >= 4 ? tmp[3] ?? 1 : 1, m))
      readAttrib(texPtr, i, tmp)
      uvs.push([(tmp[0] ?? 0) * tex.w, (tmp[1] ?? 0) * tex.h])
    }
    const affine = affineFromTriangle(uvs, pts)
    if (!affine) return
    let u0 = Infinity, v0 = Infinity, u1 = -Infinity, v1 = -Infinity
    for (const [u, v] of uvs) { u0 = Math.min(u0, u); v0 = Math.min(v0, v); u1 = Math.max(u1, u); v1 = Math.max(v1, v) }
    u0 = Math.max(0, u0); v0 = Math.max(0, v0); u1 = Math.min(tex.w, u1); v1 = Math.min(tex.h, v1)
    if (u1 - u0 <= 0 || v1 - v0 <= 0) return
    const img = texCanvas(tex, !blend)
    if (!img) return
    ctx2d.save()
    if (scissorTest) {
      const [sx, sy, sw, sh] = scissor
      ctx2d.beginPath()
      ctx2d.rect(sx, canvas.height - sy - sh, sw, sh)
      ctx2d.clip()
    }
    ctx2d.imageSmoothingEnabled = tex.smooth
    ctx2d.globalCompositeOperation = 'source-over'
    ctx2d.setTransform(affine[0], affine[1], affine[2], affine[3], affine[4], affine[5])
    ctx2d.drawImage(img, u0, v0, u1 - u0, v1 - v0, u0, v0, u1 - u0, v1 - v0)
    ctx2d.restore()
  }

  const draw = (mode: number, indices: number[]) => {
    if (framebuffer) return // 离屏渲染（着色器多遍）不支持：丢掉，最后一遍画到屏幕上的照样会画
    const tex = units[textureUnitForDraw()] ?? units[0]
    if (!tex) return
    if (mode === GL.TRIANGLE_STRIP || mode === GL.TRIANGLE_FAN) {
      if (indices.length >= 3) drawQuad(indices.slice(0, Math.min(4, indices.length)), tex)
      // 更长的条带：每两个新顶点补一个四边形
      if (mode === GL.TRIANGLE_STRIP) for (let i = 2; i + 3 < indices.length; i += 2) drawQuad(indices.slice(i, i + 4), tex)
    } else if (mode === GL.TRIANGLES) {
      // 字体 / 菜单按「两个三角形一个四边形」交上来，每 6 个顶点一组；落单的 3 个也画
      for (let i = 0; i + 2 < indices.length; i += 6) drawQuad(indices.slice(i, Math.min(i + 6, indices.length)), tex)
    }
  }

  const range = (first: number, count: number) => Array.from({ length: count }, (_, i) => first + i)

  const PARAMS: Record<number, unknown> = {
    [GL.MAX_TEXTURE_SIZE]: 4096, [GL.MAX_RENDERBUFFER_SIZE]: 4096, [GL.MAX_CUBE_MAP_TEXTURE_SIZE]: 4096,
    [GL.MAX_VIEWPORT_DIMS]: new Int32Array([4096, 4096]),
    [GL.MAX_VERTEX_ATTRIBS]: 16, [GL.MAX_TEXTURE_IMAGE_UNITS]: 16, [GL.MAX_COMBINED_TEXTURE_IMAGE_UNITS]: 16,
    [GL.MAX_VERTEX_TEXTURE_IMAGE_UNITS]: 0, [GL.MAX_VERTEX_UNIFORM_VECTORS]: 256, [GL.MAX_FRAGMENT_UNIFORM_VECTORS]: 256,
    [GL.MAX_VARYING_VECTORS]: 8,
    [GL.VENDOR]: '8bitgo', [GL.RENDERER]: '8bitgo software 2D', [GL.VERSION]: 'WebGL 1.0 (8bitgo software)',
    [GL.SHADING_LANGUAGE_VERSION]: 'WebGL GLSL ES 1.0',
    [GL.RED_BITS]: 8, [GL.GREEN_BITS]: 8, [GL.BLUE_BITS]: 8, [GL.ALPHA_BITS]: 8, [GL.DEPTH_BITS]: 0, [GL.STENCIL_BITS]: 0,
    [GL.SUBPIXEL_BITS]: 4, [GL.SAMPLES]: 0, [GL.SAMPLE_BUFFERS]: 0,
    [GL.IMPLEMENTATION_COLOR_READ_FORMAT]: GL.RGBA, [GL.IMPLEMENTATION_COLOR_READ_TYPE]: GL.UNSIGNED_BYTE,
    [GL.PACK_ALIGNMENT]: 4,
  }

  const impl: Record<string, unknown> = {
    canvas,
    get drawingBufferWidth() { return canvas.width },
    get drawingBufferHeight() { return canvas.height },
    __8bitgoSoftware: true,
    getContextAttributes: () => ({ alpha: true, antialias: false, depth: false, stencil: false, premultipliedAlpha: true, preserveDrawingBuffer: true, ...attrs }),
    isContextLost: () => false,
    getError: () => GL.NO_ERROR,
    getExtension: () => null,
    getSupportedExtensions: () => [],
    getShaderPrecisionFormat: () => ({ rangeMin: 127, rangeMax: 127, precision: 23 }),
    getParameter(p: number) {
      switch (p) {
        case GL.VIEWPORT: return new Int32Array(viewport)
        case GL.SCISSOR_BOX: return new Int32Array(scissor)
        case GL.COLOR_CLEAR_VALUE: return new Float32Array(clearColor)
        case GL.CURRENT_PROGRAM: return program
        case GL.ARRAY_BUFFER_BINDING: return arrayBuffer
        case GL.ELEMENT_ARRAY_BUFFER_BINDING: return elementBuffer
        case GL.FRAMEBUFFER_BINDING: return framebuffer
        case GL.RENDERBUFFER_BINDING: return renderbuffer
        case GL.TEXTURE_BINDING_2D: return units[activeUnit]
        case GL.ACTIVE_TEXTURE: return GL.TEXTURE0 + activeUnit
        case GL.UNPACK_ALIGNMENT: return unpackAlignment
        case GL.BLEND: return blend
        case GL.SCISSOR_TEST: return scissorTest
      }
      return p in PARAMS ? PARAMS[p] : 0
    },
    enable(cap: number) { if (cap === GL.BLEND) blend = true; else if (cap === GL.SCISSOR_TEST) scissorTest = true },
    disable(cap: number) { if (cap === GL.BLEND) blend = false; else if (cap === GL.SCISSOR_TEST) scissorTest = false },
    isEnabled(cap: number) { return cap === GL.BLEND ? blend : cap === GL.SCISSOR_TEST ? scissorTest : false },
    viewport(x: number, y: number, w: number, h: number) { viewport = [x, y, w, h] },
    scissor(x: number, y: number, w: number, h: number) { scissor = [x, y, w, h] },
    clearColor(r: number, g: number, b: number, a: number) { clearColor = [r, g, b, a] },
    clear(mask: number) {
      if (!(mask & GL.COLOR_BUFFER_BIT) || framebuffer) return
      ctx2d.save()
      ctx2d.setTransform(1, 0, 0, 1, 0, 0)
      const [r, g, b] = clearColor
      ctx2d.fillStyle = `rgb(${Math.round(r * 255)},${Math.round(g * 255)},${Math.round(b * 255)})`
      if (scissorTest) {
        const [sx, sy, sw, sh] = scissor
        ctx2d.fillRect(sx, canvas.height - sy - sh, sw, sh)
      } else {
        ctx2d.fillRect(0, 0, canvas.width, canvas.height)
      }
      ctx2d.restore()
    },
    // —— 着色器：不编译，只记属性 / uniform 名字 ——
    createShader: (type: number) => make({ kind: 'shader', type, source: '' }),
    shaderSource(sh: { source: string }, src: string) { if (sh) sh.source = src },
    compileShader() {},
    getShaderParameter(_s: unknown, p: number) { return p === GL.COMPILE_STATUS ? true : p === GL.DELETE_STATUS ? false : 0 },
    getShaderInfoLog: () => '',
    getShaderSource: (sh: { source: string }) => sh?.source ?? '',
    deleteShader() {},
    createProgram: () => make<ProgObj>({ kind: 'program', attribs: new Map(), uniforms: new Map() }),
    attachShader() {},
    detachShader() {},
    linkProgram() {},
    validateProgram() {},
    getProgramParameter(_p: unknown, pname: number) {
      if (pname === GL.LINK_STATUS || pname === GL.VALIDATE_STATUS) return true
      if (pname === GL.DELETE_STATUS) return false
      return 0
    },
    getProgramInfoLog: () => '',
    deleteProgram() {},
    useProgram(p: ProgObj | null) { program = p },
    bindAttribLocation(p: ProgObj, index: number, name: string) { p?.attribs.set(name, index) },
    getAttribLocation(p: ProgObj, name: string) {
      if (!p) return -1
      if (!p.attribs.has(name)) p.attribs.set(name, p.attribs.size)
      return p.attribs.get(name)!
    },
    getUniformLocation(p: ProgObj, name: string): UniformLoc | null { return p ? { kind: 'uniform', program: p, name } : null },
    getActiveAttrib: () => null,
    getActiveUniform: () => null,
    getUniform(_p: ProgObj, loc: UniformLoc) { return loc?.program.uniforms.get(loc.name) ?? null },
    uniform1i(loc: UniformLoc | null, v: number) { loc?.program.uniforms.set(loc.name, v) },
    uniform1f(loc: UniformLoc | null, v: number) { loc?.program.uniforms.set(loc.name, v) },
    uniformMatrix4fv(loc: UniformLoc | null, _t: boolean, v: ArrayLike<number>) { loc?.program.uniforms.set(loc.name, Float32Array.from(v)) },
    // —— 缓冲区 ——
    createBuffer: () => make<BufObj>({ kind: 'buffer', bytes: new Uint8Array(0) }),
    deleteBuffer() {},
    isBuffer: (b: unknown) => Boolean(b),
    bindBuffer(target: number, b: BufObj | null) { if (target === GL.ARRAY_BUFFER) arrayBuffer = b; else elementBuffer = b },
    bufferData(target: number, data: number | ArrayBufferView | ArrayBuffer | null) {
      const b = target === GL.ARRAY_BUFFER ? arrayBuffer : elementBuffer
      if (!b) return
      if (typeof data === 'number') b.bytes = new Uint8Array(data)
      else if (data instanceof Object && 'byteLength' in data) {
        const view = ArrayBuffer.isView(data) ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength) : new Uint8Array(data as ArrayBuffer)
        b.bytes = new Uint8Array(view) // 复制：Emscripten 传进来的是 HEAP 的视图，之后会被改写
      }
    },
    bufferSubData(target: number, offset: number, data: ArrayBufferView | ArrayBuffer) {
      const b = target === GL.ARRAY_BUFFER ? arrayBuffer : elementBuffer
      if (!b || !data) return
      const view = ArrayBuffer.isView(data) ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength) : new Uint8Array(data)
      if (offset + view.length > b.bytes.length) {
        const grown = new Uint8Array(offset + view.length)
        grown.set(b.bytes)
        b.bytes = grown
      }
      b.bytes.set(view, offset)
    },
    getBufferParameter(target: number, p: number) {
      const b = target === GL.ARRAY_BUFFER ? arrayBuffer : elementBuffer
      return p === GL.BUFFER_SIZE ? b?.bytes.length ?? 0 : 0
    },
    vertexAttribPointer(i: number, size: number, type: number, normalized: boolean, stride: number, offset: number) {
      attribs[i] = { buffer: arrayBuffer, size, type, normalized, stride, offset }
    },
    enableVertexAttribArray() {},
    disableVertexAttribArray() {},
    vertexAttrib4f() {},
    vertexAttrib4fv() {},
    drawArrays(mode: number, first: number, count: number) { draw(mode, range(first, count)) },
    drawElements(mode: number, count: number, type: number, offset: number) {
      if (!elementBuffer) return
      const size = TYPE_BYTES[type] ?? 2
      const view = new DataView(elementBuffer.bytes.buffer, elementBuffer.bytes.byteOffset, elementBuffer.bytes.byteLength)
      const idx: number[] = []
      for (let i = 0; i < count; i++) {
        const o = offset + i * size
        if (o + size > view.byteLength) break
        idx.push(size === 1 ? view.getUint8(o) : size === 2 ? view.getUint16(o, true) : view.getUint32(o, true))
      }
      draw(mode, idx)
    },
    // —— 纹理 ——
    createTexture: () => make<TexObj>({ kind: 'texture', w: 0, h: 0, data: null, canvas: null, opaque: null, dirty: false, smooth: true }),
    deleteTexture(t: TexObj | null) {
      if (!t) return
      t.data = null
      t.canvas = t.opaque = null
      for (let i = 0; i < units.length; i++) if (units[i] === t) units[i] = null
    },
    isTexture: (t: unknown) => Boolean(t),
    activeTexture(unit: number) { activeUnit = Math.max(0, Math.min(15, unit - GL.TEXTURE0)) },
    bindTexture(_target: number, t: TexObj | null) { units[activeUnit] = t },
    texParameteri(_target: number, pname: number, v: number) {
      const t = units[activeUnit]
      if (t && pname === GL.TEXTURE_MAG_FILTER) t.smooth = v !== GL.NEAREST
    },
    texParameterf() {},
    pixelStorei(p: number, v: number) { if (p === GL.UNPACK_ALIGNMENT) unpackAlignment = v || 4 },
    texImage2D(...args: unknown[]) {
      const t = units[activeUnit]
      if (!t) return
      if (args.length >= 9) {
        const [, , , w, h, , format, type, pixels] = args as [number, number, number, number, number, number, number, number, ArrayBufferView | null]
        t.w = w
        t.h = h
        t.data = pixels ? convertPixels(pixels, w, h, format, type, unpackAlignment) : new Uint8ClampedArray(w * h * 4)
      } else {
        // texImage2D(target, level, internal, format, type, source)：图片 / canvas 源
        const source = args[5] as CanvasImageSource & { width: number; height: number }
        if (!source) return
        const c = doc.createElement('canvas')
        c.width = source.width
        c.height = source.height
        const cx = c.getContext('2d')!
        cx.drawImage(source, 0, 0)
        t.w = c.width
        t.h = c.height
        t.data = cx.getImageData(0, 0, c.width, c.height).data
      }
      t.dirty = true
    },
    texSubImage2D(...args: unknown[]) {
      const t = units[activeUnit]
      if (!t || !t.data || args.length < 9) return
      const [, , xo, yo, w, h, format, type, pixels] = args as [number, number, number, number, number, number, number, number, ArrayBufferView | null]
      if (!pixels) return
      const rgba = convertPixels(pixels, w, h, format, type, unpackAlignment)
      if (xo === 0 && yo === 0 && w === t.w && h === t.h) {
        t.data.set(rgba)
      } else {
        for (let y = 0; y < h; y++) {
          const ty = yo + y
          if (ty < 0 || ty >= t.h) continue
          const cols = Math.min(w, t.w - xo)
          if (cols <= 0 || xo < 0) continue
          t.data.set(rgba.subarray(y * w * 4, (y * w + cols) * 4), (ty * t.w + xo) * 4)
        }
      }
      t.dirty = true
    },
    generateMipmap() {},
    copyTexImage2D() {},
    copyTexSubImage2D() {},
    // —— 帧缓冲：只记绑定，离屏的画全部丢弃 ——
    createFramebuffer: () => make({ kind: 'framebuffer' }),
    deleteFramebuffer() {},
    bindFramebuffer(_t: number, fb: FakeObject | null) { framebuffer = fb },
    framebufferTexture2D() {},
    framebufferRenderbuffer() {},
    checkFramebufferStatus: () => GL.FRAMEBUFFER_COMPLETE,
    isFramebuffer: (f: unknown) => Boolean(f),
    createRenderbuffer: () => make({ kind: 'renderbuffer' }),
    deleteRenderbuffer() {},
    bindRenderbuffer(_t: number, rb: FakeObject | null) { renderbuffer = rb },
    renderbufferStorage() {},
    isRenderbuffer: (r: unknown) => Boolean(r),
    readPixels(x: number, y: number, w: number, h: number, _format: number, _type: number, out: ArrayBufferView | null) {
      if (!out || w <= 0 || h <= 0) return
      const img = ctx2d.getImageData(x, canvas.height - y - h, w, h).data
      const dst = new Uint8Array(out.buffer, out.byteOffset, out.byteLength)
      // GL 的第 0 行在下面
      for (let row = 0; row < h; row++) {
        const s = (h - 1 - row) * w * 4
        const d = row * w * 4
        if (d + w * 4 > dst.length) break
        dst.set(img.subarray(s, s + w * 4), d)
      }
    },
    flush() {},
    finish() {},
  }
  void nextName

  /*
    WebGL 有上百个方法，RetroArch / Emscripten 还会碰到上面没列的（深度、模板、混合函数、颜色掩码……）。
    这些对 2D 画法没影响，一律当空操作；只有 uniform* 要记值（sampler 绑定哪个纹理单元、MVP）。
  */
  return new Proxy(impl, {
    get(target, prop) {
      if (prop in target) return target[prop as string]
      if (typeof prop !== 'string') return undefined
      if (/^uniform/.test(prop)) {
        return (loc: UniformLoc | null, ...v: unknown[]) => {
          if (!loc) return
          const last = v[v.length - 1]
          loc.program.uniforms.set(loc.name, ArrayBuffer.isView(last) ? Float32Array.from(last as unknown as ArrayLike<number>) : (v[0] as number))
        }
      }
      if (/^(is|get)/.test(prop)) return () => null
      if (/^create/.test(prop)) return () => ({ kind: prop.slice(6).toLowerCase() })
      return () => undefined
    },
    has(target, prop) {
      return prop in target || typeof prop === 'string'
    },
  }) as unknown as WebGLRenderingContext
}

/**
 * 在 EmulatorJS 的 iframe 里装软件 WebGL：只接管「浏览器给不出 WebGL」的情况——
 * 原生 getContext('webgl') 先试，返回 null 才给假的；'webgl2' 一律保持原生结果（null），
 * 引擎据此选 legacy 核心。返回 true 表示装上了。
 */
export function installSoftwareWebgl(win: Win, onUse?: () => void): boolean {
  const proto = win.HTMLCanvasElement?.prototype
  if (!proto) return false
  if ((proto as unknown as { __8bitgoSoftwareGl?: boolean }).__8bitgoSoftwareGl) return true
  const native = proto.getContext
  const contexts = new WeakMap<HTMLCanvasElement, WebGLRenderingContext>()
  ;(proto as unknown as { __8bitgoSoftwareGl?: boolean }).__8bitgoSoftwareGl = true
  proto.getContext = function (this: HTMLCanvasElement, type: string, attrs?: Record<string, unknown>) {
    if (type === 'webgl' || type === 'experimental-webgl') {
      const existing = contexts.get(this)
      if (existing) return existing
      let real: RenderingContext | null = null
      try { real = native.call(this, type, attrs) as RenderingContext | null } catch { real = null }
      if (real) return real
      const ctx2d = native.call(this, '2d') as CanvasRenderingContext2D | null
      if (!ctx2d) return null
      const soft = createSoftwareContext(this, ctx2d, attrs ?? {})
      contexts.set(this, soft)
      onUse?.()
      return soft
    }
    return native.call(this, type, attrs)
  } as typeof proto.getContext
  return true
}
