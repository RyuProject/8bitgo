export type PerformanceProfile = 'quality' | 'balanced' | 'performance'

const STORAGE_KEY = '8bitgo:performance-profile'

export function readPerformanceProfile(): PerformanceProfile {
  try {
    const saved = localStorage.getItem(STORAGE_KEY)
    if (saved === 'quality' || saved === 'balanced' || saved === 'performance') return saved
  } catch {
    /* 隐私模式禁用存储时仍可按设备能力给默认值。 */
  }
  if (typeof navigator === 'undefined') return 'quality'
  const memory = Number((navigator as Navigator & { deviceMemory?: number }).deviceMemory) || 0
  const cores = navigator.hardwareConcurrency || 0
  return (memory > 0 && memory <= 4) || (cores > 0 && cores <= 4) ? 'balanced' : 'quality'
}

export function savePerformanceProfile(profile: PerformanceProfile) {
  try { localStorage.setItem(STORAGE_KEY, profile) } catch { /* 当前会话仍然生效 */ }
}
