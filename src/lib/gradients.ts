import { hashString } from './format'

/** 一组适合深色界面的封面渐变 */
export const coverGradients = [
  'linear-gradient(135deg, #f97316 0%, #db2777 100%)',
  'linear-gradient(135deg, #8b5cf6 0%, #3b82f6 100%)',
  'linear-gradient(135deg, #22c55e 0%, #0ea5e9 100%)',
  'linear-gradient(135deg, #ef4444 0%, #f59e0b 100%)',
  'linear-gradient(135deg, #06b6d4 0%, #6366f1 100%)',
  'linear-gradient(135deg, #ec4899 0%, #8b5cf6 100%)',
  'linear-gradient(135deg, #facc15 0%, #f97316 100%)',
  'linear-gradient(135deg, #14b8a6 0%, #84cc16 100%)',
  'linear-gradient(135deg, #a855f7 0%, #ec4899 100%)',
  'linear-gradient(135deg, #0ea5e9 0%, #22d3ee 100%)',
  'linear-gradient(135deg, #f43f5e 0%, #7c3aed 100%)',
  'linear-gradient(135deg, #64748b 0%, #1e293b 100%)',
  'linear-gradient(135deg, #16a34a 0%, #065f46 100%)',
  'linear-gradient(135deg, #d946ef 0%, #f97316 100%)',
  'linear-gradient(135deg, #2563eb 0%, #1e1b4b 100%)',
  'linear-gradient(135deg, #b91c1c 0%, #1f2937 100%)',
]

export function gradientFor(key: string): string {
  return coverGradients[hashString(key) % coverGradients.length]
}
