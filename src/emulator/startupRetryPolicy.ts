export type StartupFailureScope = 'runtime' | 'content' | 'config' | 'deterministic' | 'network'

/**
 * 只有内容类 / 确定性错误才允许跳过原地重试，直接找备用 ROM。
 * 网络错误的包装文案可能带有「8BG / ROM 包」，但超时和断流不会因为这些名词就变成坏文件；
 * scope 已由下载器按异常类型判定，优先于文字兜底，避免弱网把同一地址重试机会跳过去。
 */
export function isDeterministicStartupFailure(
  scope: StartupFailureScope | undefined,
  message: string,
): boolean {
  if (scope === 'network' || scope === 'runtime' || scope === 'config') return false
  return scope === 'deterministic' || /(?:8BG|ROM 包|Flash 站点锁)/i.test(message)
}
