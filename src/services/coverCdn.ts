/**
 * 封面 CDN 选择器。
 *
 * 首选由边缘决定（shared/cover-cdn-hint.js）：大陆入口、或 Cloudflare 按访客国家改写过的页面，
 * SSR 已经用对了域名，`decided` 为真，这里不测速。
 * 只有边缘没给结论时（规则缺失、本地开发）才退回测速：拿当前真实封面并行请求 16px 缩略图，
 * 不把两份完整封面都下载一遍。胜出的域名短期缓存，避免每次路由切换都额外探测。
 *
 * 不论哪种方式选出的域名，短时间内连续加载失败都会切到另一个候选（reportCoverCdnFailure），
 * EdgeOne 或 Cloudflare 任一边出故障时封面不会整页挂掉。
 */
export interface CoverCdnProbeConfig {
  candidates: string[]
  preferred: string
  /** 边缘已经替访客选好了域名，不需要测速 */
  decided?: boolean
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

export function selectedCoverCdn(candidates: string[], preferred = ''): string {
  const signature = signatureFor(candidates)
  const chosen =
    selection && selection.signature === signature && candidates.includes(selection.base) ? selection.base : ''
  const effective = chosen || preferred
  // 当前域名被判定故障：换成另一个还没坏的候选；两边都坏了就别再来回切
  if (effective && failedBases.has(effective)) {
    const fallback = candidates.find((base) => !failedBases.has(base))
    if (fallback) return fallback
  }
  return chosen
}

/* ── 故障切换 ─────────────────────────────────────────────
   单张图失败可能只是这个对象不存在（两边都会 404），不能据此切域名；
   同一个域名在 FAILURE_WINDOW_MS 内有 FAILURE_THRESHOLD 张**不同**的图失败才算域名故障。
   只在本次页面会话里生效，不写 localStorage：故障通常是暂时的。 */
const FAILURE_THRESHOLD = 3
const FAILURE_WINDOW_MS = 15_000
const failedBases = new Set<string>()
const recentFailures = new Map<string, { url: string; at: number }[]>()

export function reportCoverCdnFailure(url: string, candidates: string[]): void {
  if (!url) return
  const base = candidates.find((candidate) => url.startsWith(`${candidate}/`))
  if (!base || failedBases.has(base)) return
  const now = Date.now()
  const list = (recentFailures.get(base) || []).filter((entry) => now - entry.at < FAILURE_WINDOW_MS)
  if (!list.some((entry) => entry.url === url)) list.push({ url, at: now })
  recentFailures.set(base, list)
  if (list.length < FAILURE_THRESHOLD) return
  failedBases.add(base)
  recentFailures.delete(base)
  if (candidates.some((candidate) => !failedBases.has(candidate))) notifySubscribers()
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

  // 边缘已经定了：测速只会被两边缓存冷热带偏，还多两个请求
  if (config.decided) return

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
