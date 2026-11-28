/** 描述运行时支持格式所需的最小信息，便于在不加载大型适配器的情况下挑安全回退。 */
export interface RuntimeFallbackDescriptor {
  id: string
  extensions: readonly string[]
}

/**
 * 运行时主动拒绝 ROM 后，仅允许换到声明支持该文件格式的引擎。
 *
 * `runtimesFor()` 只回答“能跑这个平台吗”，不保证它能读当前 ROM；尤其 Play! 虽支持 arcade 平台，
 * 但街机上的 Play! 只能由逐游戏配置显式选择，通用失败回退没有这份配置上下文，不能把它当候选。
 * 没有扩展名就没有格式证据，宁可让玩家看到原始不支持原因，也不盲试另一个核心。
 */
export function canAutoFallbackRuntime(
  platform: string,
  extension: string | undefined,
  candidate: RuntimeFallbackDescriptor,
  ruledOut: readonly string[] = [],
): boolean {
  if (!extension || ruledOut.includes(candidate.id)) return false
  if (platform === 'arcade' && candidate.id === 'play') return false
  return candidate.extensions.includes(extension.toLowerCase())
}
