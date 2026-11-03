/**
 * 封面 CDN 选择器。
 *
 * 首次访问没有测速结果时先用页面对应的默认域名；只拿当前真实封面并行请求 16px 缩略图，
 * 不把两份完整封面都下载一遍。胜出的域名短期缓存，避免每次路由切换都额外探测。
 */
export interface CoverCdnProbeConfig {
  candidates: string[]
  preferred: string
  cnBase: string
  transformEnabled: boolean
}

interface StoredChoice {
  signature: string
  base: string
  checkedAt: number
}

interface ProbeResult { base: string }

const STORAGE_KEY = '8bitgo.cover-cdn.v1'
const CACHE_TTL_MS = 6 * 60 * 60 * 1000
const RETRY_COOLDOWN_MS = 60 * 1000
const PROBE_TIMEOUT_MS = 2500

const subscribers = new Set<() => void>()
let selection: StoredChoice | null = null
let inFlightSignature = ''
let lastAttempt: { signature: string; at: number } | null = null
let notifyQueued = false

function signatureFor(candidates: string[]): string {
  return [...new Set(candidates)].sort().join('|')
}

function readStoredChoice(): StoredChoice | null {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    if (!raw) return null
    const value = JSON.parse(raw) as Partial<StoredChoice>
    if (
      typeof value.signature !== 'string' ||
      typeof value.base !== 'string' ||
      typeof value.checkedAt !== 'number'
    ) return null
    return value as StoredChoice
  } catch {
    return null
  }
}

function notifySubscribers() {
  if (notifyQueued) return
  notifyQueued = true
  // 等同一批封面组件先完成订阅，避免第一个组件命中缓存后其它组件漏掉更新。
  Promise.resolve().then(() => {
    notifyQueued = false
    for (const listener of subscribers) listener()
  })
}

function activate(choice: StoredChoice, preferred: string) {
  const previous = selection
  const previousBase = previous?.signature === choice.signature ? previous.base : preferred
  selection = choice
  if (previousBase !== choice.base) notifySubscribers()
}

export function selectedCoverCdn(candidates: string[]): string {
  if (!selection || selection.signature !== signatureFor(candidates) || !candidates.includes(selection.base)) return ''
  return selection.base
}

export function subscribeCoverCdn(listener: () => void): () => void {
  subscribers.add(listener)
  return () => subscribers.delete(listener)
}

/** 产生小体积测速 URL；正式封面源不变，只把变换宽度压到 16px。 */
export function coverCdnProbeUrl(
  base: string,
  key: string,
  cnBase: string,
  transformEnabled: boolean,
): string {
  const encodedKey = key.replace(/^\/+/, '').split('/').map(encodeURIComponent).join('/')
  if (!transformEnabled) return `${base}/${encodedKey}`
  const format = base === cnBase ? 'webp' : 'auto'
  return `${base}/cdn-cgi/image/width=16,quality=30,format=${format},fit=scale-down/${encodedKey}`
}

function probeImage(url: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const image = new Image()
    const startedAt = performance.now()
    const timeout = window.setTimeout(() => {
      image.onload = null
      image.onerror = null
      image.src = ''
      reject(new Error('cover CDN probe timed out'))
    }, PROBE_TIMEOUT_MS)

    image.decoding = 'async'
    image.fetchPriority = 'low'
    image.onload = () => {
      window.clearTimeout(timeout)
      resolve(performance.now() - startedAt)
    }
    image.onerror = () => {
      window.clearTimeout(timeout)
      reject(new Error('cover CDN probe failed'))
    }
    image.src = url
  })
}

function probeHead(url: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const startedAt = performance.now()
    const controller = new AbortController()
    const timeout = window.setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS)
    void fetch(url, { method: 'HEAD', mode: 'no-cors', cache: 'no-store', signal: controller.signal })
      .then(() => resolve(performance.now() - startedAt))
      .catch(reject)
      .finally(() => window.clearTimeout(timeout))
  })
}

/** 在 GameCover 的 effect 中调用；多个卡片共用一轮并行探测。 */
export function startCoverCdnProbe(key: string, config: CoverCdnProbeConfig): void {
  if (typeof window === 'undefined' || !key.startsWith('covers/')) return

  const candidates = [
    ...new Set(config.candidates.filter((base) => /^https:\/\//i.test(base))),
  ]
  if (candidates.length < 2 || !candidates.includes(config.preferred)) return

  const signature = signatureFor(candidates)
  const now = Date.now()
  if (selection?.signature === signature && now - selection.checkedAt < CACHE_TTL_MS) return

  const stored = readStoredChoice()
  if (
    stored &&
    stored.signature === signature &&
    candidates.includes(stored.base) &&
    now - stored.checkedAt >= 0 &&
    now - stored.checkedAt < CACHE_TTL_MS
  ) {
    activate(stored, config.preferred)
    return
  }

  if (inFlightSignature === signature) return
  if (lastAttempt?.signature === signature && now - lastAttempt.at < RETRY_COOLDOWN_MS) return
  inFlightSignature = signature
  lastAttempt = { signature, at: now }

  const probes = candidates.map((base) =>
    (config.transformEnabled
      ? probeImage(coverCdnProbeUrl(base, key, config.cnBase, true))
      : probeHead(coverCdnProbeUrl(base, key, config.cnBase, false))
    ).then(
      (): ProbeResult => ({ base }),
    ),
  )

  // 最先成功載入的小圖就是同時發出的最快路徑；不等慢域名 timeout 才套用結果。
  void Promise.any(probes)
    .then((winner) => {
      const choice = { signature, base: winner.base, checkedAt: Date.now() }
      try {
        window.localStorage.setItem(STORAGE_KEY, JSON.stringify(choice))
      } catch {
        /* 無痕模式或儲存空間受限時，這次頁面仍使用測速結果。 */
      }
      activate(choice, config.preferred)
    })
    .catch(() => {
      // 兩邊都失敗時保留站點默認域名；冷卻一分鐘，避免很多封面卡片反复发探测。
    })
    .finally(() => {
      if (inFlightSignature === signature) inFlightSignature = ''
    })
}
