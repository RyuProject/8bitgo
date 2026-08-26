import { useCallback, useEffect, useRef, useState, type DragEvent, type ReactNode } from 'react'
import type { Platform, PlatformId } from '@/types'
import { platformMap } from '@/data/platforms'
import { formatBytes, isRomFileAccepted } from '@/lib/emulator'
import { detectRom, describeDetection } from '@/runtimes/detect'
import { resolveRuntime, type Runtime } from '@/runtimes/registry'
import { cx } from '@/lib/format'
import { Button } from '@/components/ui/Button'
import { useShell } from '@/components/layout/ShellContext'
import { useT, fmt } from '@/services/i18n'
import { platformLabel } from '@/services/i18nData'

type Status = 'idle' | 'loading' | 'running' | 'error'

interface ActiveSession {
  id: number
  game: File | string
  /** 实际运行的平台（本地文件被识别为其他平台时可能与页面平台不同） */
  platform: PlatformId
  runtime: Runtime
}

interface Props {
  platform: Platform
  gameName: string
  /** 空闲态背景（例如封面） */
  backdrop?: ReactNode
  /** 空闲态显示的图标 */
  icon?: string
  className?: string
  /** 若有可直接访问的 ROM URL（对象存储 / 自制开源游戏），可跳过上传 */
  romUrl?: string
  /** 正在探测云端 ROM 是否存在 */
  romChecking?: boolean
  /**
   * 本地文件识别出的平台与页面平台不一致时如何处理：
   *   'switch' —— 用识别出的平台运行（玩本地 ROM 页）
   *   'warn'   —— 提示但仍按页面平台运行（游戏详情页）
   */
  onDetectMismatch?: 'switch' | 'warn'
  /** 平台切换回调（onDetectMismatch = 'switch' 时触发） */
  onPlatformChange?: (platform: PlatformId) => void
}

/**
 * 通用播放器：根据平台从运行时注册表选择模拟器（EmulatorJS / Ruffle …）。
 *  idle    —— 显示封面与「选择 ROM 开始游戏」，支持拖拽
 *  loading —— 已选择文件，运行时资源加载中
 *  running —— 运行时已就绪（运行在独立 iframe 内）
 */
export function EmulatorPlayer({
  platform,
  gameName,
  backdrop,
  icon,
  className,
  romUrl,
  romChecking,
  onDetectMismatch = 'warn',
  onPlatformChange,
}: Props) {
  const [status, setStatus] = useState<Status>('idle')
  const [file, setFile] = useState<File | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [dragging, setDragging] = useState(false)
  const [session, setSession] = useState<ActiveSession | null>(null)

  const hostRef = useRef<HTMLDivElement>(null)
  const frameRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const sessionCounter = useRef(0)

  const pageRuntime = resolveRuntime(platform.id)
  const supported = Boolean(pageRuntime)
  const { immersive, toggleImmersive } = useShell()
  const t = useT()

  // 会话变化时挂载 / 卸载运行时
  useEffect(() => {
    const host = frameRef.current
    if (!session || !host) return
    const destroy = session.runtime.mount(host, {
      platform: session.platform,
      game: session.game,
      gameName,
      onReady: () => setStatus('running'),
      onError: (message: string) => {
        setError(message)
        setStatus('error')
      },
    })
    return destroy
  }, [session, gameName])

  const begin = (game: File | string, targetPlatform: PlatformId, runtime: Runtime) => {
    sessionCounter.current += 1
    setSession({ id: sessionCounter.current, game, platform: targetPlatform, runtime })
    setStatus('loading')
  }

  const start = useCallback(
    async (picked: File | null) => {
      setError(null)
      setNotice(null)

      // 云端 ROM
      if (!picked) {
        if (!romUrl || !pageRuntime) return
        begin(romUrl, platform.id, pageRuntime)
        return
      }

      // 本地文件：先嗅探类型，决定运行时
      const detection = await detectRom(picked)
      let targetPlatform: PlatformId = platform.id
      if (detection.platform && detection.platform !== platform.id && detection.confidence !== 'low') {
        if (onDetectMismatch === 'switch') {
          targetPlatform = detection.platform
          onPlatformChange?.(detection.platform)
          setNotice(describeDetection(detection))
        } else if (!isRomFileAccepted(picked, platform.romExtensions)) {
          // 页面平台不接受这种文件，但识别出了别的平台：直接用识别结果运行
          targetPlatform = detection.platform
          setNotice(fmt(t.player.detectUse, { reason: describeDetection(detection) }))
        } else {
          setNotice(
            fmt(t.player.detectKeep, {
              reason: describeDetection(detection),
              platform: platformLabel(t, platform.id, platform.name),
            }),
          )
        }
      } else if (!isRomFileAccepted(picked, platform.romExtensions)) {
        setError(
          fmt(t.player.badFormat, {
            platform: platformLabel(t, platform.id, platform.name),
            exts: platform.romExtensions.join(t.player.extSep),
          }),
        )
        return
      }

      const runtime = resolveRuntime(targetPlatform)
      if (!runtime) {
        setError(
          fmt(t.player.noRuntime, {
            platform: platformLabel(t, targetPlatform, platformMap[targetPlatform]?.name ?? targetPlatform),
          }),
        )
        return
      }
      setFile(picked)
      begin(picked, targetPlatform, runtime)
    },
    [platform, romUrl, pageRuntime, onDetectMismatch, onPlatformChange, t],
  )

  const reset = () => {
    setSession(null)
    setStatus('idle')
    setFile(null)
    setError(null)
    setNotice(null)
    if (inputRef.current) inputRef.current.value = ''
  }

  const onDrop = (e: DragEvent) => {
    e.preventDefault()
    setDragging(false)
    const dropped = e.dataTransfer.files?.[0]
    if (dropped) void start(dropped)
  }

  const toggleFullscreen = () => {
    const el = hostRef.current
    if (!el) return
    if (document.fullscreenElement) void document.exitFullscreen()
    else void el.requestFullscreen?.()
  }

  const busy = status === 'loading' || status === 'running'
  const activeRuntime = session?.runtime ?? pageRuntime
  const activePlatform = session ? platformMap[session.platform] : platform

  return (
    <div className={cx('overflow-hidden rounded-2xl border border-line bg-black', className)}>
      {/* 画面区域 */}
      <div
        ref={hostRef}
        className={cx('relative aspect-video w-full bg-black', dragging && 'ring-2 ring-brand ring-inset')}
        onDragOver={(e) => {
          e.preventDefault()
          if (!busy) setDragging(true)
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={onDrop}
      >
        {/* 运行时挂载点：iframe 由运行时注入，React 不管理其子节点 */}
        <div ref={frameRef} className={cx('absolute inset-0', busy ? 'block' : 'hidden')} />

        {!busy && (
          <div className="absolute inset-0">
            <div className="absolute inset-0 opacity-60 blur-sm">{backdrop}</div>
            <div className="scanlines absolute inset-0" aria-hidden />
            <div className="absolute inset-0 bg-gradient-to-t from-black via-black/60 to-black/20" />

            <div className="absolute inset-0 flex flex-col items-center justify-center gap-4 px-6 text-center">
              {icon && (
                <span className="hidden text-6xl drop-shadow-[0_8px_16px_rgba(0,0,0,0.6)] sm:block sm:text-7xl" aria-hidden>
                  {icon}
                </span>
              )}
              {supported ? (
                <>
                  <Button size="lg" disabled={romChecking} onClick={() => (romUrl ? void start(null) : inputRef.current?.click())}>
                    <span aria-hidden>▶</span>{' '}
                    {romChecking ? t.player.checkingCloud : romUrl ? t.player.start : t.player.pickRom}
                  </Button>
                  <p className="max-w-md text-[11px] leading-relaxed text-white/70 sm:text-xs">
                    {romUrl ? (
                      <>
                        {fmt(t.player.cloudHint, { runtime: pageRuntime?.name ?? '' })}
                        <br />
                        {t.player.alsoCan}
                        <button type="button" className="mx-1 underline underline-offset-2 hover:text-white" onClick={() => inputRef.current?.click()}>
                          {t.player.pickLocal}
                        </button>
                        {t.player.orDrag}
                      </>
                    ) : romChecking ? (
                      <>{t.player.checkingHint}</>
                    ) : (
                      <>
                        {fmt(t.player.dropHint, { platform: platformLabel(t, platform.id, platform.name) })}
                        <br />
                        {fmt(t.player.formats, {
                          exts: platform.romExtensions.join(' '),
                          runtime: pageRuntime?.name ?? '',
                        })}
                      </>
                    )}
                  </p>
                </>
              ) : (
                <div className="max-w-md rounded-xl border border-line bg-black/60 p-4 text-sm text-white/80 backdrop-blur">
                  <p className="font-semibold text-white">{t.player.unsupportedTitle}</p>
                  <p className="mt-1 text-xs leading-relaxed">
                    {fmt(t.player.unsupportedBody, { platform: platformLabel(t, platform.id, platform.name) })}
                  </p>
                </div>
              )}
              {error && (
                <p role="alert" className="max-w-md rounded-lg bg-live/20 px-3 py-2 text-xs text-red-200">
                  {error}
                </p>
              )}
            </div>
          </div>
        )}

        {status === 'loading' && (
          <div className="pointer-events-none absolute left-3 top-3 flex items-center gap-2 rounded-lg bg-black/70 px-3 py-1.5 text-xs text-white backdrop-blur">
            <span className="h-2 w-2 animate-ping rounded-full bg-brand-hover" />
            {fmt(t.player.loading, { runtime: activeRuntime?.name ?? '' })}
          </div>
        )}

        <input
          ref={inputRef}
          type="file"
          accept={onDetectMismatch === 'switch' ? undefined : platform.romExtensions.join(',')}
          className="hidden"
          onChange={(e) => void start(e.target.files?.[0] ?? null)}
        />
      </div>

      {/* 工具栏 */}
      <div className="flex flex-wrap items-center gap-2 border-t border-line bg-surface px-3 py-2 text-xs">
        <span
          className={cx(
            'inline-flex items-center gap-1.5 rounded-md px-2 py-1 font-semibold',
            status === 'running'
              ? 'bg-online/15 text-online'
              : status === 'loading'
                ? 'bg-brand-soft text-brand-hover'
                : status === 'error'
                  ? 'bg-live/15 text-red-300'
                  : 'bg-white/5 text-muted',
          )}
        >
          <span className={cx('h-1.5 w-1.5 rounded-full', status === 'running' ? 'bg-online' : 'bg-current')} />
          {status === 'running'
            ? t.player.statusRunning
            : status === 'loading'
              ? t.player.statusLoading
              : status === 'error'
                ? t.player.statusError
                : t.player.statusIdle}
        </span>
        {file ? (
          <span className="truncate text-muted" title={file.name}>
            📄 {file.name} · {formatBytes(file.size)}
          </span>
        ) : (
          busy &&
          romUrl && (
            <span className="truncate text-muted" title={romUrl}>
              {fmt(t.player.cloudRom, { name: romUrl.split('/').pop() ?? '' })}
            </span>
          )
        )}
        <span className="text-muted" title={t.player.runtimeCore}>
          {activeRuntime
            ? `${activeRuntime.name} · ${activeRuntime.engineLabel(activePlatform?.id ?? platform.id)}`
            : t.player.noRuntimeShort}
        </span>
        {notice && (
          <span data-testid="detect-notice" className="truncate text-brand-hover">
            {notice}
          </span>
        )}

        <div className="ml-auto flex items-center gap-1.5">
          {(busy || status === 'error') && (
            <Button variant="ghost" size="sm" onClick={reset}>
              {t.player.changeRom}
            </Button>
          )}
          {supported && (
            <>
              <Button
                variant={immersive ? 'primary' : 'secondary'}
                size="sm"
                onClick={toggleImmersive}
                title={t.player.immersiveTitle}
                aria-pressed={immersive}
              >
                {immersive ? t.player.exitImmersive : t.player.enterImmersive}
              </Button>
              <Button variant="secondary" size="sm" onClick={toggleFullscreen} title={t.player.fullscreenTitle}>
                {t.player.fullscreen}
              </Button>
            </>
          )}
        </div>
      </div>
    </div>
  )
}
