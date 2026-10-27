/**
 * Windows / DOS 系统镜像的**多源兜底**。
 *
 * 站长 2026-09-11：「做一个兜底方案，确保每个用户至少是可以正确加载镜像的」。
 *
 * ── 要防的是什么 ──────────────────────────────────────────
 * 系统镜像是 Win9x/Win3.x 游戏的硬前提：拿不到它，播放器什么都做不了。
 * 而它是**一个单点** —— 所有人都从 assets.8bitgo.com 取同一个近百 MB 的文件。
 * 那个域名对某些网络慢、对某些网络干脆不通，而玩家看到的只是一个永远不动的进度条。
 *
 * 所以这里给每个镜像配两条备用路径：先走 8bitgo.com 的同源流式代理（避开资源子域
 * 在部分网络上的连接问题），最后才试 js-dos 官方的 br.cdn.dos.zone。官方源没有稳定的
 * CORS 许可，不能再把它当唯一兜底；保留它是为了上游哪天恢复跨域时仍有第三条路。
 *
 * ⚠️ **备用源不是「更快的源」，是「另一条路」**。没有任何证据说明 br.cdn.dos.zone
 * 对你的用户比 R2 快 —— 它只在主源**失败或卡死**时才上场。别把顺序倒过来。
 *
 * ── 三条必须守住的规矩 ────────────────────────────────────
 * 1. **镜像表按我们自己的路径显式写死，不按文件名猜。**
 *    官方那边 `system-win95-v2.jsdos` 是「Windows 95 (DT)」，和 v1 **不是同一个系统**。
 *    哪天我们自己传了一个叫 v2 的文件（比如重新压缩过的 v1），按名字猜就会把
 *    一个完全不同的 Windows 当成它的备份发给玩家 —— 能启动、但游戏未必跑得起来，
 *    而且没有任何报错。宁可漏配一条，也不能猜。
 * 2. **下载完要当场验是不是一个合法的系统 bundle**（见 looksLikeSystemBundle）。
 *    CDN 返回一页 HTML 错误页、或者传到一半断了，字节数都是「有」的；
 *    不验的话这些会一路喂进 js-dos，报出来的错和真正的原因隔着十万八千里。
 * 3. **玩家自己取消（换游戏、离开页面）绝不能触发换源。** 那不是失败。
 */
import { assertValidZip } from '@/lib/unzip'
import { fetchWithProgress } from './loadProgress'
import type { LoadProgress } from './types'
import { romCacheDelete, romCacheGet, romCacheKey, romCachePut } from './romCache'
import { versionedRomUrl } from '@/services/roms'

/**
 * js-dos 官方镜像站。地址来自 `public/jsdos/js-dos.js` 里 studio 的下载列表 ——
 * 也就是我们这几个系统镜像的原始出处。
 */
const OFFICIAL = 'https://br.cdn.dos.zone/js-dos/system'

/**
 * 纯 DOS Sockdrive 不能直接当 DOSBox-X 内置 DOS 的 C:：官方扩展只把它挂成 BIOS 硬盘。
 * 因此流式 DOS 游戏统一先启动这块 10MB 的 DOS 7.1 系统盘，再把游戏盘作为 D: 使用。
 */
export const DOS71_SYSTEM_FILE = 'system-dos7.1-v1.jsdos'

export function isDos71SystemUrl(value: string): boolean {
  try {
    return new URL(value, typeof window === 'undefined' ? 'https://x/' : window.location.href).pathname
      .split('/')
      .pop() === DOS71_SYSTEM_FILE
  } catch {
    return false
  }
}

/** 默认优先走资源域；开发环境没配公开根地址时退回同源白名单代理。 */
export function defaultDos71SystemUrl(): string {
  const env = (import.meta as ImportMeta & { env?: ImportMetaEnv }).env
  const base = String(env?.VITE_ROM_BASE_URL || '').trim().replace(/\/+$/, '')
  return base ? `${base}/systems/dos/${DOS71_SYSTEM_FILE}` : `/system-images/${DOS71_SYSTEM_FILE}`
}

/**
 * 我们的镜像路径 → 官方同一份镜像的地址。
 *
 * key 是**我们自己地址里的 pathname**（不含域名），这样换资源域名也不用动这张表。
 * ⚠️ 只登记「确实是同一个系统」的那些。见文件头第 1 条。
 */
type SystemMirror = { url: string; label: string }

const mirrorsFor = (file: string): readonly SystemMirror[] => [
  { url: `/system-images/${file}`, label: '主站同源备用' },
  { url: `${OFFICIAL}/${file}`, label: 'js-dos 官方源' },
]

/** 自制 / 本地化镜像只能代理同一份 R2 对象；官方同名文件不能假定内容相同。 */
const sameOriginMirror = (file: string): readonly SystemMirror[] => [
  { url: `/system-images/${file}`, label: '主站同源备用' },
]

const MIRRORS: Readonly<Record<string, readonly SystemMirror[]>> = {
  [`/systems/dos/${DOS71_SYSTEM_FILE}`]: mirrorsFor(DOS71_SYSTEM_FILE),
  '/systems/dos/system-win311-v1.jsdos': mirrorsFor('system-win311-v1.jsdos'),
  '/systems/dos/system-win95-v1.jsdos': mirrorsFor('system-win95-v1.jsdos'),
  '/systems/dos/system-win98-v1.jsdos': mirrorsFor('system-win98-v1.jsdos'),
  // 保留第一版路径给旧数据/缓存回退；自制对象都不能回落到官方同名系统。
  '/systems/dos/Windows95_Traditional-Chinese-DirectInput-v1.jsdos': sameOriginMirror(
    'Windows95_Traditional-Chinese-DirectInput-v1.jsdos',
  ),
  // 《天之痕》是原生 Big5，进入剧情还依赖完整 DirectX 7.0a；不能回落到官方英文系统。
  '/systems/dos/Windows95_Traditional-Chinese-DirectX7a-Minimal-v1.jsdos': sameOriginMirror(
    'Windows95_Traditional-Chinese-DirectX7a-Minimal-v1.jsdos',
  ),
  // 超精简版也是本站自行制作，不能把英文 Win95 当成故障时的镜像替身。
  '/systems/dos/Windows95_Traditional-Chinese-DirectX7a-UltraLite-v2.jsdos': sameOriginMirror(
    'Windows95_Traditional-Chinese-DirectX7a-UltraLite-v2.jsdos',
  ),
  /*
    ⚠️ `system-win311-vga-v1.jsdos` **故意不登记**，别手贱加上。
    它是我们自己从官方那份改出来的：SYSTEM.INI 的显示驱动从 S3 Trio64V 800x600 真彩
    换成了标准 VGA 640x480x16（2026-09-11）。当时以为《经典食人花》的白窗口是「16 色游戏
    在真彩桌面上画不出来」—— 2026-10-27 查明真因是被主窗口压住的 MIDI 警告框，已由
    win3xSystemIni.ts 在开机前统一处理。VGA 仍保留：640x480 下游戏窗口正好铺满画布。
    但官方那份**不是同一个系统**，拿它当备份发下去分辨率和显示驱动都会变，没有任何报错。
    按文件头第 1 条：宁可漏配一条，也不能猜。

    代价要知道：这个镜像因此**没有备用源**，资源域名不通的话用它的游戏就是加载不了。
    哪天真需要兜底，正确做法是把同一份文件也传到第二个我们自己控制的地址，再登记进来。
  */
}

export interface SystemSource {
  url: string
  /** 出错和日志里显示用。不要放完整 URL，那会把资源域名拼进用户看得到的文案里 */
  label: string
}

/** 这个主地址有没有备用源。顺序就是尝试顺序：自家的永远排第一 */
export function systemSourcesFor(primaryUrl: string): SystemSource[] {
  const list: SystemSource[] = [{ url: primaryUrl, label: '主源' }]
  let path = ''
  try {
    path = new URL(primaryUrl, typeof window === 'undefined' ? 'https://x/' : window.location.href).pathname
  } catch {
    return list
  }
  const mirrors = MIRRORS[path] ?? []
  for (const mirror of mirrors) {
    // 相对地址必须保留：它会自动跟随当前站点域名，本地和预览环境也不用写死生产域名。
    if (mirror.url !== primaryUrl) list.push(mirror)
  }
  return list
}

/**
 * 长时间一个字节都没来就放弃这个源。
 *
 * ⚠️ **只卡「不动」，不卡「总时长」**。一个 40MB 的包在慢网络上跑五分钟是正常的，
 * 而那恰恰是最需要兜底的那批用户 —— 给总时长设上限等于专门把他们踢掉。
 */
export const FIRST_BYTE_MS = 20_000
export const STALL_MS = 25_000

/** 像不像一个能用的系统 bundle。不像就换下一个源，别喂给 js-dos */
export function looksLikeSystemBundle(buf: ArrayBuffer): boolean {
  try {
    const entries = assertValidZip(buf, '系统镜像')
    return entries.some((e) => e.name.toLowerCase() === '.jsdos/dosbox.conf')
  } catch {
    return false
  }
}

export interface LoadedSystem {
  data: ArrayBuffer
  url: string
  label: string
  /** 用的是不是备用源。true 时值得在控制台喊一声，说明主源出问题了 */
  usedFallback: boolean
  /**
   * 这一份是从本地缓存拿的，没走网络。
   *
   * ⚠️ 调用方必须看这个字段：为 false 时那块 ArrayBuffer **正在被后台写进 IndexedDB**，
   * 谁要原地改它（比如 hideJsdosConfigForLayer 改 dosbox.conf 的名字）必须先复制一份，
   * 否则改过名的镜像会被存进缓存 —— 下次命中就找不到 conf，客体永远起不来，
   * 而且缓存不清不会自愈。见 adapters/jsdos.ts 里那段注释。
   */
  fromCache: boolean
}

/**
 * HEAD 一次拿对象 ETag，拼成带 `?romv=<etag>` 的地址 —— 有了它 romCache 才认这个 key。
 *
 * 为什么非要这一趟往返：系统镜像是 R2 上可以被覆盖的同一个对象 key，地址本身不带版本
 * 就没法判断远端内容换没换，而「半截 / 过期镜像复活」是这个项目栽过的坑（见 romCache 文件头）。
 * 一次 HEAD 几十到几百毫秒，换的是 20 MB 不用重下，划算得离谱。
 *
 * 任何一步不顺（超时、CORS 没暴露 ETag、对象不存在）都返回空串 = **这次不缓存**，
 * 照常走网络。缓存只是加速，不能因为它让人玩不了游戏。
 */
let warnedNoVersionHeader = false

/** 只喊一次：这是配置问题，不是每次加载都值得刷屏的运行时错误 */
function warnNoVersionHeaderOnce(url: string): void {
  if (warnedNoVersionHeader) return
  warnedNoVersionHeader = true
  console.warn(
    '[jsdos] 系统镜像既读不到 ETag 也读不到 Last-Modified，本地缓存无法生效 —— ' +
      '每次进 Windows 游戏都会重新下载整个镜像。' +
      '资源域名上给这个路径加 `Access-Control-Expose-Headers: ETag` 即可。',
    url,
  )
}

export const PROBE_MS = 4000

/**
 * 悬停预热与真正开局之间通常只有几百毫秒；共用这次 HEAD，避免玩家点击后仍先空等一次 RTT。
 * 只缓存很短时间且只缓存版本号，不持有几十 MB 的镜像字节：对象若真的被原地覆盖，最多
 * 30 秒后就会重新探；玩家没点击时也不会因为一次悬停把整个 Windows 系统盘读进内存。
 */
export const PROBE_REUSE_MS = 30_000
type ProbeEntry = {
  fetcher: typeof fetch
  expiresAt: number
  promise: Promise<string>
}
const probeEntries = new Map<string, ProbeEntry>()

/** 等共享 HEAD 的同时仍响应这一局自己的取消；取消不能把别的预热 / 开局也一起 abort。 */
function awaitProbe(promise: Promise<string>, signal?: AbortSignal): Promise<string> {
  if (!signal) return promise
  if (signal.aborted) return Promise.resolve('')
  return new Promise((resolve) => {
    let settled = false
    const finish = (value: string) => {
      if (settled) return
      settled = true
      signal.removeEventListener('abort', cancel)
      resolve(value)
    }
    const cancel = () => finish('')
    signal.addEventListener('abort', cancel, { once: true })
    void promise.then(finish, () => finish(''))
  })
}

export async function systemCacheUrl(url: string, signal?: AbortSignal): Promise<string> {
  if (typeof fetch !== 'function' || !url) return ''
  if (signal?.aborted) return ''
  const fetcher = fetch
  const now = Date.now()
  const existing = probeEntries.get(url)
  if (existing && existing.fetcher === fetcher && existing.expiresAt > now) {
    return awaitProbe(existing.promise, signal)
  }

  const promise = (async () => {
    const ctl = new AbortController()
    // 裸 setTimeout：这个模块要能在 node 里被测到
    const timer = setTimeout(() => ctl.abort(), PROBE_MS)
    try {
      // no-store：这一趟正是为了读到**新的**版本号，自己吃缓存就白探了
      const res = await fetcher(url, { method: 'HEAD', cache: 'no-store', signal: ctl.signal })
      if (!res.ok) return ''
      /*
        ⚠️⚠️ ETag **不在 CORS 响应头安全列表里**。
        系统镜像在资源域名上（跨域），服务器不额外发
        `Access-Control-Expose-Headers: ETag` 的话，`headers.get('etag')` 就是 null ——
        于是拼不出 romv、romCacheKey 返回空串、整套缓存**一个字节都不生效**，
        而且没有任何报错：表现就是「明明写了缓存，怎么还是每次都下 20 MB」。

        Last-Modified 是安全列表里的（Cache-Control / Content-Language / Content-Length /
        Content-Type / Expires / Last-Modified / Pragma），任何跨域配置下都读得到，
        拿它兜底。对象覆盖时 Last-Modified 一样会变，作为内容版本号够用。
      */
      const token = res.headers.get('etag') || res.headers.get('last-modified')
      if (!token) {
        warnNoVersionHeaderOnce(url)
        return ''
      }
      return versionedRomUrl(url, token)
    } catch {
      return ''
    } finally {
      clearTimeout(timer)
    }
  })()
  const entry: ProbeEntry = { fetcher, expiresAt: now + PROBE_REUSE_MS, promise }
  probeEntries.set(url, entry)
  void promise.then((value) => {
    // 失败不能占住 30 秒；网络刚恢复或 CORS 刚修好时，下一次要能立刻重试。
    if (!value && probeEntries.get(url) === entry) probeEntries.delete(url)
  })
  return awaitProbe(promise, signal)
}

/**
 * 只提前取系统盘的版本号，不下载镜像本体。没有 IndexedDB 时版本号没人使用，连 HEAD 都省掉。
 * 真正开局会复用上面 30 秒内的结果，再按原流程读本地镜像或走多源下载。
 */
export function prewarmSystemCache(url: string): void {
  if (!url || typeof indexedDB === 'undefined') return
  void systemCacheUrl(url)
}

/** 把外部 signal 和「失速自杀」合成一个 */
function stallGuard(signal: AbortSignal | undefined, onGiveUp: () => void) {
  const ctl = new AbortController()
  // ⚠️ 用裸的 setTimeout 不用 window.setTimeout：这个模块要能在 node 里被测到
  let timer: ReturnType<typeof setTimeout> | null = null
  const arm = (ms: number) => {
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => {
      onGiveUp()
      ctl.abort(new DOMException('源没有响应', 'TimeoutError'))
    }, ms)
  }
  const stop = () => {
    if (timer) clearTimeout(timer)
    timer = null
    signal?.removeEventListener('abort', relay)
  }
  function relay() {
    stop()
    ctl.abort(signal?.reason)
  }
  if (signal?.aborted) ctl.abort(signal.reason)
  else signal?.addEventListener('abort', relay)
  arm(FIRST_BYTE_MS)
  return { signal: ctl.signal, tick: () => arm(STALL_MS), stop }
}

/**
 * 依次尝试各个源，第一个**下载完整且校验通过**的胜出。
 *
 * ⚠️ 玩家自己取消时立刻往外抛，不试下一个源 —— 那不是失败。
 * ⚠️ 每个源的进度都从 0 重新报：换源之后进度条倒退是对的，
 *    假装接着上一个源的百分比往前走，只会让人以为卡住了。
 */
export async function loadSystemBytes(
  sources: readonly SystemSource[],
  onProgress?: (progress: LoadProgress) => void,
  signal?: AbortSignal,
): Promise<LoadedSystem> {
  if (!sources.length) throw new Error('没有可用的系统镜像地址')
  const failures: string[] = []

  /*
    ⚠️ 缓存只认**主源**那一份。
    备用源按文件头第 1 条只登记「确实是同一个系统」的地址，但那是靠人维护的表；
    万一哪天登记错了，把备用源的内容按主源的 key 存进缓存，等于把一个错误的 Windows
    永久钉在玩家本地 —— 主源后来好了也换不回来。所以只有 i === 0 那一趟才写。
  */
  /*
    ⚠️ 没有 IndexedDB 就**连探都不探**：无痕模式、禁用站点数据、SSR、node 里跑测试，
    这一趟 HEAD 的结果没有任何人用得上，白白给每次加载加一个往返。
  */
  const canCache = typeof indexedDB !== 'undefined'
  const cacheUrl = canCache ? await systemCacheUrl(sources[0].url, signal) : ''
  const key = cacheUrl ? romCacheKey(cacheUrl) : ''

  if (key) {
    let hit: ArrayBuffer | null = null
    try {
      hit = await romCacheGet(key)
    } catch {
      hit = null
    }
    if (hit) {
      // 取消了就别再往下走，行为要和网络分支一致
      if (signal?.aborted) throw new DOMException('已取消', 'AbortError')
      if (looksLikeSystemBundle(hit)) {
        // 命中也要发一帧满进度：播放器的遮罩靠进度回调收尾，不发会停在 0%
        onProgress?.({ phase: 'assets', loaded: hit.byteLength, total: hit.byteLength, ratio: 1 })
        return { data: hit, url: sources[0].url, label: sources[0].label, usedFallback: false, fromCache: true }
      }
      // 历史上写坏的那条要**扔掉再走网络**，不然每次都撞上它，这台浏览器永远起不来
      void romCacheDelete(key).catch(() => {})
    }
  }

  for (let i = 0; i < sources.length; i++) {
    const source = sources[i]
    if (signal?.aborted) throw new DOMException('已取消', 'AbortError')
    let stalled = false
    const guard = stallGuard(signal, () => {
      stalled = true
    })
    try {
      /*
        主源用**带版本号的那个地址**去下。两个原因：
          1. 和缓存 key 是同一个 URL —— 否则 HEAD 和 GET 之间对象被覆盖的话，
             会把新内容存进旧 key（或反过来），而这种脏数据不清缓存不会自愈；
          2. 浏览器 HTTP 缓存也按完整 URL 建键，顺带多一层命中。
        游戏 ROM 那条路（probeRomUrl → 播放地址）本来就是这么做的。
      */
      const fetchUrl = i === 0 && cacheUrl ? cacheUrl : source.url
      const data = await fetchWithProgress(fetchUrl, {
        phase: 'assets',
        signal: guard.signal,
        onProgress: (p) => {
          guard.tick()
          onProgress?.(p)
        },
        check: (res) => {
          const type = res.headers.get('content-type') ?? ''
          if (/text\/html|application\/xhtml/i.test(type)) throw new Error('返回的是网页不是镜像')
        },
      })
      if (!looksLikeSystemBundle(data)) throw new Error('不是一个合法的系统镜像（缺 .jsdos/dosbox.conf）')
      // 只有主源进缓存（上面那段注释）。写失败一律不管，缓存只是加速
      if (key && i === 0) void romCachePut(key, data).catch(() => {})
      return { data, url: source.url, label: source.label, usedFallback: i > 0, fromCache: false }
    } catch (e) {
      // 玩家自己取消：立刻出去，别把剩下的源也试一遍
      if (!stalled && signal?.aborted) throw e
      const why = stalled ? '一直没有数据' : e instanceof Error ? e.message : String(e)
      failures.push(`${source.label}：${why}`)
      console.warn(`[jsdos] 系统镜像 ${source.label} 取不到（${why}）`, source.url)
    } finally {
      guard.stop()
    }
  }
  throw new Error(`系统镜像所有来源都取不到 —— ${failures.join('；')}`)
}
