/**
 * 把 PSP 顺序预读层接到 Emscripten Fetch 唯一的 XHR 创建点。
 *
 * 生成胶水是一整行压缩 JS；只允许两个锁定片段各命中一次。Emscripten 升级后结构变化时
 * 必须停止构建并重新取证，不能用宽松正则把补丁误插进 data 包下载或其它 XHR。
 */
export function installPspRangeReadAhead(runtimeScript, source) {
  const marker = '__8bitgoCreatePspRangeXhr'
  const anchor = 'var Fetch={async openDatabase'
  const xhrNeedle = 'var xhr=new XMLHttpRequest;xhr.withCredentials='
  const xhrReplacement = 'var xhr=globalThis.__8bitgoCreatePspRangeXhr();xhr.withCredentials='

  if (runtimeScript.includes(marker)) {
    if (!runtimeScript.includes(xhrReplacement)) throw new Error('PPSSPP 预读源码存在，但 Emscripten Fetch 没有接入')
    return runtimeScript
  }
  if (!source.includes(marker)) throw new Error('PPSSPP 预读源码缺少安装标记')
  if (runtimeScript.split(anchor).length !== 2) throw new Error('无法唯一定位 Emscripten Fetch 初始化位置')
  if (runtimeScript.split(xhrNeedle).length !== 2) throw new Error('无法唯一定位 Emscripten Fetch XHR 创建位置')

  return runtimeScript
    .replace(anchor, `${source}\n${anchor}`)
    .replace(xhrNeedle, xhrReplacement)
}
