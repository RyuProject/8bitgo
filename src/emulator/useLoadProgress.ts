import { useEffect, useRef, useState, type MutableRefObject } from 'react'
import type { DosBackend } from '@/types'
import type { LoadProgressPlan } from './loadProgress'
import { DEFAULT_LOAD_PROGRESS_PLAN, firstLoadProgressPhase } from './loadProgress'
import { createLoadProgressSession } from './loadProgressSession'
import type { LoadPhase, LoadProgress } from './types'

type DiscSize = {
  bytes: number
  loaded: number
  cached: boolean
  streaming: boolean
}

interface Options {
  status: 'idle' | 'loading' | 'running' | 'error'
  sessionId?: number
  dosBackendRef: MutableRefObject<DosBackend | undefined>
  dosSystemUrlRef: MutableRefObject<string | undefined>
  dosLaunchDelayRef: MutableRefObject<number | undefined>
}

/**
 * 加载遮罩需要的 UI 状态与进度状态机。
 * 播放器只负责把运行时事件交进来、把结果交给组件树，不再承担计时、测速和阶段协调。
 */
export function useLoadProgress({
  status,
  sessionId,
  dosBackendRef,
  dosSystemUrlRef,
  dosLaunchDelayRef,
}: Options) {
  const [ratio, setRatio] = useState<number | null>(null)
  const ratioRef = useRef<number | null>(ratio)
  ratioRef.current = ratio
  const planRef = useRef<LoadProgressPlan>(DEFAULT_LOAD_PROGRESS_PLAN)
  const sessionRef = useRef(createLoadProgressSession(DEFAULT_LOAD_PROGRESS_PLAN))
  const [speed, setSpeed] = useState(0)
  const [phase, setPhase] = useState<LoadPhase>(() => firstLoadProgressPhase(DEFAULT_LOAD_PROGRESS_PLAN))
  const [detail, setDetail] = useState<LoadProgress['detail']>()
  const [streaming, setStreaming] = useState(false)
  const [discSize, setDiscSize] = useState<DiscSize | null>(null)

  const reset = (plan: LoadProgressPlan, options: { carryOver?: boolean } = {}) => {
    const carryOver = Boolean(options.carryOver)
    const floor = carryOver ? ratioRef.current ?? 0 : 0
    const milestones = dosBackendRef.current === 'dosboxX' && Boolean(dosSystemUrlRef.current)
    planRef.current = plan
    sessionRef.current = createLoadProgressSession(plan, { floor, milestones })
    setSpeed(0)
    setDiscSize(null)
    setPhase(sessionRef.current.phase)
    setDetail(undefined)
    setStreaming(false)
    if (!carryOver) setRatio(null)
  }

  const accept = (progress: LoadProgress) => {
    const shown = sessionRef.current.accept(progress)
    setRatio((current) => Math.max(current ?? 0, shown))
    return shown
  }

  const updateDiscSize = (progress: LoadProgress, noticeThreshold: number) => {
    setDetail(progress.detail)
    if (progress.streaming) setStreaming(true)
    if (progress.phase !== 'rom') return

    setDiscSize((current) => {
      const bytes = progress.total ?? current?.bytes ?? 0
      if (bytes < noticeThreshold) return current
      return {
        bytes,
        // 断点续传会把已落盘分片一起报上来；这里保留真实字节数，不用百分比反推。
        loaded: Math.min(progress.loaded ?? current?.loaded ?? 0, bytes),
        cached: progress.cached ?? current?.cached ?? false,
        streaming: progress.streaming ?? current?.streaming ?? false,
      }
    })
  }

  useEffect(() => {
    if (status !== 'loading' || sessionId === undefined) return
    setRatio((current) => Math.max(current ?? 0, 0.01))
    const timer = window.setInterval(() => {
      const tick = sessionRef.current.tick(Date.now(), dosLaunchDelayRef.current)
      setRatio((current) => Math.max(current ?? 0, tick.ratio))
      setPhase(tick.phase)
      setSpeed(tick.speed)
    }, 250)
    return () => window.clearInterval(timer)
  }, [status, sessionId])

  return {
    ratio,
    setRatio,
    speed,
    phase,
    detail,
    streaming,
    discSize,
    planRef,
    reset,
    accept,
    updateDiscSize,
  }
}
