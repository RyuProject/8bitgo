import { useCallback, useEffect, useRef, useState, type DragEvent, type ReactNode } from 'react'
import type { Platform, PlatformId } from '@/types'
import { platformMap, platforms } from '@/data/platforms'
import { formatBytes, isRomFileAccepted } from '@/lib/emulator'
import { detectRom, describeDetection } from './detect'
import { resolveRuntime, extOf, isPlayable } from './registry'
import type { Runtime } from './types'
import { cloudGameRuntime, cloudPlayable, type CloudSession, type CloudState } from './adapters/cloudgame'
import { cx } from '@/lib/format'
import { Button } from '@/components/ui/Button'
import { useShell } from '@/components/layout/ShellContext'
import { useT, fmt } from '@/services/i18n'
import { platformLabel } from '@/services/i18nData'
import { freePlayerIndex, keepAlive, roomLink, roomsEnabled, useRoom, MAX_PLAYERS } from '@/services/rooms'

type Status = 'idle' | 'loading' | 'running' | 'error'
type Mode = 'local' | 'online'

interface ActiveSession {
  id: number
  game: File | string
  /** 实际运行的平台（本地文件被识别为其他平台时可能与页面平台不同） */
  platform: PlatformId
  runtime: Runtime
  /** 联机会话（联机模式才有） */
  cloud?: CloudSession
}

interface Props {
  platform: Platform
  gameName: string
  /**
   * 游戏 slug。联机模式需要它：服务器游戏库里的文件名 = slug，邀请链接也用它。
   * 不传（玩本地 ROM 页）就没有联机入口。
   */
  gameSlug?: string
  /** 该游戏支持的最大玩家数（决定手柄位数量） */
  maxPlayers?: number
  /** 通过邀请链接进来：要加入的房间 id（详情页 ?room=） */
  joinRoomId?: string
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
 *
 * 联机模式（online）：游戏跑在 cloud-game 服务器上，开始即自动创建房间，
 * 房间会出现在侧边栏「联机玩」里；朋友通过邀请链接（?room=）加入并选手柄位。
 * 详情页在联机可用时默认联机，可随时切回本地运行。
 */
export function EmulatorPlayer({
  platform,
  gameName,
  gameSlug,
  maxPlayers = 2,
  joinRoomId,
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

  // 联机
  const onlineOk = Boolean(gameSlug) && cloudPlayable(platform.id)
  const [mode, setMode] = useState<Mode>(onlineOk ? 'online' : 'local')
  const [roomId, setRoomId] = useState<string | null>(null)
  const [cloudState, setCloudState] = useState<CloudState | null>(null)
  const [copied, setCopied] = useState(false)
  /** 实际使用的手柄位（服务器可能改判，以它的回复为准） */
  const [slotIndex, setSlotIndex] = useState(0)
  /** 离开房间后不要再按邀请链接里的 ?room= 重新加入 */
  const [ignoreInvite, setIgnoreInvite] = useState(false)
  const slots = Math.max(1, Math.min(MAX_PLAYERS, maxPlayers))
  const inviteRoomId = ignoreInvite ? undefined : joinRoomId
  // 加入别人的房间：先看看房间信息（host、已占用的手柄位）
  const joinRoom = useRoom(onlineOk && status === 'idle' ? inviteRoomId : undefined)
  const joinFull = Boolean(inviteRoomId && joinRoom && joinRoom.players >= slots)
  // 房间信息还没查回来就不能加入：否则会拿到 0（房主的位）跟房主撞车
  const joinPending = Boolean(inviteRoomId) && roomsEnabled() && joinRoom === undefined
  // 自己所在的房间（用于工具栏显示人数）
  const myRoom = useRoom(session?.cloud ? (roomId ?? undefined) : undefined)

  const hostRef = useRef<HTMLDivElement>(null)
  const frameRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const sessionCounter = useRef(0)
  // gameName 只用于存档 / 截图命名，放进 effect 依赖会导致「切换语言就把正在跑的游戏重启」
  const gameNameRef = useRef(gameName)
  gameNameRef.current = gameName

  // 云端 ROM 也按其文件扩展名选引擎；还没拿到地址时退回平台默认
  const pageRuntime = resolveRuntime({ platform: platform.id, ext: extOf(romUrl) })
  // 「自动识别平台」模式（玩本地 ROM 页）：提示语不该写死某一个平台
  const autoPlatform = onDetectMismatch === 'switch'
  const autoPlatformList = platforms
    .filter((p) => isPlayable(p.id))
    .map((p) => p.shortName)
    .join(' / ')
  const supported = Boolean(pageRuntime) || onlineOk
  const { immersive, toggleImmersive } = useShell()
  const t = useT()

  // 会话变化时挂载 / 卸载运行时
  useEffect(() => {
    const host = frameRef.current
    if (!session || !host) return
    const destroy = session.runtime.mount(host, {
      platform: session.platform,
      game: session.game,
      gameName: gameNameRef.current,
      cloud: session.cloud,
      onReady: () => setStatus('running'),
      onError: (message: string) => {
        setError(message)
        setStatus('error')
        // 出错后必须把会话拆掉：否则运行时会在隐藏的挂载点里继续活着
        // （联机模式下就是 WebSocket / WebRTC / 房间心跳全都还在后台跑）
        setSession(null)
      },
    })
    return destroy
  }, [session])

  // 联机期间向本站后端心跳，房间才会出现在「联机玩」列表里
  useEffect(() => {
    if (!session?.cloud || !roomId || !gameSlug) return
    return keepAlive({
      roomId,
      gameSlug,
      playerIndex: session.cloud.playerIndex,
      host: !session.cloud.roomId,
    })
  }, [session, roomId, gameSlug])

  useEffect(() => {
    if (!copied) return
    const timer = window.setTimeout(() => setCopied(false), 2000)
    return () => window.clearTimeout(timer)
  }, [copied])

  const begin = (game: File | string, targetPlatform: PlatformId, runtime: Runtime, cloud?: CloudSession) => {
    sessionCounter.current += 1
    setSession({ id: sessionCounter.current, game, platform: targetPlatform, runtime, cloud })
    setStatus('loading')
  }

  /** 联机：创建房间（join 为空）或加入房间 */
  const startOnline = (join?: string) => {
    if (!gameSlug) return
    setError(null)
    setNotice(null)
    setRoomId(join ?? null)
    setCloudState('connecting')
    // 加入别人的房间时挑一个空位；房间信息拿不到（没配后端）就退让到 2P，别去抢房主的 1P
    const playerIndex = join ? (joinRoom ? freePlayerIndex(joinRoom, slots) : Math.min(1, slots - 1)) : 0
    setSlotIndex(playerIndex)
    begin(romUrl ?? '', platform.id, cloudGameRuntime, {
      gameId: gameSlug,
      roomId: join,
      playerIndex,
      onRoom: (id) => setRoomId(id),
      onPlayerIndex: (i) => setSlotIndex(i),
      onState: (s) => setCloudState(s),
    })
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

      // 按「平台 + 文件扩展名」选引擎：.nes 会走 jsnes，.swf 走 Ruffle，其余交给 EmulatorJS
      const runtime = resolveRuntime({ platform: targetPlatform, ext: extOf(picked) })
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
    // 主动离开房间后，URL 里的 ?room= 就不该再把人拉回同一个房间
    if (session?.cloud || joinRoomId) setIgnoreInvite(true)
    setSession(null)
    setStatus('idle')
    setFile(null)
    setError(null)
    setNotice(null)
    setRoomId(null)
    setCloudState(null)
    if (inputRef.current) inputRef.current.value = ''
  }

  const copyInvite = async () => {
    if (!gameSlug || !roomId) return
    try {
      await navigator.clipboard.writeText(roomLink(gameSlug, roomId))
      setCopied(true)
    } catch {
      /* 剪贴板不可用时忽略 */
    }
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
  const online = mode === 'online' && onlineOk
  const joining = online && Boolean(inviteRoomId)
  const activeRuntime = session?.runtime ?? (online ? cloudGameRuntime : pageRuntime)
  const activePlatform = session ? platformMap[session.platform] : platform
  const cloudStateLabel = cloudState ? t.player.cloudState[cloudState] : ''

  /** 空闲态主按钮 */
  const primaryAction = () => {
    if (online) {
      startOnline(inviteRoomId || undefined)
      return
    }
    if (romUrl) void start(null)
    else inputRef.current?.click()
  }

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
                  <Button size="lg" disabled={(!online && romChecking) || joinFull || joinPending} onClick={primaryAction}>
                    <span aria-hidden>{online ? '👥' : '▶'}</span>{' '}
                    {joining
                      ? joinFull
                        ? t.player.roomFull
                        : joinPending
                          ? t.player.roomLookup
                          : t.player.joinRoom
                      : online
                        ? t.player.onlineStart
                        : romChecking
                          ? t.player.checkingCloud
                          : romUrl
                            ? t.player.start
                            : t.player.pickRom}
                  </Button>
                  <p className="max-w-md text-[11px] leading-relaxed text-white/70 sm:text-xs">
                    {joining ? (
                      <>
                        {joinRoom
                          ? fmt(t.player.joinHint, {
                              host: joinRoom.host?.nickname ?? '—',
                              players: String(joinRoom.players),
                              max: String(slots),
                              slot: String(freePlayerIndex(joinRoom, slots) + 1),
                            })
                          : !roomsEnabled()
                            ? t.player.joinHintNoList
                            : joinRoom === undefined
                              ? t.player.roomLookup
                              : t.player.roomGone}
                        <br />
                        <button type="button" className="mx-1 underline underline-offset-2 hover:text-white" onClick={() => startOnline()}>
                          {t.player.createOwnRoom}
                        </button>
                      </>
                    ) : online ? (
                      <>
                        {fmt(t.player.onlineHint, { max: String(slots) })}
                        <br />
                        {t.player.alsoCan}
                        <button type="button" className="mx-1 underline underline-offset-2 hover:text-white" onClick={() => setMode('local')}>
                          {t.player.localInstead}
                        </button>
                        {pageRuntime ? fmt(t.player.localInsteadHint, { runtime: pageRuntime.name }) : ''}
                      </>
                    ) : romUrl ? (
                      <>
                        {fmt(t.player.cloudHint, { runtime: pageRuntime?.name ?? '' })}
                        <br />
                        {t.player.alsoCan}
                        <button type="button" className="mx-1 underline underline-offset-2 hover:text-white" onClick={() => inputRef.current?.click()}>
                          {t.player.pickLocal}
                        </button>
                        {t.player.orDrag}
                        {onlineOk && (
                          <>
                            {' '}
                            <button type="button" className="mx-1 underline underline-offset-2 hover:text-white" onClick={() => setMode('online')}>
                              {t.player.onlineInstead}
                            </button>
                          </>
                        )}
                      </>
                    ) : romChecking ? (
                      <>{t.player.checkingHint}</>
                    ) : (
                      <>
                        {autoPlatform
                          ? t.player.dropHintAuto
                          : fmt(t.player.dropHint, { platform: platformLabel(t, platform.id, platform.name) })}
                        <br />
                        {autoPlatform
                          ? fmt(t.player.formatsAuto, { platforms: autoPlatformList })
                          : fmt(t.player.formats, {
                              exts: platform.romExtensions.join(' '),
                              runtime: pageRuntime?.name ?? '',
                            })}
                        {onlineOk && (
                          <>
                            {' '}
                            <button type="button" className="mx-1 underline underline-offset-2 hover:text-white" onClick={() => setMode('online')}>
                              {t.player.onlineInstead}
                            </button>
                          </>
                        )}
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
            {session?.cloud ? cloudStateLabel || fmt(t.player.loading, { runtime: activeRuntime?.name ?? '' }) : fmt(t.player.loading, { runtime: activeRuntime?.name ?? '' })}
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

        {session?.cloud ? (
          <>
            <span className="inline-flex items-center gap-1 rounded-md bg-brand-soft px-2 py-1 font-semibold text-brand-hover" title={roomId ?? ''}>
              👥 {fmt(t.player.roomBadge, { players: String(myRoom?.players ?? 1), max: String(slots) })}
              <span className="font-normal text-muted">· {fmt(t.player.slotLabel, { n: String(slotIndex + 1) })}</span>
            </span>
            {roomId && (
              <button type="button" onClick={() => void copyInvite()} className="rounded-md border border-line px-2 py-1 text-muted hover:text-fg">
                {copied ? t.player.copied : t.player.copyInvite}
              </button>
            )}
            {status === 'running' && cloudState && cloudState !== 'playing' && <span className="text-red-300">{cloudStateLabel}</span>}
          </>
        ) : file ? (
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
              {online ? t.player.leaveRoom : t.player.changeRom}
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
