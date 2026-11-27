/** 轻量自托管模拟器核心的浏览器端 SHA-256 校验工具。 */
export interface PinnedAssetDigest {
  name: string
  bytes: number
  sha256: string
}

export function sha256Sri(value: string): string {
  if (!/^[a-f0-9]{64}$/i.test(value)) throw new Error('模拟器核心 SHA-256 配置无效')
  const binary = value.match(/.{2}/g)!.map((part) => String.fromCharCode(Number.parseInt(part, 16))).join('')
  return `sha256-${btoa(binary)}`
}

/** 浏览器原生 SRI 在脚本执行前校验字节，不额外下载第二份脚本。 */
export function applyPinnedScriptIntegrity(
  script: Pick<HTMLScriptElement, 'integrity' | 'crossOrigin'>,
  expectedSha256: string,
): void {
  script.integrity = sha256Sri(expectedSha256)
  script.crossOrigin = 'anonymous'
}

/** 仅供轻量 WASM 核心使用；大核心应采用分块清单，避免另留一份整包内存。 */
export async function verifyPinnedAssetBytes(
  value: ArrayBuffer | Uint8Array,
  expected: PinnedAssetDigest,
): Promise<ArrayBuffer> {
  if (!Number.isSafeInteger(expected.bytes) || expected.bytes <= 0 || !/^[a-f0-9]{64}$/.test(expected.sha256)) {
    throw new Error(`${expected.name} 的可信 SHA-256 清单无效`)
  }
  const bytes = value instanceof Uint8Array ? value : new Uint8Array(value)
  if (bytes.byteLength !== expected.bytes) {
    throw new Error(`${expected.name} 长度不符：应为 ${expected.bytes}，实际 ${bytes.byteLength}`)
  }
  if (!globalThis.crypto?.subtle) throw new Error('当前浏览器不支持 SHA-256，已阻止加载未校验的模拟器核心')
  // WebCrypto 不接受可能指向 SharedArrayBuffer 的 BufferSource；复制后也保证验签期间字节不会被并发改写。
  const digestInput = new Uint8Array(bytes)
  const digest = new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', digestInput.buffer))
  const actual = Array.from(digest, (part) => part.toString(16).padStart(2, '0')).join('')
  if (actual !== expected.sha256) throw new Error(`${expected.name} SHA-256 不匹配，已阻止启动`)
  return digestInput.buffer
}

/** Binjgb 两种浏览器构建的固定摘要；构建门禁会与 public 产物逐字节核对。 */
export const BINJGB_ASSETS = Object.freeze({
  wasmScript: {
    name: 'binjgb.js',
    bytes: 13_640,
    sha256: 'a68e5854b5d68339a34c0aa0b6dbeacd615ed316657ee17b63dafa5e00561b09',
  },
  wasm: {
    name: 'binjgb.wasm',
    bytes: 88_269,
    sha256: '52c165069441a09180b4bd63464318aa7b861b1d36e0d05e8047b48619fd2f0b',
  },
  javascriptScript: {
    name: 'binjgb-js.js',
    bytes: 201_314,
    sha256: '2d77d706c4bf900f7c502d7d4f7d81bc1a917dbbffcba9a58909270841212be7',
  },
}) satisfies Readonly<Record<string, PinnedAssetDigest>>
