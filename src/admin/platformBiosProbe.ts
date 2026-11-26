import type { ProbeOutcome } from '@/services/roms'

export type PlatformBiosProbeState = 'checking' | 'ok' | 'missing' | 'rejected' | 'unconfirmed'

/**
 * BIOS 的管理提示不能把「浏览器拿不到结论」说成文件不存在。
 * 跨域缺少 CORS、插件拦截和网络中断在 fetch 里都会是 network。
 */
export function classifyPlatformBiosProbe(outcome: ProbeOutcome): PlatformBiosProbeState {
  if (outcome.url) return 'ok'
  if (outcome.reason === 'http') {
    return outcome.status === 404 || outcome.status === 410 ? 'missing' : 'rejected'
  }
  if (outcome.reason === 'html') return 'rejected'
  return 'unconfirmed'
}
