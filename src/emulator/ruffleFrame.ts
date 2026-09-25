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
