import { NDS_PERFORMANCE_SLOW_FPS, NDS_PERFORMANCE_SLOW_WINDOWS } from './ndsAdaptivePerformance'

/** 性能回升也要连续确认，避免帧率在阈值附近抖动时提示反复闪烁。 */
export const NDS_PERFORMANCE_RECOVERY_WINDOWS = NDS_PERFORMANCE_SLOW_WINDOWS

export type NdsPerformanceRecoveryWindow = {
  healthyWindows: number
  recovered: boolean
}

/** 只有连续多个窗口恢复到可玩阈值，才清除低帧率提示。 */
export function observeNdsPerformanceRecovery(
  fps: number,
  previousHealthyWindows: number,
  issueActive: boolean,
): NdsPerformanceRecoveryWindow {
  if (!issueActive || !Number.isFinite(fps) || fps < NDS_PERFORMANCE_SLOW_FPS) {
    return { healthyWindows: 0, recovered: false }
  }

  const healthyWindows = previousHealthyWindows + 1
  if (healthyWindows >= NDS_PERFORMANCE_RECOVERY_WINDOWS) {
    return { healthyWindows: 0, recovered: true }
  }

  return { healthyWindows, recovered: false }
}
