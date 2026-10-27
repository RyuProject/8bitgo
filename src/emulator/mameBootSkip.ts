/**
 * 街机开机自检的快进。
 *
 * ── 为什么（2026-10-28《狂热节拍》）──────────────────────────────
 * Konami DJ Main 的开机自检要把 16MB 的音源 DRAM（画面上的「S RAM」）整块读写一遍，
 * 再检查硬盘（「HDD」）。MAME 按原速模拟，实测从开局到「S RAM OK / HDD OK」要 ~69 秒，
 * 到 KONAMI 标志 ~77 秒 —— 这段时间画面停在一张清单上，S RAM / HDD 两行迟迟不出 OK，
 * 玩家以为坏了。这是实机行为，不是错误：真出错会显示 E114（S RAM）/ E710（HDD）并停住。
 *
 * 自检全程静音、不需要输入，所以开局后用 RetroArch 的快进（不限倍率）跑过去：
 * 实测约 5 秒就到 KONAMI 标志。在标志出现前停下，片头音乐按原速播。
 *
 * 只收实测过的 romset（帧数是 RetroArch 的帧计数，从核心启动算起）。别的游戏开机流程
 * 长短不一，盲目快进可能把需要玩家看的画面一并跳过。
 */

/** romset → 自检结束前、片头开始前的帧数。bm1stmix：KONAMI 标志在第 ~4500 帧出现 */
export const MAME_BOOT_FAST_FORWARD_FRAMES: Readonly<Record<string, number>> = {
  bm1stmix: 4300,
}

export function mameBootFastForwardFrames(romset: string | null | undefined): number {
  return MAME_BOOT_FAST_FORWARD_FRAMES[String(romset ?? '').toLowerCase()] ?? 0
}

export interface BootFastForwardTarget {
  getFrameNum?: () => number
  toggleFastForward?: (on: number) => void
  setFastForwardRatio?: (ratio: number) => void
}

/**
 * 快进到 `targetFrames` 再恢复原速。返回取消函数（销毁 / 进联机时调用，立刻恢复原速）。
 * 读不到帧数、没有快进接口时什么都不做；最多跑 `timeoutMs`，防止帧计数不涨时一直快进。
 */
export function fastForwardBoot(
  gm: BootFastForwardTarget,
  targetFrames: number,
  { restoreRatio = 3, timeoutMs = 20_000, pollMs = 100 }: { restoreRatio?: number; timeoutMs?: number; pollMs?: number } = {},
): () => void {
  if (!(targetFrames > 0) || typeof gm.getFrameNum !== 'function' || typeof gm.toggleFastForward !== 'function') return () => {}
  let frame: number
  try {
    frame = gm.getFrameNum()
  } catch {
    return () => {}
  }
  if (!(frame < targetFrames)) return () => {}
  let done = false
  let timer: ReturnType<typeof setInterval> | null = null
  const startedAt = Date.now()
  const stop = () => {
    if (done) return
    done = true
    if (timer) clearInterval(timer)
    try {
      gm.toggleFastForward?.(0)
      gm.setFastForwardRatio?.(restoreRatio)
    } catch {
      /* 引擎已经销毁 */
    }
  }
  try {
    // 0 = 不限倍率。引擎默认的 3 倍要 25 秒，不限倍率实测约 5 秒
    gm.setFastForwardRatio?.(0)
    gm.toggleFastForward(1)
  } catch {
    stop()
    return stop
  }
  timer = setInterval(() => {
    let now = targetFrames
    try {
      now = gm.getFrameNum?.() ?? targetFrames
    } catch {
      /* 读不到就当到了 */
    }
    if (now >= targetFrames || Date.now() - startedAt > timeoutMs) stop()
  }, pollMs)
  return stop
}
