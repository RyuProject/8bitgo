/**
 * 自动开播失败后要不要再试一次（纯函数，Node 里能测：scripts/test-live-io.mjs ⑨）。
 *
 * 2026-11-19 /rooms「直播是不是坏了」：8bitgo.com 上的大陆访客取 socket.io 客户端要走
 * Cloudflare 洛杉矶，拥塞时 20～40 秒，一次超时自动开播就静默放弃、整局不再开播 ——
 * 这局游戏从此不出现在大厅里，玩家却以为自己在直播。网络类的失败过一会儿多半就好了，
 * 所以有限地补试；服务端明确拒绝的（满员、年龄门、不认识的游戏……）补多少次都一样，不试。
 */

/** 补试的间隔：失败后 15 秒再试一次，再失败 45 秒后最后一次。之后这一局就不再自动开播 */
export const AUTO_LIVE_RETRY_DELAYS_MS: readonly number[] = [15_000, 45_000]

/**
 * 确定的拒绝 —— 服务端 live.js 的 go-live ack，或客户端开播前的硬性检查。
 * 只认完整的原文，不做模糊匹配：漏认的错误顶多多试两次，误认则会把可恢复的失败当成永久的。
 */
const PERMANENT_FAILURES = new Set([
  'server is full',
  'too many rooms',
  'unknown game',
  'publisher account unavailable',
  'already in a room',
  'adult login required',
  'adult birth date required',
  'adult age restricted',
  'no capture source',
  'SRS publish grant is missing',
])

/**
 * @param error 开播抛出来的错误
 * @param noServerMessage 「后端没有 /live 命名空间」的本地化提示（getT().runtime.liveNoServer）：
 *   那是部署问题，等多久都不会自己好
 */
export function autoLiveRetryable(error: unknown, noServerMessage = ''): boolean {
  const message = error instanceof Error ? error.message : String(error ?? '')
  if (!message) return true
  if (noServerMessage && message === noServerMessage) return false
  return !PERMANENT_FAILURES.has(message)
}
