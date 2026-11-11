/**
 * 浏览器是 32 位还是 64 位。
 *
 * 2026-11-11 后台：大陆两名 Chrome 109 / Windows 玩家开《合金弹头 2》《1941》，核心编译完后报
 * `WebAssembly.instantiate(): Out of memory: Cannot allocate Wasm memory for new instance`。
 * FBNeo 核心起步只要 128MB（最大 2GB，V8 分配失败会自己逐级缩到起步值再试），
 * 64 位浏览器在 8GB 机器上不会连 128MB 都给不出来。Chrome 109 是 Win7 / 8.1 的最后一版，
 * 这批机器常装 32 位 Chrome：渲染进程只有 2～4GB 地址空间，43MB 的 wasm 编译出的代码再加
 * 引擎 / ROM 占掉的，剩不下一整块 128MB。这种情况「关掉其它标签页再重试」没有用，
 * 要告诉玩家换 64 位浏览器。
 *
 * 判据：
 *   - `navigator.userAgentData.getHighEntropyValues(['bitness'])`（Chromium 93+）最可靠；
 *   - 拿不到时看 UA：`WOW64` = 64 位 Windows 上的 32 位浏览器；`Win64; x64` = 64 位；
 *     Windows 上两者都没有 = 32 位系统。⚠️ Chrome 110 起 UA 精简后一律写 `Win64; x64`，
 *     所以 UA 只能证明「32 位」，写着 64 位不作数（返回 null）。
 */
export type BrowserBitness = '32' | '64' | null

let cached: BrowserBitness | undefined
let pending: Promise<BrowserBitness> | null = null

/** 只看 UA 字符串能下的结论（纯函数，测试用）。 */
export function bitnessFromUserAgent(ua: string): BrowserBitness {
  if (!/Windows NT/i.test(ua)) return null
  if (/WOW64/i.test(ua)) return '32'
  if (/Win64|x64|amd64|arm64/i.test(ua)) return null
  return '32'
}

/** 同步读一次：高熵结果已回来就用它，否则只看 UA。 */
export function browserBitness(): BrowserBitness {
  if (cached !== undefined) return cached
  try {
    return bitnessFromUserAgent(navigator.userAgent || '')
  } catch {
    return null
  }
}

/**
 * 发起高熵查询（幂等）。开局时调一次，结果在失败那一刻通常早就回来了。
 * 查询失败 / 不支持时退回 UA 结论。
 */
export function probeBrowserBitness(): Promise<BrowserBitness> {
  if (cached !== undefined) return Promise.resolve(cached)
  if (pending) return pending
  const fallback = browserBitness()
  const uad = (typeof navigator !== 'undefined' ? (navigator as Navigator & {
    userAgentData?: { getHighEntropyValues?: (hints: string[]) => Promise<{ bitness?: string }> }
  }).userAgentData : undefined)
  if (!uad?.getHighEntropyValues) {
    cached = fallback
    return Promise.resolve(cached)
  }
  pending = uad.getHighEntropyValues(['bitness'])
    .then((v) => {
      cached = v?.bitness === '32' ? '32' : v?.bitness === '64' ? '64' : fallback
      return cached
    })
    .catch(() => {
      cached = fallback
      return cached
    })
  return pending
}
