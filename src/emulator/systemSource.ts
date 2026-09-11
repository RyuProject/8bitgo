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
 * 所以这里给每个镜像配一条**走完全不同网络路径**的备用源：js-dos 官方的
 * br.cdn.dos.zone。那几个地址是写死在 `public/jsdos/js-dos.js` 里的（studio 页面
 * 的下载列表），也就是我们这几个镜像的出处。
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

/**
 * js-dos 官方镜像站。地址来自 `public/jsdos/js-dos.js` 里 studio 的下载列表 ——
 * 也就是我们这几个系统镜像的原始出处。
 */
const OFFICIAL = 'https://br.cdn.dos.zone/js-dos/system'

/**
 * 我们的镜像路径 → 官方同一份镜像的地址。
 *
 * key 是**我们自己地址里的 pathname**（不含域名），这样换资源域名也不用动这张表。
 * ⚠️ 只登记「确实是同一个系统」的那些。见文件头第 1 条。
 */
const MIRRORS: Readonly<Record<string, string>> = {
  '/systems/dos/system-dos7.1-v1.jsdos': `${OFFICIAL}/system-dos7.1-v1.jsdos`,
  '/systems/dos/system-win311-v1.jsdos': `${OFFICIAL}/system-win311-v1.jsdos`,
  '/systems/dos/system-win95-v1.jsdos': `${OFFICIAL}/system-win95-v1.jsdos`,
  '/systems/dos/system-win98-v1.jsdos': `${OFFICIAL}/system-win98-v1.jsdos`,
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
  const mirror = MIRRORS[path]
  // 主源本身就是官方地址时不要重复排一遍
  if (mirror && mirror !== primaryUrl) list.push({ url: mirror, label: 'js-dos 官方源' })
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

  for (let i = 0; i < sources.length; i++) {
    const source = sources[i]
    if (signal?.aborted) throw new DOMException('已取消', 'AbortError')
    let stalled = false
    const guard = stallGuard(signal, () => {
      stalled = true
    })
    try {
      const data = await fetchWithProgress(source.url, {
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
      return { data, url: source.url, label: source.label, usedFallback: i > 0 }
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
