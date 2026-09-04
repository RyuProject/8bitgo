/**
 * 「创建联机房间」的命令通道。
 *
 * 按钮画在游戏详情页上，而真正能开房的 openMatch() 住在 EmulatorPlayer 里 ——
 * 中间隔着好几层组件，为这一件事把回调一路传下去不值得。照搬 services/authModal.ts
 * 那个模块级订阅：谁都能命令式地喊一声，播放器听着。
 *
 * 语义是「我想开房」而不是「立刻开房」：喊的时候游戏可能还没开始（玩家一进详情页
 * 就点了），播放器会先把游戏跑起来，running 之后自己接上开房那一步。
 */
let seq = 0
const listeners = new Set<(n: number) => void>()

/** 详情页那个「👥 创建联机房间」按下时调。多点几下只当一次 —— 播放器自己会去重 */
export function requestMatch() {
  seq += 1
  for (const l of listeners) l(seq)
}

/** 播放器挂载时订阅；返回退订函数 */
export function onMatchRequest(fn: (n: number) => void): () => void {
  listeners.add(fn)
  return () => {
    listeners.delete(fn)
  }
}
