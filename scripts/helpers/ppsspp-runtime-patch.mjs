/**
 * 把 PSP 顺序预读层接到 Emscripten Fetch 唯一的 XHR 创建点。
 *
 * 生成胶水是一整行压缩 JS；只允许两个锁定片段各命中一次。Emscripten 升级后结构变化时
 * 必须停止构建并重新取证，不能用宽松正则把补丁误插进 data 包下载或其它 XHR。
 */
const marker = '__8bitgoCreatePspRangeXhr'
const sourceStart = '/* 8BITGO_PSP_RANGE_READ_AHEAD_START */'
const sourceEnd = '/* 8BITGO_PSP_RANGE_READ_AHEAD_END */'
const legacySourceStart = '/*\n * 8BitGo PPSSPP Range 顺序预读层。'
const anchor = 'var Fetch={async openDatabase'
const xhrNeedle = 'var xhr=new XMLHttpRequest;xhr.withCredentials='
const xhrReplacement = 'var xhr=globalThis.__8bitgoCreatePspRangeXhr();xhr.withCredentials='

const assertSource = (source) => {
  if (!source.includes(marker)) throw new Error('PPSSPP 预读源码缺少安装标记')
  if (source.split(sourceStart).length !== 2 || source.split(sourceEnd).length !== 2) {
    throw new Error('PPSSPP 预读源码缺少唯一的版本边界标记')
  }
}

/**
 * 在不重编 Wasm 的情况下换代纯 JS 预读器。旧 v9 发布物没有显式结束标记，因此只能用锁定的
 * Emscripten Fetch 锚点收口；任一锚点不唯一就拒绝生成，避免误改 18MB Wasm 对应的胶水。
 */
export function replacePspRangeReadAhead(runtimeScript, source) {
  assertSource(source)
  if (!runtimeScript.includes(xhrReplacement)) throw new Error('PPSSPP Emscripten Fetch 没有接入预读工厂')

  const markedStart = runtimeScript.indexOf(sourceStart)
  if (markedStart >= 0) {
    const markedEnd = runtimeScript.indexOf(sourceEnd, markedStart)
    if (markedEnd < 0 || runtimeScript.indexOf(sourceStart, markedStart + 1) >= 0) {
      throw new Error('PPSSPP 预读源码边界不唯一')
    }
    return `${runtimeScript.slice(0, markedStart)}${source}${runtimeScript.slice(markedEnd + sourceEnd.length)}`
  }

  const legacyStart = runtimeScript.indexOf(legacySourceStart)
  const legacyEnd = runtimeScript.indexOf(anchor, legacyStart)
  if (legacyStart < 0 || legacyEnd < 0 || runtimeScript.indexOf(legacySourceStart, legacyStart + 1) >= 0) {
    throw new Error('无法唯一定位旧版 PPSSPP 预读源码')
  }
  return `${runtimeScript.slice(0, legacyStart)}${source}\n${runtimeScript.slice(legacyEnd)}`
}

export function installPspRangeReadAhead(runtimeScript, source) {

  if (runtimeScript.includes(marker)) {
    if (!runtimeScript.includes(xhrReplacement)) throw new Error('PPSSPP 预读源码存在，但 Emscripten Fetch 没有接入')
    return replacePspRangeReadAhead(runtimeScript, source)
  }
  assertSource(source)
  if (runtimeScript.split(anchor).length !== 2) throw new Error('无法唯一定位 Emscripten Fetch 初始化位置')
  if (runtimeScript.split(xhrNeedle).length !== 2) throw new Error('无法唯一定位 Emscripten Fetch XHR 创建位置')

  return runtimeScript
    .replace(anchor, `${source}\n${anchor}`)
    .replace(xhrNeedle, xhrReplacement)
}
