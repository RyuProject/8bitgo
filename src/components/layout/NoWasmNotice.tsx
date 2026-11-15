import { useT } from '@/services/i18n'
import { useNoWasmMode } from '@/services/noWasm'

/**
 * 浏览器没有 WebAssembly（被禁用或不支持）时，全站顶部的一行提示。
 *
 * 服务端与水合那一遍永远不画（useNoWasmMode 的服务端快照是 false），
 * 所以正常访客的 HTML、边缘缓存、首屏都和以前一模一样；只有这类浏览器水合后多出这一条。
 */
export function NoWasmNotice() {
  const t = useT()
  const noWasm = useNoWasmMode()
  if (!noWasm) return null
  return (
    <div className="container-x pt-3">
      <p
        role="status"
        className="flex items-start gap-2 rounded-card border border-coin/50 bg-coin/15 px-4 py-2.5 text-sm leading-relaxed"
      >
        <span aria-hidden className="shrink-0 select-none">⚠️</span>
        <span className="min-w-0 break-words text-fg">{t.site.noWasmNotice}</span>
      </p>
    </div>
  )
}
