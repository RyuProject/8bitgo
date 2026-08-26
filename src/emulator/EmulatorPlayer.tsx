import { useCallback, useEffect, useRef, useState, type DragEvent, type ReactNode } from 'react'
import type { Platform, PlatformId } from '@/types'
import { platformMap } from '@/data/platforms'
import { formatBytes, isRomFileAccepted } from '@/lib/emulator'
import { detectRom, describeDetection } from './detect'
import { resolveRuntime, extOf } from './registry'
import type { Runtime } from './types'
import { emulatorJsRuntime, p2pPlayable, type NetplaySession } from './adapters/emulatorjs'
import { cloudGameRuntime, cloudPlayable, type CloudSession, type CloudState } from './adapters/cloudgame'
import { cx } from '@/lib/format'
import { Button } from '@/components/ui/Button'
import { useShell } from '@/components/layout/ShellContext'
import { useT, fmt } from '@/services/i18n'
import { platformLabel } from '@/services/i18nData'
import { FEATURES } from '@/config/features'
import {
  downloadState,
  fetchNetplayRoom,
  gameIdFor,
  inviteLink,
  migrateRoom,
  playerName,
  refreshNetplayRooms,
  useNetplayRooms,
} from '@/services/netplay'
import { freePlayerIndex, keepAlive, roomLink, roomsEnabled, useRoom, MAX_PLAYERS } from '@/services/rooms'

type Status = 'idle' | 'loading' | 'running' | 'error'
type Mode = 'local' | 'online'
/** 联机走哪条路：p2p = 房主浏览器直推（默认）；cloud = 游戏跑在服务器上（付费） */
type Channel = 'p2p' | 'cloud'

interface ActiveSession {
  id: number
  game: File | string
  /** 实际运行的平台（本地文件被识别为其他平台时可能与页面平台不同） */
  platform: PlatformId
  runtime: Runtime
  /** P2P 联机会话（游戏在房主浏览器里跑） */
  netplay?: NetplaySession
  /** 云端联机会话（游戏在服务器上跑） */
  cloud?: CloudSession
}

interface Props {
  platform: Platform
  gameName: string
  /**
   * 游戏 slug。联机需要它：房间按 slug 分组，邀请链接也用它。
   * 不传（玩本地 ROM 页）就没有联机入口。
   */
  gameSlug?: string
  /** 该游戏支持的最大玩家数（决定房间容量）。> 1 时默认走联机 */
  maxPlayers?: number
  /** 邀请链接带进来的 P2P 房间 id（详情页 ?p2p=） */
  invite?: string
  /** 邀请链接带进来的云端房间 id（详情页 ?room=，付费通道） */
  cloudInvite?: string
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
 * 联机模式（online）默认走 **P2P**：游戏在房主自己的浏览器里跑，画面经 WebRTC 直推给
 * 加入的人，不经过服务器。房间自动出现在侧边栏「联机玩」，朋友打开邀请链接即可加入。
 * cloud-game（游戏跑在服务器上）是另一条通道，成本高，由 FEATURES.cloudGame 控制，留给付费会员。
 */
export function EmulatorPlayer({
  platform,
  gameName,
  gameSlug,
  maxPlayers = 2,
  invite,
  cloudInvite,
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

  const t = useT()
  const { immersive, toggleImmersive } = useShell()

  /* ---------------- 联机 ---------------- */
  // 联机需要云端 ROM：房主和访客都得能拿到同一个 ROM
  const p2pOk = Boolean(gameSlug) && Boolean(romUrl) && p2pPlayable(platform.id)
  const cloudOk = FEATURES.cloudGame && Boolean(gameSlug) && cloudPlayable(platform.id)
  const onlineOk = p2pOk || cloudOk
  /** 优先 P2P；P2P 不可用而云端可用时才走云端 */
  const channel: Channel = p2pOk ? 'p2p' : 'cloud'

  const [ignoreInvite, setIgnoreInvite] = useState(false)
  const inviteId = ignoreInvite ? undefined : invite
  const cloudInviteId = ignoreInvite ? undefined : cloudInvite
  const joining = Boolean(inviteId) || Boolean(cloudInviteId)

  /**
   * 默认是否走联机：多人游戏，或者点邀请链接进来的人。
   * 单人游戏默认在本地跑（可手动切联机，相当于开个直播给人看）。
   */
  const onlineByDefault = onlineOk && (maxPlayers > 1 || joining)
  const [mode, setMode] = useState<Mode>(onlineByDefault ? 'online' : 'local')
  const online = mode === 'online' && onlineOk

  const [roomId, setRoomId] = useState<string | null>(null)
  const [players, setPlayers] = useState(1)
  /** netplay 给我们分配的身份 id，服务器用它判断「谁该接手」 */
  const myIdRef = useRef<string>('')
  /** 正在接手的旧房间 id：新房间开好后要调 /migrate 把两者接上 */
  const migrateFromRef = useRef<string>('')
  const [copied, setCopied] = useState(false)
  const slots = Math.max(1, Math.min(MAX_PLAYERS, maxPlayers))

  // P2P：从房间列表里找要加入的那个房间（判断满没满、还在不在）
  const p2pRooms = useNetplayRooms()
  const inviteRoom = inviteId ? p2pRooms.find((r) => r.roomId === inviteId) : undefined
  const inviteGone = Boolean(inviteId) && status === 'idle' && p2pRooms.length > 0 && !inviteRoom
  const inviteFull = Boolean(inviteRoom && inviteRoom.players >= inviteRoom.max)

  // 云端：连接状态与手柄位
  const [cloudState, setCloudState] = useState<CloudState | null>(null)
  const [slotIndex, setSlotIndex] = useState(0)
  const cloudJoinRoom = useRoom(cloudOk && status === 'idle' ? cloudInviteId : undefined)
  const cloudJoinPending = Boolean(cloudInviteId) && roomsEnabled() && cloudJoinRoom === undefined
  const myCloudRoom = useRoom(session?.cloud ? (roomId ?? undefined) : undefined)

  const hostRef = useRef<HTMLDivElement>(null)
  const frameRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const sessionCounter = useRef(0)
  // gameName 只用于存档 / 截图命名，放进 effect 依赖会导致「切换语言就把正在跑的游戏重启」
  const gameNameRef = useRef(gameName)
  gameNameRef.current = gameName
  /** 云端联机是否真的跑起来过（用于区分「没连上」和「玩到一半断了」） */
  const cloudPlayedRef = useRef(false)

  // 云端 ROM 也按其文件扩展名选引擎；还没拿到地址时退回平台默认
  const pageRuntime = resolveRuntime({ platform: platform.id, ext: extOf(romUrl) })
  const supported = Boolean(pageRuntime) || onlineOk
  // 云端联机连不上时的本地兜底（用 ref，避免挂载 effect 捕获到旧值）
  const localFallbackRef = useRef<{ url?: string; runtime?: Runtime }>({})
  localFallbackRef.current = { url: romUrl, runtime: pageRuntime }

  const begin = (
    game: File | string,
    targetPlatform: PlatformId,
    runtime: Runtime,
    extra?: { netplay?: NetplaySession; cloud?: CloudSession },
  ) => {
    sessionCounter.current += 1
    setSession({ id: sessionCounter.current, game, platform: targetPlatform, runtime, ...extra })
    setStatus('loading')
  }

  // 会话变化时挂载 / 卸载运行时
  useEffect(() => {
    const host = frameRef.current
    if (!session || !host) return
    const destroy = session.runtime.mount(host, {
      platform: session.platform,
      game: session.game,
      gameName: gameNameRef.current,
      netplay: session.netplay,
      cloud: session.cloud,
      onReady: () => setStatus('running'),
      onError: (message: string) => {
        const cloud = session.cloud
        // 出错后必须把会话拆掉：否则运行时会在隐藏的挂载点里继续活着
        setSession(null)

        // 云端自己开房没开成（服务器满了 / 连不上），而这游戏本来就能在浏览器里跑：
        // 直接退回本地运行，别让人因为服务器容量问题玩不了。
        const fb = localFallbackRef.current
        if (cloud && !cloud.roomId && !cloudPlayedRef.current && fb.url && fb.runtime) {
          setMode('local')
          setError(null)
          setNotice(fmt(t.player.cloudFellBack, { msg: message }))
          begin(fb.url, platform.id, fb.runtime)
          return
        }

        setError(message)
        setStatus('error')
      },
    })
    return destroy
  }, [session])

  // 云端联机期间向本站后端心跳（P2P 不需要：信令服务器本来就知道房间）
  useEffect(() => {
    if (!session?.cloud || !roomId || !gameSlug) return
    return keepAlive({
      roomId,
      gameSlug,
      playerIndex: session.cloud.playerIndex,
      host: !session.cloud.roomId,
    })
  }, [session, roomId, gameSlug])

  /**
   * 在 P2P 房间里时盯着房间状态：
   *   - 房主掉线且服务器选中了我 → 取存档、接手，游戏接着跑
   *   - 房间已经换了房主 → 跟到新房间
   *   - 房间没了 → 提示这局结束
   * 服务器保留 60 秒宽限期，2.5 秒一轮足够。
   */
  useEffect(() => {
    if (!session?.netplay || !roomId || status === 'error') return
    let stopped = false
    const tick = async () => {
      const room = await fetchNetplayRoom(roomId)
      if (stopped) return
      if (!room) {
        // 房间彻底消失（宽限期内没人接手）
        setSession(null)
        setStatus('error')
        setError(t.player.hostLeft)
        return
      }
      if (room.migratedTo && room.migratedTo !== roomId) {
        setNotice(t.player.hostChanged)
        startP2p(room.migratedTo)
        return
      }
      if (room.awaitingHost && room.nextHostUserId && room.nextHostUserId === myIdRef.current) {
        stopped = true
        setNotice(t.player.takingOver)
        const state = room.hasState ? await downloadState(roomId) : null
        startP2p(undefined, { from: roomId, state })
      }
    }
    const timer = window.setInterval(() => void tick(), 2500)
    return () => {
      stopped = true
      window.clearInterval(timer)
    }
  }, [session, roomId, status])

  useEffect(() => {
    if (!copied) return
    const timer = window.setTimeout(() => setCopied(false), 2000)
    return () => window.clearTimeout(timer)
  }, [copied])

  /**
   * P2P：开房间（join 为空）、加入房间，或接手别人掉线后的房间（带 initialState）。
   */
  const startP2p = (join?: string, takeOver?: { from: string; state: Uint8Array | null }) => {
    if (!gameSlug || !romUrl) return
    setError(null)
    if (!takeOver) setNotice(null)
    setRoomId(join ?? null)
    setPlayers(1)
    migrateFromRef.current = takeOver?.from ?? ''
    begin(romUrl, platform.id, emulatorJsRuntime, {
      netplay: {
        gameId: gameIdFor(gameSlug),
        roomName: gameName,
        playerName: playerName(),
        maxPlayers: slots,
        mode: join ? 'join' : 'host',
        roomId: join,
        initialState: takeOver?.state ?? undefined,
        onIdentity: (id) => (myIdRef.current = id),
        onRoom: (id, isHost) => {
          setRoomId(id)
          // 接手成功：把新房间和旧房间接上，老邀请链接才能继续用
          const from = migrateFromRef.current
          if (isHost && from && from !== id) {
            migrateFromRef.current = ''
            void migrateRoom(from, id, myIdRef.current).then((okDone) => {
              if (okDone) setNotice(t.player.tookOver)
            })
          }
          refreshNetplayRooms()
        },
        onPlayers: (n) => setPlayers(n),
        onHostLeft: () => {
          setSession(null)
          setStatus('error')
          setError(t.player.hostLeft)
        },
      },
    })
  }

  /** 云端：创建房间（join 为空）或加入房间 */
  const startCloud = (join?: string) => {
    if (!gameSlug) return
    setError(null)
    setNotice(null)
    setRoomId(join ?? null)
    setCloudState('connecting')
    const playerIndex = join ? (cloudJoinRoom ? freePlayerIndex(cloudJoinRoom, slots) : Math.min(1, slots - 1)) : 0
    setSlotIndex(playerIndex)
    cloudPlayedRef.current = false
    begin(romUrl ?? '', platform.id, cloudGameRuntime, {
      cloud: {
        gameId: gameSlug,
        roomId: join,
        playerIndex,
        onRoom: (id) => setRoomId(id),
        onPlayerIndex: (i) => setSlotIndex(i),
        onState: (s) => {
          if (s === 'playing') cloudPlayedRef.current = true
          setCloudState(s)
        },
      },
    })
  }

  const startOnline = () => {
    if (cloudInviteId && cloudOk) return startCloud(cloudInviteId)
    if (inviteId && p2pOk) return startP2p(inviteId)
    if (channel === 'p2p') return startP2p()
    return startCloud()
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
    // 主动离开房间后，URL 里的 ?p2p= / ?room= 就不该再把人拉回同一个房间
    if (session?.netplay || session?.cloud || joining) setIgnoreInvite(true)
    setSession(null)
    setStatus('idle')
    setFile(null)
    setError(null)
    setNotice(null)
    setRoomId(null)
    setPlayers(1)
    setCloudState(null)
    if (inputRef.current) inputRef.current.value = ''
  }

  const copyInvite = async () => {
    if (!gameSlug || !roomId) return
    const link = session?.cloud ? roomLink(gameSlug, roomId) : inviteLink(gameSlug, roomId)
    try {
      await navigator.clipboard.writeText(link)
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
  const inRoom = Boolean(session?.netplay || session?.cloud)
  const activeRuntime =
    session?.runtime ?? (online ? (channel === 'p2p' ? emulatorJsRuntime : cloudGameRuntime) : pageRuntime)
  const activePlatform = session ? platformMap[session.platform] : platform
  const cloudStateLabel = cloudState ? t.player.cloudState[cloudState] : ''
  const roomPlayers = session?.cloud ? (myCloudRoom?.players ?? 1) : players
  const joinBlocked = online && (inviteFull || inviteGone || cloudJoinPending)

  /** 空闲态主按钮 */
  const primaryAction = () => {
    if (online) return startOnline()
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
                  <Button size="lg" disabled={(!online && romChecking) || joinBlocked} onClick={primaryAction}>
                    <span aria-hidden>{online ? '👥' : '▶'}</span>{' '}
                    {joining && online
                      ? inviteFull
                        ? t.player.roomFull
                        : inviteGone
                          ? t.player.roomGoneShort
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
                    {joining && online ? (
                      <>
                        {inviteGone
                          ? t.player.roomGone
                          : inviteRoom
                            ? fmt(t.player.joinHint, {
                                host: inviteRoom.host?.nickname ?? '—',
                                players: String(inviteRoom.players),
                                max: String(inviteRoom.max),
                                slot: String(Math.min(inviteRoom.players + 1, inviteRoom.max)),
                              })
                            : t.player.roomLookup}
                        <br />
                        <button
                          type="button"
                          className="mx-1 underline underline-offset-2 hover:text-white"
                          onClick={() => setIgnoreInvite(true)}
                        >
                          {t.player.createOwnRoom}
                        </button>
                      </>
                    ) : online ? (
                      <>
                        {fmt(channel === 'p2p' ? t.player.p2pHint : t.player.onlineHint, { max: String(slots) })}
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
            {session?.cloud && cloudStateLabel ? cloudStateLabel : fmt(t.player.loading, { runtime: activeRuntime?.name ?? '' })}
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

        {inRoom ? (
          <>
            <span className="inline-flex items-center gap-1 rounded-md bg-brand-soft px-2 py-1 font-semibold text-brand-hover" title={roomId ?? ''}>
              👥 {fmt(t.player.roomBadge, { players: String(roomPlayers), max: String(slots) })}
              {session?.cloud && <span className="font-normal text-muted">· {fmt(t.player.slotLabel, { n: String(slotIndex + 1) })}</span>}
              {session?.netplay && <span className="font-normal text-muted">· {t.player.p2pTag}</span>}
            </span>
            {roomId && (
              <button type="button" onClick={() => void copyInvite()} className="rounded-md border border-line px-2 py-1 text-muted hover:text-fg">
                {copied ? t.player.copied : t.player.copyInvite}
              </button>
            )}
            {session?.cloud && status === 'running' && cloudState && cloudState !== 'playing' && (
              <span className="text-red-300">{cloudStateLabel}</span>
            )}
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
