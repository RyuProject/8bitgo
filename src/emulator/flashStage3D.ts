/**
 * 判断一份 SWF 是否用到 Stage3D（`flash.display3D`），据此给 Ruffle 选渲染后端。
 *
 * ── 为什么（2026-11-05《传染恐慌：幸存者》实测）────────────────────────────
 * 这款游戏是 Starling（Stage3D）做的。Ruffle 默认的后端顺序是 wgpu-webgl → webgl → canvas，
 * WebGPU 要显式 `preferredRenderer: 'webgpu'` 才会试：
 *   · wgpu-webgl：主菜单每帧 24ms，只能跑 40 FPS（60 FPS 的游戏），而且和画布像素无关；
 *   · webgpu：同一个菜单每帧 0.2～3ms、进关卡 5～6ms，稳 60 FPS；
 *   · webgl / canvas：Ruffle 只在 wgpu 上实现了 Context3D，`createContext3D` 直接报
 *     "Not yet implemented"，游戏一直黑屏、每帧往控制台刷一条错误。
 * 所以对 Stage3D 游戏优先 WebGPU；Ruffle 建 WebGPU 失败时会自己退回 wgpu-webgl，不会更糟。
 * 普通（非 Stage3D）Flash 维持 Ruffle 默认顺序，不拿全站几千款游戏去换一个官方仍标为可选的后端。
 *
 * ── 怎么判断 ─────────────────────────────────────────────────────────────
 * Stage3D 从 Flash Player 11 开始有，对应 SWF 版本 13；更老的不扫。AS3 常量池里类的命名空间
 * 是明文 UTF-8 字符串 `flash.display3D`，用 Starling / Away3D / 自写 Stage3D 都绕不开它。
 *   · FWS：直接在原字节里找；
 *   · CWS：用浏览器原生的 DecompressionStream('deflate') 边解边找，找到就取消，不整份落内存；
 *   · ZWS（LZMA）：浏览器没有原生解码器，不猜，返回 false 走默认顺序。
 * 有时间上限：超时同样返回 false，宁可维持现状也不能拖慢启动。
 */

const NEEDLE = new TextEncoder().encode('flash.display3D')
/** Stage3D（Flash Player 11）对应的最低 SWF 版本 */
export const STAGE3D_MIN_SWF_VERSION = 13
const DEFAULT_TIMEOUT_MS = 2500

/** 在 chunk 里找 NEEDLE；carry 是上一块末尾不足一个 NEEDLE 长度的尾巴，处理跨块命中 */
function containsNeedle(chunk: Uint8Array): boolean {
  const first = NEEDLE[0]!
  const last = chunk.length - NEEDLE.length
  let index = chunk.indexOf(first)
  while (index !== -1 && index <= last) {
    let matched = true
    for (let offset = 1; offset < NEEDLE.length; offset++) {
      if (chunk[index + offset] !== NEEDLE[offset]) {
        matched = false
        break
      }
    }
    if (matched) return true
    index = chunk.indexOf(first, index + 1)
  }
  return false
}

export function swfVersionOf(bytes: Uint8Array): number | null {
  if (bytes.length < 8) return null
  const signature = String.fromCharCode(bytes[0]!, bytes[1]!, bytes[2]!)
  return signature === 'FWS' || signature === 'CWS' || signature === 'ZWS' ? bytes[3]! : null
}

async function inflatedContainsNeedle(compressed: Uint8Array, deadline: number): Promise<boolean> {
  const Decompression = (globalThis as { DecompressionStream?: typeof DecompressionStream }).DecompressionStream
  if (typeof Decompression !== 'function') return false
  // 按 1MB 视图喂给解压流：不复制整份 SWF（大游戏动辄 20MB），找到就停，后面的块根本不喂
  let fed = 0
  const source = new ReadableStream<BufferSource>({
    pull(controller) {
      if (fed >= compressed.length) {
        controller.close()
        return
      }
      const end = Math.min(compressed.length, fed + (1 << 20))
      controller.enqueue(compressed.subarray(fed, end) as Uint8Array<ArrayBuffer>)
      fed = end
    },
  })
  const stream = source.pipeThrough(new Decompression('deflate'))
  const reader = stream.getReader()
  let tail = new Uint8Array(0)
  try {
    for (;;) {
      if (Date.now() > deadline) return false
      const { done, value } = await reader.read()
      if (done) return false
      if (!value?.length) continue
      let chunk: Uint8Array = value
      if (tail.length) {
        chunk = new Uint8Array(tail.length + value.length)
        chunk.set(tail, 0)
        chunk.set(value, tail.length)
      }
      if (containsNeedle(chunk)) return true
      tail = chunk.slice(Math.max(0, chunk.length - (NEEDLE.length - 1)))
    }
  } catch {
    // 截断 / 损坏的压缩流：交给 Ruffle 自己报错，这里只是不改后端
    return false
  } finally {
    reader.cancel().catch(() => {})
  }
}

/**
 * @returns SWF 明确引用了 `flash.display3D` 时为 true；不确定（ZWS、超时、损坏、太老的版本）一律 false
 */
export async function swfUsesStage3D(
  data: ArrayBuffer | Uint8Array,
  { timeoutMs = DEFAULT_TIMEOUT_MS }: { timeoutMs?: number } = {},
): Promise<boolean> {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data)
  const version = swfVersionOf(bytes)
  if (version === null || version < STAGE3D_MIN_SWF_VERSION) return false
  const signature = bytes[0]
  if (signature === 0x46 /* F */) return containsNeedle(bytes.subarray(8))
  if (signature === 0x43 /* C */) return inflatedContainsNeedle(bytes.subarray(8), Date.now() + timeoutMs)
  return false
}

export interface RuffleRendererPreference {
  preferredRenderer?: 'webgpu'
  stage3D: boolean
}

/**
 * 给 Ruffle 的渲染后端偏好。只在浏览器暴露了 WebGPU 时才建议 webgpu；
 * 没有 navigator.gpu 时 Ruffle 默认就是 wgpu-webgl，不用多此一举（也省一次解压扫描）。
 */
export async function ruffleRendererPreference(
  data: ArrayBuffer | Uint8Array,
  navigatorLike: { gpu?: unknown } | null | undefined,
): Promise<RuffleRendererPreference> {
  if (!navigatorLike || !navigatorLike.gpu) return { stage3D: false }
  const stage3D = await swfUsesStage3D(data)
  return stage3D ? { preferredRenderer: 'webgpu', stage3D } : { stage3D }
}
