/** GBA 联机核心每次 timerCallback 固定推进一帧，不能直接跟随屏幕刷新率。 */
export const GBA_LINK_FRAME_MS = 1000 / 60
export const GBA_LINK_MAX_CATCH_UP_FRAMES = 2
/** 通道仍显示 connected、但输入不再抵达时，避免玩家无限期卡在同一帧。 */
export const GBA_LINK_REMOTE_WAIT_TIMEOUT_MS = 15_000

export function gbaLinkRemoteWaitExpired(startedAt: number | null, now: number, visible: boolean): boolean {
  return visible && startedAt !== null && Number.isFinite(now) && now - startedAt >= GBA_LINK_REMOTE_WAIT_TIMEOUT_MS
}

export interface GbaLinkFrameClock {
  lastRafTimestamp: number | null
  accumulatedMs: number
}

export function createGbaLinkFrameClock(): GbaLinkFrameClock {
  return { lastRafTimestamp: null, accumulatedMs: 0 }
}

/**
 * 按 60Hz 推进锁步帧；网络未收到当前帧时保留累积时间，但最多追 2 帧，避免恢复网络后长任务卡住手机。
 * advance 返回 false 表示当前帧还不能安全推进（例如尚未收到对端输入）。
 */
export function advanceGbaLinkFrameClock(
  clock: GbaLinkFrameClock,
  rafTimestamp: number,
  advance: (frameTimestamp: number) => boolean,
): number {
  if (!Number.isFinite(rafTimestamp)) return 0
  if (clock.lastRafTimestamp === null) {
    clock.lastRafTimestamp = rafTimestamp
    return 0
  }

  const elapsed = Math.max(0, rafTimestamp - clock.lastRafTimestamp)
  clock.lastRafTimestamp = rafTimestamp
  const maxAccumulated = GBA_LINK_FRAME_MS * GBA_LINK_MAX_CATCH_UP_FRAMES
  clock.accumulatedMs = Math.min(maxAccumulated, clock.accumulatedMs + elapsed)

  let advanced = 0
  while (clock.accumulatedMs + 1e-6 >= GBA_LINK_FRAME_MS && advanced < GBA_LINK_MAX_CATCH_UP_FRAMES) {
    const frameTimestamp = rafTimestamp - clock.accumulatedMs + GBA_LINK_FRAME_MS
    if (!advance(frameTimestamp)) break
    clock.accumulatedMs = Math.max(0, clock.accumulatedMs - GBA_LINK_FRAME_MS)
    advanced++
  }
  return advanced
}
