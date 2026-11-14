/**
 * 低内存核心（fbneo-lowmem，起步 80 MiB）也分配不出 WASM 内存时，还能做的三件事。
 *
 * 2026-11-14 大陆 Chrome 114 / Android 12、8GB《拳皇97》：默认 FBNeo（128 MiB）和低内存核心先后都在
 * instantiate 报 `Out of memory: Cannot allocate Wasm memory for new instance`。8GB 的机器给不出 80 MiB，
 * 说明不是物理内存小，而是这个渲染进程的地址空间给不出来。两种可能，诊断包目前分不清：
 *   - 32 位内核的浏览器：国内手机自带浏览器（华为 / 小米 / OPPO / vivo / 夸克 …）多是 Chromium 改的，
 *     UA 里照样写「Chrome/114」，后台原来一律归成 Chrome；
 *   - 64 位，但同一页面里先前的引擎 iframe、ROM 副本等还没被回收，地址空间被占碎。
 *
 * 所以：
 *   1. `vendorBrowserName`：认出应用内 / 厂商浏览器，直接告诉玩家用 Chrome / Edge / Firefox 打开；
 *   2. `probeWasmMemoryCeilingMB`：失败那一刻实测还能划出多大一块 WASM 内存，写进诊断包，
 *      下一份现场就能分清「整个进程都给不出」还是「只是这一刻」；
 *   3. `takeCleanPageRetry`：换一个干净的文档重开一次（整页导航带 ?autoplay=1），旧文档里的
 *      iframe、ROM 副本、编译产物随之释放。每局只自动做一次，避免反复刷新。
 */

import { fmt, getT } from '@/services/i18n'

/**
 * UA 里带厂商 / 应用内浏览器标记时返回它的名字（不翻译，品牌名本身），普通 Chrome / Edge / Firefox 返回 null。
 * 顺序有讲究：这些 UA 都带 Chrome/xxx，要先认厂商标记。
 */
const VENDOR_BROWSERS: ReadonlyArray<readonly [string, RegExp]> = [
  ['WeChat', /MicroMessenger\//i],
  ['QQ', /\bQQ\/|MQQBrowser\//i],
  ['UC', /UCBrowser\//i],
  ['Quark', /Quark\//i],
  ['Huawei Browser', /HuaweiBrowser\//i],
  ['Mi Browser', /MiuiBrowser\/|XiaoMi\/MiuiBrowser/i],
  ['OPPO Browser', /HeyTapBrowser\/|OppoBrowser\//i],
  ['vivo Browser', /VivoBrowser\//i],
  ['Baidu', /baiduboxapp\/|BaiduBrowser\//i],
  ['360', /QihooBrowser\/|360 ?(?:Aphone|SE|EE)/i],
  ['Sogou', /SogouMobileBrowser\/|SE \d+\.X MetaSr/i],
  ['DingTalk', /DingTalk\//i],
  ['Alipay', /AlipayClient\//i],
]

export function vendorBrowserName(ua: string): string | null {
  for (const [name, re] of VENDOR_BROWSERS) if (re.test(ua)) return name
  return null
}

const WASM_PAGE = 64 * 1024
/** 从大到小试，第一次成功就停：通常一次分配就有结论，不在已经吃紧的进程里多占地址空间 */
const PROBE_STEPS_MB = [512, 256, 128, 80, 48, 32, 16]

/**
 * 现在这个页面还能新建多大的 WASM 内存（MB），一块都建不出来返回 0；不支持 WebAssembly 返回 null。
 * 建出来的对象立刻丢掉引用，等 GC 回收（V8 分配失败时自己也会先触发一次 GC 再试）。
 */
export function probeWasmMemoryCeilingMB(
  memoryCtor: (typeof WebAssembly)['Memory'] | null = typeof WebAssembly === 'undefined' ? null : WebAssembly.Memory,
): number | null {
  if (typeof memoryCtor !== 'function') return null
  for (const mb of PROBE_STEPS_MB) {
    try {
      // eslint-disable-next-line no-new
      new memoryCtor({ initial: (mb * 1024 * 1024) / WASM_PAGE })
      return mb
    } catch {
      /* 再试小一档 */
    }
  }
  return 0
}

const CLEAN_RETRY_KEY = '8bitgo.oom-clean-retry'
/** 十分钟内同一款游戏只自动整页重开一次：第二次还失败就是环境问题，再刷新只是让玩家多等 */
const CLEAN_RETRY_WINDOW_MS = 10 * 60 * 1000

function sessionStore(): Pick<Storage, 'getItem' | 'setItem'> | null {
  try {
    return typeof sessionStorage === 'undefined' ? null : sessionStorage
  } catch {
    return null
  }
}

/**
 * 能不能为这款游戏自动整页重开一次；能就顺手记账（同一个调用里判断 + 占位，不会连刷两次）。
 * 存储不可用（无痕 / 被禁）时不重开：没法防循环，宁可直接报错。
 */
export function takeCleanPageRetry(
  slug: string,
  store: Pick<Storage, 'getItem' | 'setItem'> | null = sessionStore(),
  now = Date.now(),
): boolean {
  if (!slug || !store) return false
  try {
    const raw = JSON.parse(store.getItem(CLEAN_RETRY_KEY) || '{}') as Record<string, number>
    const at = Number(raw[slug])
    if (Number.isFinite(at) && at > 0 && now - at >= 0 && now - at < CLEAN_RETRY_WINDOW_MS) return false
    raw[slug] = now
    store.setItem(CLEAN_RETRY_KEY, JSON.stringify(raw))
    return true
  } catch {
    return false
  }
}

/**
 * 整页重开用的地址：只在游戏详情页（`/games/<slug>`，可带语言前缀）上做，那里认 `?autoplay=1`。
 * 其它页面（TV、嵌入、本地 ROM）返回 null，照常报错。
 */
export function cleanPageRetryUrl(href: string): string | null {
  try {
    const url = new URL(href)
    if (!/(?:^|\/)games\/[^/]+\/?$/.test(url.pathname)) return null
    url.searchParams.set('autoplay', '1')
    url.hash = ''
    return url.toString()
  } catch {
    return null
  }
}

/** 低内存核心也分配不出内存时给玩家的话：厂商 / 应用内浏览器直接点名，让他换 Chrome / Edge / Firefox */
export function lowmemOomMessage(vendor: string | null): string {
  const rt = getT().runtime
  return vendor ? fmt(rt.ejsOutOfMemoryVendor, { browser: vendor }) : rt.ejsOutOfMemoryLowmem
}

/** 播放器据此决定要不要换干净页面重开一次（EmulatorPlayer 的 onError） */
export function isLowmemOomMessage(message: string): boolean {
  const rt = getT().runtime
  if (message === rt.ejsOutOfMemoryLowmem) return true
  const [head, tail] = rt.ejsOutOfMemoryVendor.split('{browser}')
  return Boolean(head || tail) && message.startsWith(head) && message.endsWith(tail ?? '')
}
