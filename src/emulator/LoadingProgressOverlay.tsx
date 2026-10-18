import { AdSenseSlot } from '@/components/ads/AdSenseSlot'

interface LoadingProgressOverlayProps {
  loadingLabel: string
  ratio: number
  speedText: string
  discText: string
  speedInDiscText: boolean
  progressBoundaries: number[]
}

/**
 * 独立保留加载遮罩，方便用固定进度做视觉回归；真实页面仍只传适配器上报的字节数。
 */
export function LoadingProgressOverlay({
  loadingLabel,
  ratio,
  speedText,
  discText,
  speedInDiscText,
  progressBoundaries,
}: LoadingProgressOverlayProps) {
  const percentage = Math.round(ratio * 100)
  const ariaValueText = [loadingLabel, `${percentage}%`, discText, speedText].filter(Boolean).join(' · ')

  return (
    <div className="absolute inset-0 z-10 flex items-center justify-center bg-black px-8">
      <div className="flex w-full max-w-xs flex-col items-center gap-3">
        <AdSenseSlot slot="9386967599" format="horizontal" responsive={false} className="w-full" />
        <p className="text-sm font-medium tracking-wide text-white/90">
          {loadingLabel} <span className="tabular-nums text-brand-hover">{percentage}%</span>
          {speedText && !speedInDiscText && (
            <span className="ml-2 inline-block min-w-[4.5rem] text-left tabular-nums text-[11px] text-white/45">
              {speedText}
            </span>
          )}
        </p>
        {discText && (
          <p className="-mt-1 text-[11px] text-white/45">
            {discText}
            {speedInDiscText && (
              <span className="ml-1.5 tabular-nums text-white/45">· {speedText}</span>
            )}
          </p>
        )}
        <div
          role="progressbar"
          aria-label={loadingLabel}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={percentage}
          aria-valuetext={ariaValueText}
          className="relative h-1.5 w-full overflow-hidden rounded-full bg-white/15"
        >
          <div
            className="h-full rounded-full bg-brand-hover transition-[width] duration-300 ease-out"
            style={{ width: `${percentage}%` }}
          />
          {progressBoundaries.map((boundary) => (
            <span
              key={boundary}
              aria-hidden
              className="absolute inset-y-0 w-px bg-black/35"
              style={{ left: `${boundary * 100}%` }}
            />
          ))}
        </div>
      </div>
    </div>
  )
}
