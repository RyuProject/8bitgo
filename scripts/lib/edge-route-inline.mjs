export const EDGE_ROUTE_PLACEHOLDER = '<script data-8bitgo-edge-route-placeholder></script>'
export const EDGE_ROUTE_INLINE_OPEN = '<script data-cfasync="false" data-8bitgo-edge-route="v6">\n'

/**
 * 在 HTML 的显式占位处内联首屏选路脚本。
 *
 * 选路必须先于语言跳转和应用资源请求同步完成；独立脚本即使预载，也仍要等待一次
 * HTML 解析与脚本执行往返。构建期内联保留原执行顺序，并让浏览器缓存中的旧 HTML
 * 继续通过 public/edge-route-v6.js 工作。
 */
export function inlineEdgeRouteHtml(html, source) {
  const input = String(html)
  const script = String(source).trimEnd()
  const markerCount = input.split(EDGE_ROUTE_PLACEHOLDER).length - 1

  if (markerCount !== 1) {
    throw new Error(`index.html 必须恰好包含一个边缘选路占位符，实际为 ${markerCount}`)
  }
  if (/<\/script/i.test(script)) {
    throw new Error('边缘选路脚本包含 HTML 结束标签，不能安全内联')
  }

  return input.replace(
    EDGE_ROUTE_PLACEHOLDER,
    `${EDGE_ROUTE_INLINE_OPEN}${script}\n</script>`,
  )
}
