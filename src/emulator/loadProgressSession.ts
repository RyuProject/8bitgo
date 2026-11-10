import {
  createOverallRatio,
  createSpeedMeter,
  firstLoadProgressPhase,
  liftRatio,
  loadProgressDurationMs,
  loadProgressRange,
  nextLoadProgressPhase,
  nextStartupMilestone,
  startingSegmentMs,
  STARTING_MILESTONE_CAP,
  type LoadProgressPlan,
} from './loadProgress'
import type { LoadPhase, LoadProgress } from './types'

export const LOAD_PROGRESS_CEILING = 0.99

/**
 * 视觉计时器当前所在的小格。Windows 客体的 starting 阶段按已确认里程碑再细分，
 * 避免漫长的初始化预算让进度条看起来像停住；其它运行时不启用这层细分。
 */
type ProgressClock = {
  phase: LoadPhase
  startedAt: number
  from: number
  to: number
  startup: number
  milestones: boolean
}

function makeProgressClock(
  plan: LoadProgressPlan,
  phase: LoadPhase,
  startup = 0,
  milestones = false,
  now = Date.now(),
): ProgressClock {
  const [start, end] = loadProgressRange(plan, phase)
  const span = end - start
  const segmented = phase === 'starting' && milestones
  return {
    phase,
    startedAt: now,
    from: segmented ? start + span * startup : start,
    // 有里程碑时只准爬到下一个跟前，不能替客体声称尚未发生的启动步骤已完成。
    to: segmented ? start + span * nextStartupMilestone(startup) : end,
    startup: segmented ? startup : 0,
    milestones,
  }
}

export interface LoadProgressTick {
  phase: LoadPhase
  ratio: number
  speed: number
}

/**
 * 一次开局的进度状态机。把视觉计时、真实下载信号、阶段推进和速度统计放在同一处，
 * 这样重试时不会只重置 UI 或只重置合成器，造成进度冻结、倒退或继承上一局的速度。
 */
export function createLoadProgressSession(
  plan: LoadProgressPlan,
  options: { floor?: number; milestones?: boolean; now?: number } = {},
) {
  const floor = Math.min(LOAD_PROGRESS_CEILING, Math.max(0, options.floor ?? 0))
  const milestones = Boolean(options.milestones)
  const now = options.now ?? Date.now()
  const overallRatio = createOverallRatio(floor, plan)
  const speedMeter = createSpeedMeter()
  let shown = floor
  let clock = makeProgressClock(plan, firstLoadProgressPhase(plan), 0, milestones, now)
  let signal: { phase: LoadPhase; measurable: boolean } = { phase: clock.phase, measurable: false }

  const advance = (at: number) => {
    if (clock.phase === 'starting') {
      if (!clock.milestones) return
      const next = nextStartupMilestone(clock.startup)
      if (next >= 1) return
      clock = makeProgressClock(plan, 'starting', next, true, at)
      signal = { phase: 'starting', measurable: false }
      return
    }
    const next = nextLoadProgressPhase(plan, clock.phase)
    if (!next) return
    clock = makeProgressClock(plan, next, 0, clock.milestones, at)
    signal = { phase: next, measurable: false }
  }

  const enterPhase = (phase: LoadPhase, at: number) => {
    const nextIndex = plan.order.indexOf(phase)
    const currentIndex = plan.order.indexOf(clock.phase)
    // 并行请求可能乱序完成；忽略不在本策略里的阶段和迟到的早期回调。
    if (nextIndex < 0 || nextIndex <= currentIndex) return
    clock = makeProgressClock(plan, phase, 0, milestones, at)
    signal = { phase, measurable: false }
  }

  const enterMilestone = (startup: number | undefined, at: number) => {
    if (startup === undefined || !Number.isFinite(startup)) return
    if (clock.phase !== 'starting' || startup <= clock.startup + 1e-6) return
    clock = makeProgressClock(plan, 'starting', Math.min(STARTING_MILESTONE_CAP, startup), true, at)
  }

  return {
    plan,
    floor,
    get phase() { return clock.phase },
    get shown() { return shown },

    accept(progress: LoadProgress, at = Date.now()): number {
      enterPhase(progress.phase, at)
      enterMilestone(progress.startup, at)
      if (
        clock.phase === progress.phase &&
        ((progress.loaded !== undefined && progress.loaded > 0) || progress.ratio !== undefined)
      ) {
        signal = { phase: progress.phase, measurable: true }
      }
      speedMeter.push(progress.loaded, at)
      const actual = Math.min(LOAD_PROGRESS_CEILING, overallRatio(progress))
      shown = Math.max(shown, actual)

      // 下载真正到达阶段上界时立即推进，避免 EmulatorJS 不报 starting 时卡在 80%。
      const phaseEnd = liftRatio(floor, loadProgressRange(plan, clock.phase)[1])
      if (actual >= phaseEnd - 1e-6) advance(at)
      return shown
    },

    tick(at = Date.now(), launchDelaySeconds = 24): LoadProgressTick {
      const { phase, startedAt, from, to, startup, milestones: hasMilestones } = clock
      const duration = phase === 'starting' && hasMilestones
        ? startingSegmentMs(startup, true, launchDelaySeconds)
        : loadProgressDurationMs(plan, phase)
      const elapsed = at - startedAt
      const visualStart = Math.max(0.01, from)
      const visualEnd = Math.max(visualStart, Math.min(LOAD_PROGRESS_CEILING, to - 0.01))
      const measurable = signal.phase === phase && signal.measurable

      if (!measurable) {
        const timed = Math.min(
          LOAD_PROGRESS_CEILING,
          liftRatio(floor, visualStart + (visualEnd - visualStart) * Math.min(1, elapsed / duration)),
        )
        shown = Math.max(shown, timed)
      }
      if (elapsed >= duration && !measurable) advance(at)
      return { phase, ratio: shown, speed: speedMeter.read(at) }
    },
  }
}
