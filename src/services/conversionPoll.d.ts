export interface ConversionPollOptions<T> {
  signal?: AbortSignal
  onUpdate?: (job: T) => void
  isCompleted: (job: T) => boolean
  isFailed: (job: T) => boolean
  failureMessage?: (job: T) => string
  pollIntervalMs?: number
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>
}

export function isTransientConversionPollError(error: unknown): boolean
export function waitForConversionJob<T>(
  read: () => Promise<T>,
  options: ConversionPollOptions<T>,
): Promise<T>
