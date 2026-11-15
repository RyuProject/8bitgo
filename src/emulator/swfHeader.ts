/**
 * 读 SWF 文件头里的舞台尺寸（FrameSize），只解开开头几十个字节。
 *
 * AwayFL 宿主页要在虚拟机起来**之前**知道舞台多大：它告诉游戏「窗口」就是这么大
 * （stage.scaleMode = NO_SCALE 的游戏按 stageWidth 摆界面），画面层再按它等比铺满播放器。
 *
 * FWS 直接读；CWS 是 zlib，用 fflate 的流式解压只喂前 4KB（纯 JS，没有 WebAssembly 也能用）；
 * ZWS（LZMA）很少见，读不出就返回 null，由调用方按虚拟机稍后报上来的尺寸处理。
 */
import { Unzlib } from 'fflate'

export interface SwfStageSize {
  width: number
  height: number
}

/** RECT 结构：5 位 Nbits，再 4 个 Nbits 位的有符号数（twips）。 */
function readRect(bytes: Uint8Array): SwfStageSize | null {
  if (bytes.length < 1) return null
  let pos = 0
  const bits = (n: number): number => {
    let value = 0
    for (let i = 0; i < n; i++) {
      const byte = bytes[pos >> 3]
      if (byte === undefined) throw new RangeError('SWF 文件头不完整')
      value = (value << 1) | ((byte >> (7 - (pos & 7))) & 1)
      pos++
    }
    return value
  }
  const signed = (n: number): number => {
    const value = bits(n)
    return value & (1 << (n - 1)) ? value - (1 << n) : value
  }
  try {
    const nbits = bits(5)
    if (nbits === 0) return null
    const xMin = signed(nbits)
    const xMax = signed(nbits)
    const yMin = signed(nbits)
    const yMax = signed(nbits)
    const width = Math.round((xMax - xMin) / 20)
    const height = Math.round((yMax - yMin) / 20)
    // 正常的 Flash 舞台在 1～8192 像素之间；越界多半是文件坏了，别拿它去算缩放
    if (!(width > 0 && height > 0 && width <= 8192 && height <= 8192)) return null
    return { width, height }
  } catch {
    return null
  }
}

/** 解开 CWS 正文的开头一段（只要够读 RECT：最多 17 字节） */
function inflateHead(compressed: Uint8Array): Uint8Array | null {
  const chunks: Uint8Array[] = []
  let got = 0
  const inflater = new Unzlib((chunk) => {
    chunks.push(chunk)
    got += chunk.length
  })
  try {
    // 4KB 压缩数据足够解出几百字节；只 push 不 final，不需要整个流合法收尾
    inflater.push(compressed.subarray(0, 4096), false)
  } catch {
    if (!got) return null
  }
  if (!got) return null
  const out = new Uint8Array(got)
  let at = 0
  for (const chunk of chunks) {
    out.set(chunk, at)
    at += chunk.length
  }
  return out
}

export function swfStageSize(data: ArrayBuffer | Uint8Array): SwfStageSize | null {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data)
  if (bytes.length < 9) return null
  const signature = String.fromCharCode(bytes[0], bytes[1], bytes[2])
  if (signature === 'FWS') return readRect(bytes.subarray(8, 8 + 32))
  if (signature === 'CWS') {
    const head = inflateHead(bytes.subarray(8))
    return head ? readRect(head.subarray(0, 32)) : null
  }
  return null
}
