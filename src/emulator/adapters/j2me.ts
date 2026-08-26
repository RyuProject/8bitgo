/**
 * J2ME 运行时：Java 手机游戏 (.jar)。
 *
 * 用 freej2me-web（FreeJ2ME + CheerpJ）在独立 iframe 里跑。
 * 安装：npm run j2me   （拉取到 public/j2me/，仓库自带预构建 jar，不需要 Docker）
 * 启用：.env 设置 VITE_J2ME_PATH=/j2me/
 *
 * ── 加载契约（读 freej2me-web 的 web/src/main.js 得来，非文档推测）──────
 *
 *   run.html?jar=<文件名>     直接跑 jar，实际取 <J2ME_PATH>jar/<文件名>
 *   run.html?app=<app_id>     跑预打包的存档包，实际取 <J2ME_PATH>apps/<app_id>.zip
 *   run.html?fractionScale=1  只匹配宽高比，不整数倍缩放
 *   run.html?mobile=1         显示虚拟键盘
 *
 * 源码里的关键两行（main.js:328-334）：
 *   if (sp.get('app')) { ... args = ['app', sp.get('app')] }
 *   else { args = ['jar', cheerpjWebRoot + "/jar/" + (sp.get('jar') || "game.jar")] }
 *
 * ⚠️ jar 必须由服务器提供，且位于 <J2ME_PATH>jar/ 下 —— 路径是
 *    cheerpjWebRoot + "/jar/" + 名字 拼出来的，塞完整 URL 或 blob: 都会拼坏。
 *    所以玩家上传的本地 .jar 会先 POST 到后端临时目录，拿到随机文件名后再加载。
 *
 *    临时文件的清理是双保险：
 *      - 切换游戏 / 关闭页面时通知后端删除（pagehide + sendBeacon，尽力而为）
 *      - 后端按 TTL 定时清扫兜底 —— 浏览器崩溃、断网、强杀进程时不会有通知，
 *        只靠前端通知一定会漏，磁盘迟早被占满
 *
 * ⚠️ CheerpJ 从 leaningtech 的 CDN 加载，离线环境跑不了。
 */
import type { MountOptions, Runtime } from '../types'
import { getT, fmt } from '@/services/i18n'
import { apiBase, apiEnabled } from '@/services/api'

export const J2ME_PATH: string = (() => {
  const p = import.meta.env.VITE_J2ME_PATH || ''
  if (!p) return ''
  return p.endsWith('/') ? p : `${p}/`
})()

/** 从 URL / 对象存储 key 里取出文件名 */
function fileNameOf(url: string): string {
  const clean = url.split(/[?#]/)[0]
  return clean.slice(clean.lastIndexOf('/') + 1)
}

/**
 * 拼出 run.html 的地址。
 * .zip 走 app 模式（预打包存档包），其余按 jar 模式。
 */
function buildUrl(name: string): string {
  const base = `${J2ME_PATH}run.html`
  if (name.toLowerCase().endsWith('.zip')) {
    return `${base}?app=${encodeURIComponent(name.replace(/\.zip$/i, ''))}`
  }
  return `${base}?jar=${encodeURIComponent(name)}`
}


/* ---------------- 玩家上传的临时 jar ---------------- */

/** 把本地 jar 传到后端临时目录，返回服务器给的随机文件名 */
async function uploadTempJar(file: File): Promise<string> {
  const res = await fetch(`${apiBase()}/api/j2me/upload`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/java-archive' },
    body: file,
  })
  const data = (await res.json().catch(() => null)) as { name?: string; error?: string } | null
  if (!res.ok || !data?.name) throw new Error(data?.error || `HTTP ${res.status}`)
  return data.name
}

/** 告诉后端「还在玩」，给临时文件续期 */
function keepaliveTempJar(name: string) {
  void fetch(`${apiBase()}/api/j2me/keepalive`, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain' },
    body: JSON.stringify({ name }),
  }).catch(() => {})
}

/**
 * 通知后端删除临时 jar。
 * 优先用 sendBeacon —— 页面正在关闭时普通 fetch 常常发不出去。
 */
function releaseTempJar(name: string) {
  const url = `${apiBase()}/api/j2me/release`
  const body = JSON.stringify({ name })
  try {
    if (navigator.sendBeacon?.(url, new Blob([body], { type: 'text/plain' }))) return
  } catch {
    /* 退回 fetch */
  }
  void fetch(url, { method: 'POST', body, keepalive: true, headers: { 'Content-Type': 'text/plain' } }).catch(() => {})
}

function mount(container: HTMLElement, options: MountOptions): () => void {
  const rt = getT().runtime

  if (!J2ME_PATH) {
    options.onError?.(rt.j2meNotConfigured)
    return () => {}
  }

  const isFile = typeof options.game !== 'string'
  // 本地文件要先传到后端才能被 freej2me-web 取到，这需要后端存在
  if (isFile && !apiEnabled()) {
    options.onError?.(rt.j2meLocalUnsupported)
    return () => {}
  }

  const iframe = document.createElement('iframe')
  iframe.title = fmt(rt.emulatorTitle, { name: options.gameName })
  iframe.style.cssText = 'width:100%;height:100%;border:0;display:block;background:#000'
  iframe.setAttribute('allow', 'fullscreen; gamepad; autoplay; midi')
  iframe.addEventListener('load', () => options.onReady?.())
  iframe.addEventListener('error', () => options.onError?.(fmt(rt.j2meLoadFailed, { path: J2ME_PATH })))
  container.appendChild(iframe)

  let destroyed = false
  /** 本次上传的临时文件名，销毁时要通知后端删掉 */
  let tempName: string | null = null
  /** 心跳：玩的时间超过服务端 TTL 时，防止文件被清扫掉 */
  let heartbeat: ReturnType<typeof setInterval> | null = null

  // 页面关闭时也要删：unmount 在这种情况下不会执行
  const onPageHide = () => {
    if (tempName) releaseTempJar(tempName)
  }
  window.addEventListener('pagehide', onPageHide)

  void (async () => {
    try {
      let name: string
      if (isFile) {
        name = await uploadTempJar(options.game as File)
        if (destroyed) {
          // 上传期间已经被卸载了，直接把刚传上去的删掉
          releaseTempJar(name)
          return
        }
        tempName = name
        // 每 2 分钟续一次期。服务端默认 TTL 30 分钟，留足余量。
        heartbeat = setInterval(() => {
          if (tempName) keepaliveTempJar(tempName)
        }, 120_000)
      } else {
        name = fileNameOf(options.game as string)
      }
      iframe.src = buildUrl(name)
      options.onStart?.()
    } catch (e) {
      if (destroyed) return
      const msg = e instanceof Error ? e.message : String(e)
      options.onError?.(fmt(rt.j2meUploadFailed, { msg }))
    }
  })()

  return () => {
    destroyed = true
    window.removeEventListener('pagehide', onPageHide)
    if (heartbeat) clearInterval(heartbeat)
    if (tempName) {
      releaseTempJar(tempName)
      tempName = null
    }
    try {
      iframe.src = 'about:blank'
    } catch {
      /* ignore */
    }
    iframe.remove()
  }
}

export const j2meRuntime: Runtime = {
  id: 'j2me',
  name: 'FreeJ2ME',
  get description() {
    return getT().runtime.j2meDesc
  },
  extensions: ['jar', 'jad'],
  priority: 10,
  // 没装 / 没配置就当作不存在，解析阶段直接跳过
  available: () => Boolean(J2ME_PATH),
  supports: (platform) => platform === 'java',
  engineLabel: () => 'FreeJ2ME',
  mount,
}
