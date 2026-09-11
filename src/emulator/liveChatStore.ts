import type { LiveChatMessage } from '@/services/live'

/**
 * 弹幕列表的两条纯逻辑：留多少条、怎么追加。
 *
 * ⚠️ 单独一个 `.ts` 而不是留在 `LiveChat.tsx` 里，是为了**能被测到**：
 * 回归测试走 `--experimental-strip-types`，那条路只剥类型、不转 JSX，
 * 所以 `.tsx` 根本 import 不进来（ERR_UNKNOWN_FILE_EXTENSION）。
 * 这两件事错了都不报错，只会让历史面板里少一条 / 多一堆重复，必须有测试。
 */

/**
 * 本地最多留多少条弹幕。
 *
 * **2026-09-11 从 16 抬回 100**：站长要观众端右栏有一段弹幕历史，所以这个数组重新
 * 承担「历史」这个身份（16 那一版只够喂飘幕，注释里写的就是「这不是历史」）。
 *
 * 100 是站长定的上限。只在内存里：`useLiveChat` 跟着 `session.id` 清空，
 * 换一局 / 散场都不留痕，和服务端那份 30 条环形缓冲一样是「当下」的东西。
 * **别顺手加持久化** —— 存下来就得再配一套删除、举报、审核，那是评论该干的事。
 *
 * ⚠️ 抬高之后飘幕那边**必须**认 `history` 标记，否则进房时补的三十条会一次性起飞
 * （见 LiveChat.tsx 里 flyable 那一行）。
 */
export const KEEP = 100

/**
 * 往列表里追一条。
 *
 * ⚠️ 去重按 id：服务端重连、以及进房补历史时都可能重发同一条。
 * 补历史那一批尤其容易和「刚收到的新消息」撞上（环形缓冲里就有那几条）。
 * 撞上时**原样返回旧数组**，省掉一次没有意义的重渲染。
 */
export function appendChat(prev: LiveChatMessage[], msg: LiveChatMessage): LiveChatMessage[] {
  if (prev.some((m) => m.id === msg.id)) return prev
  const next = [...prev, msg]
  return next.length > KEEP ? next.slice(next.length - KEEP) : next
}
