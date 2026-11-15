export interface UploadActivity {
  id: number
  label: string
}

export interface UploadActivitySnapshot {
  active: readonly UploadActivity[]
  started: number
  failures: number
}

export interface UploadActivityOptions {
  failureIsFatal?: boolean
}

export function getUploadActivity(): UploadActivitySnapshot
export function subscribeUploadActivity(listener: () => void): () => void
export function beginUploadActivity(label: string): (failed?: boolean) => void
export function trackUploadActivity<T>(label: string, task: () => Promise<T>, options?: UploadActivityOptions): Promise<T>
