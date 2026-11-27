import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react'
import { api } from '@/services/api'

export interface HealthAlert {
  level: 'error' | 'warn' | 'info'
  key: string
  text: string
  link?: string
}

export interface JobQueue {
  kind: string
  active: number
  queued: number
  completed24h: number
  failed24h: number
  stalled: number
}

export interface HealthError {
  error: string
  missingTable?: boolean
}

export interface HealthSnapshot {
  generatedAt: string
  startup: { starts: number; playable: number; failures: number; slow: number; interrupted: number } | HealthError
  diagnostics: { groups: Array<{ signature: string; text: string; visits: number; count: number }> } | HealthError
  jobs: { queues: JobQueue[]; recentFailures: Array<{ id: string; kind: string; slug: string; lang: string; error: string; updatedAt: string | null }>; partialError: string | null } | HealthError
  content: { pendingComments: number; visibleWithoutRom: number; hiddenGames: number; draftPosts: number } | HealthError
  schema: { ok: boolean; missingTables?: unknown[]; missingColumns?: unknown[]; invalidDos?: unknown[]; nonStreamingWindows?: number; error?: string | null } | null
  edgePurge: { enabled: boolean; pending: boolean; last: { at: string; ok: boolean; error?: string } | null }
  alerts: HealthAlert[]
}

export interface AdminHealthState {
  snapshot: HealthSnapshot | null
  error: string
  refreshing: boolean
  refresh: () => void
}

const AdminHealthContext = createContext<AdminHealthState | null>(null)

/** 让全后台共用一份轮询，避免每个页面各自打健康接口、任务进度也不再只在概览可见。 */
export function AdminHealthProvider({ enabled, children }: { enabled: boolean; children: ReactNode }) {
  const [snapshot, setSnapshot] = useState<HealthSnapshot | null>(null)
  const [error, setError] = useState('')
  const [refreshing, setRefreshing] = useState(false)
  const inFlight = useRef(false)

  const load = useCallback(async (showBusy = true) => {
    if (!enabled || inFlight.current) return
    inFlight.current = true
    if (showBusy) setRefreshing(true)
    try {
      const result = await api.get<HealthSnapshot>('/api/admin/health', true)
      setSnapshot(result)
      setError('')
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '读取站点状态失败')
    } finally {
      inFlight.current = false
      setRefreshing(false)
    }
  }, [enabled])

  useEffect(() => {
    if (!enabled) return
    void load(false)
    const refreshWhenVisible = () => {
      if (document.visibilityState === 'visible') void load(false)
    }
    const timer = window.setInterval(refreshWhenVisible, 60_000)
    document.addEventListener('visibilitychange', refreshWhenVisible)
    return () => {
      window.clearInterval(timer)
      document.removeEventListener('visibilitychange', refreshWhenVisible)
    }
  }, [enabled, load])

  const refresh = useCallback(() => void load(true), [load])
  const value: AdminHealthState = {
    snapshot,
    error,
    refreshing,
    refresh,
  }

  return <AdminHealthContext.Provider value={value}>{children}</AdminHealthContext.Provider>
}

export function useAdminHealth(): AdminHealthState {
  const value = useContext(AdminHealthContext)
  if (!value) throw new Error('useAdminHealth 必须在 AdminHealthProvider 内使用')
  return value
}

export function hasHealthError<T>(section: T | HealthError): section is HealthError {
  return Boolean(section && typeof section === 'object' && 'error' in section)
}
