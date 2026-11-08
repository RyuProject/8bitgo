/**
 * 判断 iframe 当前文档是不是本站给 Ruffle 准备的真正播放壳。
 *
 * iframe 插进 DOM 时，部分 Chromium / WebView 会先给初始 `about:blank` 派发一次 load，
 * 然后才开始请求显式设置的 src。只看 load 事件或 contentDocument 是否存在分不出这两次：
 * about:blank 同样有完整 document。用静态壳上的专用标记和舞台节点双重确认，避免把第一次
 * 误当成播放器已经就绪；同时也能挡住反代误回 SSR/404 HTML 的情况。
 */
export interface RuffleFrameDocumentLike {
  documentElement?: { getAttribute(name: string): string | null } | null
  getElementById(id: string): unknown
}

export function isRuffleFrameReady(doc: RuffleFrameDocumentLike | null | undefined): boolean {
  try {
    return doc?.documentElement?.getAttribute('data-8bitgo-ruffle-frame') === '1'
      && Boolean(doc.getElementById('host'))
      && Boolean(doc.getElementById('stage'))
  } catch {
    // 最终导航若意外变成跨源，读取 document 会抛；交给调用方的超时兜底报告一次即可。
    return false
  }
}

/**
 * 播放壳的 HTML，和 public/flash-frame.html 逐字相同（test-ruffle-performance 会核对）。
 *
 * 以前 iframe 一律导航到 `/flash-frame.html`：这个 600 字节的壳必须和页面同源，只能从 8bitgo.com
 * 取，大陆访客要绕 Cloudflare 洛杉矶，弱网下常常 10 秒还没回来（控制台
 * 「/flash-frame.html 10 秒内未就绪，重新加载一次」），而 SWF 和 Ruffle 早已在并行下载，
 * 整局就卡在一个空壳上。现在先在 iframe 里就地写出这份壳，一个网络请求都不用发。
 */
export const RUFFLE_FRAME_HTML = `<!doctype html>
<html lang="zh-CN" data-8bitgo-ruffle-frame="1">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
  html, body { margin: 0; height: 100%; background: #0b0b0f; overflow: hidden; }
  #host {
    width: 100%; height: 100%; contain: strict; overflow: hidden;
    display: grid; place-items: center; background: #0b0b0f;
  }
  #stage { width: 100%; height: 100%; min-width: 0; min-height: 0; transform-origin: center; }
  #stage > * { width: 100%; height: 100%; display: block; }
</style>
</head>
<body><div id="host"><div id="stage"></div></div></body>
</html>
`

/**
 * 在没有 src 的 iframe（初始 about:blank）里就地写出播放壳。成功返回 true。
 *
 * 关键在 `document.open()`：按 HTML 规范，由父页面调用时它会把子文档的 URL 改成父页面的 URL
 * （同源的 https 地址），所以随后 initFrame 里 `history.replaceState` 换成
 * `/flash-frames/<slug>/frame.html` 依然成立，Ruffle 的 SharedObject 路径和走网络加载时一模一样。
 * srcdoc 做不到这一点（URL 固定是 about:srcdoc，所有游戏存档会挤在同一条 /srcdoc/ 路径下）。
 * about:blank 也继承父页面的跨源隔离策略，/play-local 那种 require-corp 页面同样可用。
 * 任何一步异常都返回 false，调用方退回导航到 /flash-frame.html。
 */
export function writeInlineRuffleFrame(iframe: HTMLIFrameElement): boolean {
  try {
    const doc = iframe.contentDocument
    if (!doc || iframe.contentWindow?.location.href !== 'about:blank') return false
    doc.open()
    doc.write(RUFFLE_FRAME_HTML)
    doc.close()
    return isRuffleFrameReady(doc) && iframe.contentWindow?.location.protocol === window.location.protocol
  } catch {
    return false
  }
}
