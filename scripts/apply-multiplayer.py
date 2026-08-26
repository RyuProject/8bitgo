#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
把「远程联机（cloud-game）」功能重新打到项目上。

为什么需要这个脚本：项目会被 _to_delete/8bitgo-update.zip 覆盖，而那个包里没有联机功能，
每解压一次，被修改过的共享文件（types.ts / registry.ts / EmulatorPlayer.tsx / 侧边栏 / 路由 /
locales 等）就会回到原样。跑一次这个脚本即可全部补回。

    python3 scripts/apply-multiplayer.py            # 在项目根目录执行
    python3 scripts/apply-multiplayer.py <项目路径>

完全幂等：已经打过的部分会跳过，重复执行安全。
等不再用 zip 覆盖项目的方式了，这个脚本就可以删掉。
"""
import sys, os, re

ROOT = os.path.abspath(sys.argv[1] if len(sys.argv) > 1 else '.')

FILES = {
 "src/emulator/types.ts": "/**\n * 运行时（模拟器引擎）抽象。\n *\n * 一个「运行时」负责把某类 ROM 跑起来。播放器只面向这个接口，不关心背后是谁：\n *   EmulatorJS  主机 / 掌机 / 街机 / DOS（RetroArch 核心）\n *   Ruffle      Flash (.swf)\n *   jsnes       NES (.nes)\n *   J2ME        Java 手机游戏 (.jar) —— 需自托管，见 adapters/j2me.ts\n *   Cloud       远程联机：游戏跑在 cloud-game 服务器上，见 adapters/cloudgame.ts\n *\n * 新增一个引擎只要三步：\n *   1. 在 adapters/ 下实现 Runtime 接口\n *   2. 在 registry.ts 的 runtimes 里注册\n *   3.（可选）在 src/config/emulators.ts 里把某个扩展名指过去\n */\nimport type { PlatformId } from '@/types'\nimport type { CloudSession } from './adapters/cloudgame'\n\nexport type RuntimeId = 'emulatorjs' | 'ruffle' | 'jsnes' | 'j2me' | 'cloudgame'\n\nexport interface MountOptions {\n  /** 平台 id（运行时据此选择核心等参数） */\n  platform: PlatformId\n  /** ROM：本地文件或可跨域访问的 URL */\n  game: File | string\n  /** 显示名（存档 / 截图命名用） */\n  gameName: string\n  /** 联机会话（仅 cloudgame 运行时使用；游戏由服务器运行，此时 game 字段被忽略） */\n  cloud?: CloudSession\n  onReady?: () => void\n  onStart?: () => void\n  onError?: (message: string) => void\n}\n\n/** 解析运行时时能用到的线索 */\nexport interface ResolveContext {\n  platform: PlatformId\n  /** 文件扩展名，不带点、小写。来自本地文件名或云端 ROM 的 key */\n  ext?: string\n}\n\nexport interface Runtime {\n  id: RuntimeId\n  /** 展示名 */\n  name: string\n  /** 一句话说明 */\n  description: string\n\n  /** 该运行时能跑的扩展名（不带点、小写）。用于「按格式选引擎」 */\n  extensions: string[]\n  /**\n   * 多个引擎都能处理同一格式时，数字大的先被选中。\n   * 例：.nes 既能给 EmulatorJS 也能给 jsnes，靠这个和 config/emulators.ts 的覆盖表决定。\n   */\n  priority: number\n\n  /**\n   * 引擎当前是否可用。\n   * 需要自托管资源的引擎（如 J2ME）在没配置路径时返回 false，\n   * 这样解析阶段就会跳过它，而不是等到挂载时才报错。\n   */\n  available: () => boolean\n\n  /** 该运行时是否能跑这个平台 */\n  supports: (platform: PlatformId) => boolean\n  /** 该平台下用于显示的「核心 / 引擎」名 */\n  engineLabel: (platform: PlatformId) => string\n  /** 在容器内挂载并开始运行，返回销毁函数 */\n  mount: (container: HTMLElement, options: MountOptions) => () => void\n}\n",
 "src/emulator/registry.ts": "/**\n * 运行时注册表：决定「这个 ROM 该用哪个引擎跑」。\n *\n * 解析优先级（resolveRuntime）：\n *   1. 扩展名命中 src/config/emulators.ts 的覆盖表，且该引擎可用 → 用它\n *   2. 否则在「声明支持该扩展名」的可用引擎里挑 priority 最高的\n *   3. 否则退回平台自己配置的引擎（src/data/platforms.ts 的 runtime 字段）\n *\n * 只传平台、不传扩展名时（比如详情页还没选文件），走第 3 步。\n *\n * 注意：cloudgame（远程联机）不参与上面的解析 —— 它不由文件格式决定，\n * 而是用户在播放器里显式切到「联机模式」时才使用（见 EmulatorPlayer）。\n */\nimport type { PlatformId } from '@/types'\nimport { platformMap } from '@/data/platforms'\nimport { EXT_RUNTIME_OVERRIDES } from '@/config/emulators'\nimport type { ResolveContext, Runtime, RuntimeId } from './types'\nimport { emulatorJsRuntime } from './adapters/emulatorjs'\nimport { ruffleRuntime } from './adapters/ruffle'\nimport { jsnesRuntime } from './adapters/jsnes'\nimport { j2meRuntime } from './adapters/j2me'\nimport { cloudGameRuntime } from './adapters/cloudgame'\n\nexport const runtimes: Record<RuntimeId, Runtime> = {\n  emulatorjs: emulatorJsRuntime,\n  ruffle: ruffleRuntime,\n  jsnes: jsnesRuntime,\n  j2me: j2meRuntime,\n  cloudgame: cloudGameRuntime,\n}\n\n/** 参与「本地运行」解析的引擎（排除联机） */\nconst localRuntimes = (): Runtime[] => Object.values(runtimes).filter((r) => r.id !== 'cloudgame')\n\nexport function getRuntime(id: RuntimeId | null | undefined): Runtime | undefined {\n  return id ? runtimes[id] : undefined\n}\n\n/** 平台自己配置的引擎（老逻辑，作为兜底） */\nfunction platformDefault(platform: PlatformId): Runtime | undefined {\n  const rt = getRuntime(platformMap[platform]?.runtime)\n  return rt && rt.available() && rt.supports(platform) ? rt : undefined\n}\n\n/** 从文件名 / 对象存储 key 里取扩展名（不带点、小写） */\nexport function extOf(nameOrUrl: string | File | undefined | null): string | undefined {\n  if (!nameOrUrl) return undefined\n  const name = typeof nameOrUrl === 'string' ? nameOrUrl.split(/[?#]/)[0] : nameOrUrl.name\n  const m = /\\.([A-Za-z0-9]+)$/.exec(name)\n  return m ? m[1].toLowerCase() : undefined\n}\n\n/**\n * 解析该用哪个运行时。\n * 传了 ext 就按格式选，没传就按平台选。\n */\nexport function resolveRuntime(target: PlatformId | ResolveContext): Runtime | undefined {\n  const ctx: ResolveContext = typeof target === 'string' ? { platform: target } : target\n  const { platform, ext } = ctx\n\n  if (ext) {\n    // 1. 覆盖表优先\n    const forced = getRuntime(EXT_RUNTIME_OVERRIDES[ext])\n    if (forced?.available() && forced.supports(platform)) return forced\n\n    // 2. 声明支持该扩展名的引擎里挑 priority 最高的\n    const candidates = localRuntimes()\n      .filter((r) => r.available() && r.extensions.includes(ext) && r.supports(platform))\n      .sort((a, b) => b.priority - a.priority)\n    if (candidates[0]) return candidates[0]\n  }\n\n  // 3. 平台默认\n  return platformDefault(platform)\n}\n\n/** 平台是否可在线运行（任意一个可用的本地引擎支持它即可） */\nexport function isPlayable(platform: PlatformId): boolean {\n  if (platformDefault(platform)) return true\n  return localRuntimes().some((r) => r.available() && r.supports(platform))\n}\n\n/** 某平台所有可用引擎，用于界面上展示 / 让用户手动切换 */\nexport function runtimesFor(platform: PlatformId): Runtime[] {\n  return localRuntimes()\n    .filter((r) => r.available() && r.supports(platform))\n    .sort((a, b) => b.priority - a.priority)\n}\n",
 "src/emulator/index.ts": "/**\n * 模拟器模块的唯一对外入口。\n *\n * 外部只从 '@/emulator' 引入，不要直接摸 adapters/ —— 这样以后换引擎、\n * 调整内部结构都不会波及页面代码。\n *\n *   import { EmulatorPlayer, resolveRuntime, detectRom } from '@/emulator'\n */\nexport { EmulatorPlayer } from './EmulatorPlayer'\nexport {\n  runtimes,\n  getRuntime,\n  resolveRuntime,\n  isPlayable,\n  runtimesFor,\n  extOf,\n} from './registry'\nexport type { Runtime, RuntimeId, MountOptions, ResolveContext } from './types'\nexport { EJS_PATH } from './adapters/emulatorjs'\nexport { RUFFLE_PATH } from './adapters/ruffle'\nexport { J2ME_PATH } from './adapters/j2me'\nexport { CLOUDGAME_URL, CLOUD_PLATFORM_CORES, cloudPlayable, cloudGameRuntime } from './adapters/cloudgame'\nexport type { CloudSession, CloudState } from './adapters/cloudgame'\n",
 "src/emulator/EmulatorPlayer.tsx": "import { useCallback, useEffect, useRef, useState, type DragEvent, type ReactNode } from 'react'\nimport type { Platform, PlatformId } from '@/types'\nimport { platformMap } from '@/data/platforms'\nimport { formatBytes, isRomFileAccepted } from '@/lib/emulator'\nimport { detectRom, describeDetection } from './detect'\nimport { resolveRuntime, extOf } from './registry'\nimport type { Runtime } from './types'\nimport { cloudGameRuntime, cloudPlayable, type CloudSession, type CloudState } from './adapters/cloudgame'\nimport { cx } from '@/lib/format'\nimport { Button } from '@/components/ui/Button'\nimport { useShell } from '@/components/layout/ShellContext'\nimport { useT, fmt } from '@/services/i18n'\nimport { platformLabel } from '@/services/i18nData'\nimport { freePlayerIndex, keepAlive, roomLink, roomsEnabled, useRoom, MAX_PLAYERS } from '@/services/rooms'\n\ntype Status = 'idle' | 'loading' | 'running' | 'error'\ntype Mode = 'local' | 'online'\n\ninterface ActiveSession {\n  id: number\n  game: File | string\n  /** 实际运行的平台（本地文件被识别为其他平台时可能与页面平台不同） */\n  platform: PlatformId\n  runtime: Runtime\n  /** 联机会话（联机模式才有） */\n  cloud?: CloudSession\n}\n\ninterface Props {\n  platform: Platform\n  gameName: string\n  /**\n   * 游戏 slug。联机模式需要它：服务器游戏库里的文件名 = slug，邀请链接也用它。\n   * 不传（玩本地 ROM 页）就没有联机入口。\n   */\n  gameSlug?: string\n  /** 该游戏支持的最大玩家数（决定手柄位数量） */\n  maxPlayers?: number\n  /** 通过邀请链接进来：要加入的房间 id（详情页 ?room=） */\n  joinRoomId?: string\n  /** 空闲态背景（例如封面） */\n  backdrop?: ReactNode\n  /** 空闲态显示的图标 */\n  icon?: string\n  className?: string\n  /** 若有可直接访问的 ROM URL（对象存储 / 自制开源游戏），可跳过上传 */\n  romUrl?: string\n  /** 正在探测云端 ROM 是否存在 */\n  romChecking?: boolean\n  /**\n   * 本地文件识别出的平台与页面平台不一致时如何处理：\n   *   'switch' —— 用识别出的平台运行（玩本地 ROM 页）\n   *   'warn'   —— 提示但仍按页面平台运行（游戏详情页）\n   */\n  onDetectMismatch?: 'switch' | 'warn'\n  /** 平台切换回调（onDetectMismatch = 'switch' 时触发） */\n  onPlatformChange?: (platform: PlatformId) => void\n}\n\n/**\n * 通用播放器：根据平台从运行时注册表选择模拟器（EmulatorJS / Ruffle …）。\n *  idle    —— 显示封面与「选择 ROM 开始游戏」，支持拖拽\n *  loading —— 已选择文件，运行时资源加载中\n *  running —— 运行时已就绪（运行在独立 iframe 内）\n *\n * 联机模式（online）：游戏跑在 cloud-game 服务器上，开始即自动创建房间，\n * 房间会出现在侧边栏「联机玩」里；朋友通过邀请链接（?room=）加入并选手柄位。\n * 详情页在联机可用时默认联机，可随时切回本地运行。\n */\nexport function EmulatorPlayer({\n  platform,\n  gameName,\n  gameSlug,\n  maxPlayers = 2,\n  joinRoomId,\n  backdrop,\n  icon,\n  className,\n  romUrl,\n  romChecking,\n  onDetectMismatch = 'warn',\n  onPlatformChange,\n}: Props) {\n  const [status, setStatus] = useState<Status>('idle')\n  const [file, setFile] = useState<File | null>(null)\n  const [error, setError] = useState<string | null>(null)\n  const [notice, setNotice] = useState<string | null>(null)\n  const [dragging, setDragging] = useState(false)\n  const [session, setSession] = useState<ActiveSession | null>(null)\n\n  // 联机\n  const onlineOk = Boolean(gameSlug) && cloudPlayable(platform.id)\n  const [mode, setMode] = useState<Mode>(onlineOk ? 'online' : 'local')\n  const [roomId, setRoomId] = useState<string | null>(null)\n  const [cloudState, setCloudState] = useState<CloudState | null>(null)\n  const [copied, setCopied] = useState(false)\n  /** 实际使用的手柄位（服务器可能改判，以它的回复为准） */\n  const [slotIndex, setSlotIndex] = useState(0)\n  /** 离开房间后不要再按邀请链接里的 ?room= 重新加入 */\n  const [ignoreInvite, setIgnoreInvite] = useState(false)\n  const slots = Math.max(1, Math.min(MAX_PLAYERS, maxPlayers))\n  const inviteRoomId = ignoreInvite ? undefined : joinRoomId\n  // 加入别人的房间：先看看房间信息（host、已占用的手柄位）\n  const joinRoom = useRoom(onlineOk && status === 'idle' ? inviteRoomId : undefined)\n  const joinFull = Boolean(inviteRoomId && joinRoom && joinRoom.players >= slots)\n  // 房间信息还没查回来就不能加入：否则会拿到 0（房主的位）跟房主撞车\n  const joinPending = Boolean(inviteRoomId) && roomsEnabled() && joinRoom === undefined\n  // 自己所在的房间（用于工具栏显示人数）\n  const myRoom = useRoom(session?.cloud ? (roomId ?? undefined) : undefined)\n\n  const hostRef = useRef<HTMLDivElement>(null)\n  const frameRef = useRef<HTMLDivElement>(null)\n  const inputRef = useRef<HTMLInputElement>(null)\n  const sessionCounter = useRef(0)\n  // gameName 只用于存档 / 截图命名，放进 effect 依赖会导致「切换语言就把正在跑的游戏重启」\n  const gameNameRef = useRef(gameName)\n  gameNameRef.current = gameName\n\n  // 云端 ROM 也按其文件扩展名选引擎；还没拿到地址时退回平台默认\n  const pageRuntime = resolveRuntime({ platform: platform.id, ext: extOf(romUrl) })\n  const supported = Boolean(pageRuntime) || onlineOk\n  const { immersive, toggleImmersive } = useShell()\n  const t = useT()\n\n  // 会话变化时挂载 / 卸载运行时\n  useEffect(() => {\n    const host = frameRef.current\n    if (!session || !host) return\n    const destroy = session.runtime.mount(host, {\n      platform: session.platform,\n      game: session.game,\n      gameName: gameNameRef.current,\n      cloud: session.cloud,\n      onReady: () => setStatus('running'),\n      onError: (message: string) => {\n        setError(message)\n        setStatus('error')\n        // 出错后必须把会话拆掉：否则运行时会在隐藏的挂载点里继续活着\n        // （联机模式下就是 WebSocket / WebRTC / 房间心跳全都还在后台跑）\n        setSession(null)\n      },\n    })\n    return destroy\n  }, [session])\n\n  // 联机期间向本站后端心跳，房间才会出现在「联机玩」列表里\n  useEffect(() => {\n    if (!session?.cloud || !roomId || !gameSlug) return\n    return keepAlive({\n      roomId,\n      gameSlug,\n      playerIndex: session.cloud.playerIndex,\n      host: !session.cloud.roomId,\n    })\n  }, [session, roomId, gameSlug])\n\n  useEffect(() => {\n    if (!copied) return\n    const timer = window.setTimeout(() => setCopied(false), 2000)\n    return () => window.clearTimeout(timer)\n  }, [copied])\n\n  const begin = (game: File | string, targetPlatform: PlatformId, runtime: Runtime, cloud?: CloudSession) => {\n    sessionCounter.current += 1\n    setSession({ id: sessionCounter.current, game, platform: targetPlatform, runtime, cloud })\n    setStatus('loading')\n  }\n\n  /** 联机：创建房间（join 为空）或加入房间 */\n  const startOnline = (join?: string) => {\n    if (!gameSlug) return\n    setError(null)\n    setNotice(null)\n    setRoomId(join ?? null)\n    setCloudState('connecting')\n    // 加入别人的房间时挑一个空位；房间信息拿不到（没配后端）就退让到 2P，别去抢房主的 1P\n    const playerIndex = join ? (joinRoom ? freePlayerIndex(joinRoom, slots) : Math.min(1, slots - 1)) : 0\n    setSlotIndex(playerIndex)\n    begin(romUrl ?? '', platform.id, cloudGameRuntime, {\n      gameId: gameSlug,\n      roomId: join,\n      playerIndex,\n      onRoom: (id) => setRoomId(id),\n      onPlayerIndex: (i) => setSlotIndex(i),\n      onState: (s) => setCloudState(s),\n    })\n  }\n\n  const start = useCallback(\n    async (picked: File | null) => {\n      setError(null)\n      setNotice(null)\n\n      // 云端 ROM\n      if (!picked) {\n        if (!romUrl || !pageRuntime) return\n        begin(romUrl, platform.id, pageRuntime)\n        return\n      }\n\n      // 本地文件：先嗅探类型，决定运行时\n      const detection = await detectRom(picked)\n      let targetPlatform: PlatformId = platform.id\n      if (detection.platform && detection.platform !== platform.id && detection.confidence !== 'low') {\n        if (onDetectMismatch === 'switch') {\n          targetPlatform = detection.platform\n          onPlatformChange?.(detection.platform)\n          setNotice(describeDetection(detection))\n        } else if (!isRomFileAccepted(picked, platform.romExtensions)) {\n          // 页面平台不接受这种文件，但识别出了别的平台：直接用识别结果运行\n          targetPlatform = detection.platform\n          setNotice(fmt(t.player.detectUse, { reason: describeDetection(detection) }))\n        } else {\n          setNotice(\n            fmt(t.player.detectKeep, {\n              reason: describeDetection(detection),\n              platform: platformLabel(t, platform.id, platform.name),\n            }),\n          )\n        }\n      } else if (!isRomFileAccepted(picked, platform.romExtensions)) {\n        setError(\n          fmt(t.player.badFormat, {\n            platform: platformLabel(t, platform.id, platform.name),\n            exts: platform.romExtensions.join(t.player.extSep),\n          }),\n        )\n        return\n      }\n\n      // 按「平台 + 文件扩展名」选引擎：.nes 会走 jsnes，.swf 走 Ruffle，其余交给 EmulatorJS\n      const runtime = resolveRuntime({ platform: targetPlatform, ext: extOf(picked) })\n      if (!runtime) {\n        setError(\n          fmt(t.player.noRuntime, {\n            platform: platformLabel(t, targetPlatform, platformMap[targetPlatform]?.name ?? targetPlatform),\n          }),\n        )\n        return\n      }\n      setFile(picked)\n      begin(picked, targetPlatform, runtime)\n    },\n    [platform, romUrl, pageRuntime, onDetectMismatch, onPlatformChange, t],\n  )\n\n  const reset = () => {\n    // 主动离开房间后，URL 里的 ?room= 就不该再把人拉回同一个房间\n    if (session?.cloud || joinRoomId) setIgnoreInvite(true)\n    setSession(null)\n    setStatus('idle')\n    setFile(null)\n    setError(null)\n    setNotice(null)\n    setRoomId(null)\n    setCloudState(null)\n    if (inputRef.current) inputRef.current.value = ''\n  }\n\n  const copyInvite = async () => {\n    if (!gameSlug || !roomId) return\n    try {\n      await navigator.clipboard.writeText(roomLink(gameSlug, roomId))\n      setCopied(true)\n    } catch {\n      /* 剪贴板不可用时忽略 */\n    }\n  }\n\n  const onDrop = (e: DragEvent) => {\n    e.preventDefault()\n    setDragging(false)\n    const dropped = e.dataTransfer.files?.[0]\n    if (dropped) void start(dropped)\n  }\n\n  const toggleFullscreen = () => {\n    const el = hostRef.current\n    if (!el) return\n    if (document.fullscreenElement) void document.exitFullscreen()\n    else void el.requestFullscreen?.()\n  }\n\n  const busy = status === 'loading' || status === 'running'\n  const online = mode === 'online' && onlineOk\n  const joining = online && Boolean(inviteRoomId)\n  const activeRuntime = session?.runtime ?? (online ? cloudGameRuntime : pageRuntime)\n  const activePlatform = session ? platformMap[session.platform] : platform\n  const cloudStateLabel = cloudState ? t.player.cloudState[cloudState] : ''\n\n  /** 空闲态主按钮 */\n  const primaryAction = () => {\n    if (online) {\n      startOnline(inviteRoomId || undefined)\n      return\n    }\n    if (romUrl) void start(null)\n    else inputRef.current?.click()\n  }\n\n  return (\n    <div className={cx('overflow-hidden rounded-2xl border border-line bg-black', className)}>\n      {/* 画面区域 */}\n      <div\n        ref={hostRef}\n        className={cx('relative aspect-video w-full bg-black', dragging && 'ring-2 ring-brand ring-inset')}\n        onDragOver={(e) => {\n          e.preventDefault()\n          if (!busy) setDragging(true)\n        }}\n        onDragLeave={() => setDragging(false)}\n        onDrop={onDrop}\n      >\n        {/* 运行时挂载点：iframe 由运行时注入，React 不管理其子节点 */}\n        <div ref={frameRef} className={cx('absolute inset-0', busy ? 'block' : 'hidden')} />\n\n        {!busy && (\n          <div className=\"absolute inset-0\">\n            <div className=\"absolute inset-0 opacity-60 blur-sm\">{backdrop}</div>\n            <div className=\"scanlines absolute inset-0\" aria-hidden />\n            <div className=\"absolute inset-0 bg-gradient-to-t from-black via-black/60 to-black/20\" />\n\n            <div className=\"absolute inset-0 flex flex-col items-center justify-center gap-4 px-6 text-center\">\n              {icon && (\n                <span className=\"hidden text-6xl drop-shadow-[0_8px_16px_rgba(0,0,0,0.6)] sm:block sm:text-7xl\" aria-hidden>\n                  {icon}\n                </span>\n              )}\n              {supported ? (\n                <>\n                  <Button size=\"lg\" disabled={(!online && romChecking) || joinFull || joinPending} onClick={primaryAction}>\n                    <span aria-hidden>{online ? '👥' : '▶'}</span>{' '}\n                    {joining\n                      ? joinFull\n                        ? t.player.roomFull\n                        : joinPending\n                          ? t.player.roomLookup\n                          : t.player.joinRoom\n                      : online\n                        ? t.player.onlineStart\n                        : romChecking\n                          ? t.player.checkingCloud\n                          : romUrl\n                            ? t.player.start\n                            : t.player.pickRom}\n                  </Button>\n                  <p className=\"max-w-md text-[11px] leading-relaxed text-white/70 sm:text-xs\">\n                    {joining ? (\n                      <>\n                        {joinRoom\n                          ? fmt(t.player.joinHint, {\n                              host: joinRoom.host?.nickname ?? '—',\n                              players: String(joinRoom.players),\n                              max: String(slots),\n                              slot: String(freePlayerIndex(joinRoom, slots) + 1),\n                            })\n                          : !roomsEnabled()\n                            ? t.player.joinHintNoList\n                            : joinRoom === undefined\n                              ? t.player.roomLookup\n                              : t.player.roomGone}\n                        <br />\n                        <button type=\"button\" className=\"mx-1 underline underline-offset-2 hover:text-white\" onClick={() => startOnline()}>\n                          {t.player.createOwnRoom}\n                        </button>\n                      </>\n                    ) : online ? (\n                      <>\n                        {fmt(t.player.onlineHint, { max: String(slots) })}\n                        <br />\n                        {t.player.alsoCan}\n                        <button type=\"button\" className=\"mx-1 underline underline-offset-2 hover:text-white\" onClick={() => setMode('local')}>\n                          {t.player.localInstead}\n                        </button>\n                        {pageRuntime ? fmt(t.player.localInsteadHint, { runtime: pageRuntime.name }) : ''}\n                      </>\n                    ) : romUrl ? (\n                      <>\n                        {fmt(t.player.cloudHint, { runtime: pageRuntime?.name ?? '' })}\n                        <br />\n                        {t.player.alsoCan}\n                        <button type=\"button\" className=\"mx-1 underline underline-offset-2 hover:text-white\" onClick={() => inputRef.current?.click()}>\n                          {t.player.pickLocal}\n                        </button>\n                        {t.player.orDrag}\n                        {onlineOk && (\n                          <>\n                            {' '}\n                            <button type=\"button\" className=\"mx-1 underline underline-offset-2 hover:text-white\" onClick={() => setMode('online')}>\n                              {t.player.onlineInstead}\n                            </button>\n                          </>\n                        )}\n                      </>\n                    ) : romChecking ? (\n                      <>{t.player.checkingHint}</>\n                    ) : (\n                      <>\n                        {fmt(t.player.dropHint, { platform: platformLabel(t, platform.id, platform.name) })}\n                        <br />\n                        {fmt(t.player.formats, {\n                          exts: platform.romExtensions.join(' '),\n                          runtime: pageRuntime?.name ?? '',\n                        })}\n                        {onlineOk && (\n                          <>\n                            {' '}\n                            <button type=\"button\" className=\"mx-1 underline underline-offset-2 hover:text-white\" onClick={() => setMode('online')}>\n                              {t.player.onlineInstead}\n                            </button>\n                          </>\n                        )}\n                      </>\n                    )}\n                  </p>\n                </>\n              ) : (\n                <div className=\"max-w-md rounded-xl border border-line bg-black/60 p-4 text-sm text-white/80 backdrop-blur\">\n                  <p className=\"font-semibold text-white\">{t.player.unsupportedTitle}</p>\n                  <p className=\"mt-1 text-xs leading-relaxed\">\n                    {fmt(t.player.unsupportedBody, { platform: platformLabel(t, platform.id, platform.name) })}\n                  </p>\n                </div>\n              )}\n              {error && (\n                <p role=\"alert\" className=\"max-w-md rounded-lg bg-live/20 px-3 py-2 text-xs text-red-200\">\n                  {error}\n                </p>\n              )}\n            </div>\n          </div>\n        )}\n\n        {status === 'loading' && (\n          <div className=\"pointer-events-none absolute left-3 top-3 flex items-center gap-2 rounded-lg bg-black/70 px-3 py-1.5 text-xs text-white backdrop-blur\">\n            <span className=\"h-2 w-2 animate-ping rounded-full bg-brand-hover\" />\n            {session?.cloud ? cloudStateLabel || fmt(t.player.loading, { runtime: activeRuntime?.name ?? '' }) : fmt(t.player.loading, { runtime: activeRuntime?.name ?? '' })}\n          </div>\n        )}\n\n        <input\n          ref={inputRef}\n          type=\"file\"\n          accept={onDetectMismatch === 'switch' ? undefined : platform.romExtensions.join(',')}\n          className=\"hidden\"\n          onChange={(e) => void start(e.target.files?.[0] ?? null)}\n        />\n      </div>\n\n      {/* 工具栏 */}\n      <div className=\"flex flex-wrap items-center gap-2 border-t border-line bg-surface px-3 py-2 text-xs\">\n        <span\n          className={cx(\n            'inline-flex items-center gap-1.5 rounded-md px-2 py-1 font-semibold',\n            status === 'running'\n              ? 'bg-online/15 text-online'\n              : status === 'loading'\n                ? 'bg-brand-soft text-brand-hover'\n                : status === 'error'\n                  ? 'bg-live/15 text-red-300'\n                  : 'bg-white/5 text-muted',\n          )}\n        >\n          <span className={cx('h-1.5 w-1.5 rounded-full', status === 'running' ? 'bg-online' : 'bg-current')} />\n          {status === 'running'\n            ? t.player.statusRunning\n            : status === 'loading'\n              ? t.player.statusLoading\n              : status === 'error'\n                ? t.player.statusError\n                : t.player.statusIdle}\n        </span>\n\n        {session?.cloud ? (\n          <>\n            <span className=\"inline-flex items-center gap-1 rounded-md bg-brand-soft px-2 py-1 font-semibold text-brand-hover\" title={roomId ?? ''}>\n              👥 {fmt(t.player.roomBadge, { players: String(myRoom?.players ?? 1), max: String(slots) })}\n              <span className=\"font-normal text-muted\">· {fmt(t.player.slotLabel, { n: String(slotIndex + 1) })}</span>\n            </span>\n            {roomId && (\n              <button type=\"button\" onClick={() => void copyInvite()} className=\"rounded-md border border-line px-2 py-1 text-muted hover:text-fg\">\n                {copied ? t.player.copied : t.player.copyInvite}\n              </button>\n            )}\n            {status === 'running' && cloudState && cloudState !== 'playing' && <span className=\"text-red-300\">{cloudStateLabel}</span>}\n          </>\n        ) : file ? (\n          <span className=\"truncate text-muted\" title={file.name}>\n            📄 {file.name} · {formatBytes(file.size)}\n          </span>\n        ) : (\n          busy &&\n          romUrl && (\n            <span className=\"truncate text-muted\" title={romUrl}>\n              {fmt(t.player.cloudRom, { name: romUrl.split('/').pop() ?? '' })}\n            </span>\n          )\n        )}\n        <span className=\"text-muted\" title={t.player.runtimeCore}>\n          {activeRuntime\n            ? `${activeRuntime.name} · ${activeRuntime.engineLabel(activePlatform?.id ?? platform.id)}`\n            : t.player.noRuntimeShort}\n        </span>\n        {notice && (\n          <span data-testid=\"detect-notice\" className=\"truncate text-brand-hover\">\n            {notice}\n          </span>\n        )}\n\n        <div className=\"ml-auto flex items-center gap-1.5\">\n          {(busy || status === 'error') && (\n            <Button variant=\"ghost\" size=\"sm\" onClick={reset}>\n              {online ? t.player.leaveRoom : t.player.changeRom}\n            </Button>\n          )}\n          {supported && (\n            <>\n              <Button\n                variant={immersive ? 'primary' : 'secondary'}\n                size=\"sm\"\n                onClick={toggleImmersive}\n                title={t.player.immersiveTitle}\n                aria-pressed={immersive}\n              >\n                {immersive ? t.player.exitImmersive : t.player.enterImmersive}\n              </Button>\n              <Button variant=\"secondary\" size=\"sm\" onClick={toggleFullscreen} title={t.player.fullscreenTitle}>\n                {t.player.fullscreen}\n              </Button>\n            </>\n          )}\n        </div>\n      </div>\n    </div>\n  )\n}\n",
 "src/emulator/adapters/cloudgame.ts": "/**\n * cloud-game 运行时：远程联机（游戏跑在服务器上，画面走 WebRTC 推回浏览器）。\n *\n * 与其它引擎最大的不同：游戏不在浏览器里运行，而是在部署了\n * https://github.com/giongto35/cloud-game 的服务器上由 libretro 核心运行，\n * 服务器把画面 / 声音编码后经 WebRTC 推回来，浏览器把手柄输入经 DataChannel 发过去。\n * 同一个房间里的所有人看的是同一路流，各自控制自己的手柄位 —— 这就是「远程联机」。\n *\n * 协议（对照 cloud-game 的 web/js/api.js）：\n *   1. WebSocket 连 coordinator：/ws?room_id=<房间>&zone=<区域>\n *   2. 收到 INIT(4)：拿到 ICE 服务器列表 → 建 RTCPeerConnection，发 offer（INIT_WEBRTC_STREAM 100）\n *   3. WEBRTC_SIGNAL(101) 往返 sdp / ice\n *   4. PeerConnection 连通后发 GAME_START(104)：{ game_name, room_id, player_index }\n *   5. 服务器回 GAME_START：{ roomId } —— 房间 id，分享给朋友就能加入\n *   6. 手柄状态打包成 10 字节（[按键位图, 左摇杆X, 左摇杆Y, 右摇杆X, 右摇杆Y]）走名为 \"data\" 的 DataChannel\n *\n * ROM 约定：cloud-game 只能跑它自己文件系统里的游戏（library.basePath），\n * 不能上传本地文件。本站把 R2 里的 ROM 同步到服务器，文件名 = <slug>.<ext>，\n * 因此 GAME_START 的 game_name 就是游戏 slug。见 deploy/cloudgame/README.md。\n *\n * 启用：.env 里设 VITE_CLOUDGAME_URL=https://cg.example.com（或 http://localhost:8000）。\n * 没配置时 available() 返回 false，界面上不会出现联机入口。\n */\nimport type { PlatformId } from '@/types'\nimport type { MountOptions, Runtime } from '../types'\nimport { getT, fmt } from '@/services/i18n'\n\nexport const CLOUDGAME_URL: string = (import.meta.env.VITE_CLOUDGAME_URL || '').replace(/\\/+$/, '')\nexport const CLOUDGAME_ZONE: string = import.meta.env.VITE_CLOUDGAME_ZONE || ''\n\n/** 从连上服务器到真正开始游戏的总超时。超过就报错，而不是让转圈一直转下去 */\nconst HANDSHAKE_TIMEOUT_MS = 30_000\n\n/**\n * 本站平台 → 服务器 libretro 核心。\n * 键必须和 deploy/cloudgame/config.yaml 里 emulator.libretro.cores.list 的配置一致；\n * 不在这里的平台（Flash / J2ME / NDS / WonderSwan）不能联机。\n */\nexport const CLOUD_PLATFORM_CORES: Partial<Record<PlatformId, string>> = {\n  nes: 'nestopia',\n  snes: 'snes9x',\n  gba: 'mgba',\n  gb: 'mgba',\n  n64: 'mupen64plus_next',\n  psx: 'pcsx_rearmed',\n  arcade: 'fbneo',\n  dos: 'dosbox_pure',\n  segaMD: 'genesis_plus_gx',\n}\n\n/** 联机会话参数（MountOptions.cloud） */\nexport interface CloudSession {\n  /** 服务器游戏库里的名字（= ROM 文件名去掉后缀；本站约定为游戏 slug） */\n  gameId: string\n  /** 加入已有房间时传房间 id；创建新房间留空 */\n  roomId?: string\n  /** 想要的手柄位，0 = 1P。服务器可能改判，以 onPlayerIndex 为准 */\n  playerIndex: number\n  /** 房间就绪（创建 / 加入成功）时回调，带服务器分配的房间 id */\n  onRoom?: (roomId: string) => void\n  /** 服务器确认 / 改判手柄位时回调 */\n  onPlayerIndex?: (index: number) => void\n  /** 连接状态变化（用于界面提示） */\n  onState?: (state: CloudState) => void\n}\n\nexport type CloudState = 'connecting' | 'negotiating' | 'starting' | 'playing' | 'disconnected' | 'no-slots'\n\n/* ---------------- 协议常量（见 cloud-game web/js/api.js） ---------------- */\nconst EP = {\n  LATENCY_CHECK: 3,\n  INIT: 4,\n  INIT_WEBRTC_STREAM: 100,\n  WEBRTC_SIGNAL: 101,\n  GAME_START: 104,\n  GAME_QUIT: 105,\n  GAME_SAVE: 106,\n  GAME_LOAD: 107,\n  GAME_SET_PLAYER_INDEX: 108,\n  GAME_ERROR_NO_FREE_SLOTS: 112,\n  GAME_RESET: 113,\n} as const\n\ninterface Packet {\n  t: number\n  id?: string\n  p?: unknown\n}\n\ninterface InitPayload {\n  wid?: string\n  ice?: Array<{ urls: string; username?: string; credential?: string }>\n}\n\n/**\n * libretro RETRO_DEVICE_ID_JOYPAD_* 顺序，位图第 n 位对应第 n 个按键。\n * 顺序必须与 cloud-game web/js/input/keys.js 的 JOYPAD_KEYS 一致。\n */\nconst JOYPAD = ['b', 'y', 'select', 'start', 'up', 'down', 'left', 'right', 'a', 'x', 'l', 'r', 'l2', 'r2', 'l3', 'r3'] as const\ntype PadKey = (typeof JOYPAD)[number]\nconst BIT: Record<PadKey, number> = Object.fromEntries(JOYPAD.map((k, i) => [k, 1 << i])) as Record<PadKey, number>\n\n/** 键盘映射：与本站 EmulatorJS 的默认键位保持一致（见 src/lib/emulator.ts 的 defaultKeymap） */\nconst KEYMAP: Record<string, PadKey> = {\n  ArrowUp: 'up',\n  ArrowDown: 'down',\n  ArrowLeft: 'left',\n  ArrowRight: 'right',\n  KeyZ: 'a',\n  KeyX: 'b',\n  KeyA: 'x',\n  KeyS: 'y',\n  KeyQ: 'l',\n  KeyE: 'r',\n  Enter: 'start',\n  KeyV: 'select',\n  ShiftLeft: 'select',\n  Digit1: 'l2',\n  Digit2: 'r2',\n}\n\n/** 浏览器 Gamepad API 标准布局（standard mapping）的按钮序号 → RetroPad */\nconst GAMEPAD_BUTTONS: Array<PadKey | null> = [\n  'b', // 0 南（Xbox A）\n  'a', // 1 东（Xbox B）\n  'y', // 2 西（Xbox X）\n  'x', // 3 北（Xbox Y）\n  'l', // 4\n  'r', // 5\n  'l2', // 6\n  'r2', // 7\n  'select', // 8\n  'start', // 9\n  'l3', // 10\n  'r3', // 11\n  'up', // 12\n  'down', // 13\n  'left', // 14\n  'right', // 15\n]\n\n/** 焦点在输入框里时不要抢键盘 */\nfunction isEditable(el: Element | null): boolean {\n  if (!el) return false\n  const tag = el.tagName\n  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || (el as HTMLElement).isContentEditable === true\n}\n\nfunction wsUrl(roomId: string | undefined): string {\n  const base = CLOUDGAME_URL.replace(/^http/, 'ws')\n  const url = new URL(`${base}/ws`)\n  if (roomId) url.searchParams.set('room_id', roomId)\n  if (CLOUDGAME_ZONE) url.searchParams.set('zone', CLOUDGAME_ZONE)\n  return url.toString()\n}\n\nfunction mount(container: HTMLElement, options: MountOptions): () => void {\n  const rt = getT().runtime\n  const cloud = options.cloud\n\n  if (!CLOUDGAME_URL) {\n    options.onError?.(rt.cloudNotConfigured)\n    return () => {}\n  }\n  if (!cloud) {\n    options.onError?.(rt.cloudNoSession)\n    return () => {}\n  }\n\n  let destroyed = false\n  let ws: WebSocket | null = null\n  let pc: RTCPeerConnection | null = null\n  let dataChannel: RTCDataChannel | null = null\n  /** GAME_START 已发出（用于去重），不代表服务器已接受 */\n  let startSent = false\n  /** 服务器已确认开始，游戏真正跑起来了 */\n  let playing = false\n  /** 服务器分配的房间 id：退出、存档等消息都要带它，不能用请求里的空值 */\n  let assignedRoomId = cloud.roomId ?? ''\n  const stream = new MediaStream()\n  const pendingIce: RTCIceCandidateInit[] = []\n\n  const setState = (s: CloudState) => {\n    if (!destroyed) cloud.onState?.(s)\n  }\n  const fail = (msg: string) => {\n    window.clearTimeout(watchdog)\n    if (!destroyed) options.onError?.(msg)\n  }\n\n  // 握手看门狗：连不上 / 服务器不回应时给出明确错误，而不是永远转圈\n  const watchdog = window.setTimeout(() => {\n    if (!destroyed && !playing) {\n      setState('disconnected')\n      fail(rt.cloudTimeout)\n    }\n  }, HANDSHAKE_TIMEOUT_MS)\n\n  /* ---------------- 画面 ---------------- */\n  const host = document.createElement('div')\n  host.tabIndex = 0\n  host.style.cssText = 'position:relative;width:100%;height:100%;background:#000;outline:none;display:flex;align-items:center;justify-content:center'\n  const video = document.createElement('video')\n  video.autoplay = true\n  video.playsInline = true\n  video.muted = false\n  video.style.cssText = 'width:100%;height:100%;object-fit:contain;background:#000;image-rendering:pixelated'\n  video.srcObject = stream\n  host.appendChild(video)\n  container.appendChild(host)\n\n  /* ---------------- 信令 ---------------- */\n  const send = (t: number, p?: unknown) => {\n    if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ t, ...(p !== undefined ? { p } : {}) }))\n  }\n\n  const startGame = () => {\n    if (startSent || destroyed) return\n    startSent = true\n    setState('starting')\n    send(EP.GAME_START, {\n      game_name: cloud.gameId,\n      room_id: cloud.roomId ?? '',\n      player_index: cloud.playerIndex,\n    })\n  }\n\n  const setupPeer = (init: InitPayload | undefined) => {\n    // 重复的 INIT 不能再建一条连接，否则上一条会泄漏（销毁函数只关得掉最后一条）\n    if (pc || destroyed) return\n    setState('negotiating')\n    const iceServers = (init?.ice ?? []).map((s) => ({\n      urls: s.urls,\n      ...(s.username ? { username: s.username } : {}),\n      ...(s.credential ? { credential: s.credential } : {}),\n    }))\n    pc = new RTCPeerConnection({ iceServers })\n\n    // 输入通道：双方约定 id=0、不重传（丢一帧输入无所谓，低延迟更重要）\n    dataChannel = pc.createDataChannel('data', { negotiated: true, id: 0, ordered: false, maxRetransmits: 0 })\n    dataChannel.binaryType = 'arraybuffer'\n    // 服务器也可能把控制消息从这条通道推过来\n    dataChannel.onmessage = (ev) => {\n      let packet: Packet | null = null\n      try {\n        const text = typeof ev.data === 'string' ? ev.data : new TextDecoder().decode(ev.data as ArrayBuffer)\n        packet = JSON.parse(text) as Packet\n      } catch {\n        return // 非 JSON 数据忽略\n      }\n      handlePacket(packet)\n    }\n\n    pc.addTransceiver('video', { direction: 'recvonly' })\n    pc.addTransceiver('audio', { direction: 'recvonly' })\n    pc.ontrack = (ev) => {\n      stream.addTrack(ev.track)\n      void video.play().catch(() => {\n        /* 自动播放被拦时用户点一下画面即可 */\n      })\n    }\n    pc.onicecandidate = (ev) => {\n      if (ev.candidate) send(EP.WEBRTC_SIGNAL, { ice: JSON.stringify(ev.candidate) })\n    }\n    pc.onconnectionstatechange = () => {\n      if (!pc || destroyed) return\n      if (pc.connectionState === 'connected') startGame()\n      else if (pc.connectionState === 'failed' || pc.connectionState === 'closed') {\n        setState('disconnected')\n        fail(rt.cloudDisconnected)\n      }\n    }\n    pc.onsignalingstatechange = () => {\n      if (pc?.signalingState === 'stable') flushIce()\n    }\n\n    void (async () => {\n      try {\n        const offer = await pc.createOffer()\n        // Chrome：强制 Opus 立体声（与官方客户端一致）\n        offer.sdp = offer.sdp?.replace(/(a=fmtp:111 .*)/g, '$1;stereo=1')\n        await pc.setLocalDescription(offer)\n        send(EP.INIT_WEBRTC_STREAM, { initiator: true, sdp: JSON.stringify(offer) })\n      } catch (e) {\n        fail(fmt(rt.cloudWebrtcFailed, { msg: e instanceof Error ? e.message : String(e) }))\n      }\n    })()\n  }\n\n  const flushIce = () => {\n    if (!pc || !pc.remoteDescription) return\n    while (pendingIce.length) {\n      const c = pendingIce.shift()!\n      void pc.addIceCandidate(new RTCIceCandidate(c)).catch(() => {})\n    }\n  }\n\n  const onPacket = (m: Packet) => {\n    if (destroyed) return\n    switch (m.t) {\n      case EP.INIT:\n        setupPeer(m.p as InitPayload | undefined)\n        break\n      case EP.WEBRTC_SIGNAL: {\n        const p = (m.p ?? {}) as { ice?: string; sdp?: string }\n        if (p.sdp && pc) {\n          void pc\n            .setRemoteDescription(new RTCSessionDescription(JSON.parse(p.sdp)))\n            .then(flushIce)\n            .catch((e: unknown) => {\n              fail(fmt(rt.cloudWebrtcFailed, { msg: e instanceof Error ? e.message : String(e) }))\n            })\n        } else if (p.ice) {\n          const cand = JSON.parse(p.ice) as RTCIceCandidateInit\n          if (pc?.remoteDescription && pc.signalingState === 'stable') void pc.addIceCandidate(new RTCIceCandidate(cand)).catch(() => {})\n          else pendingIce.push(cand)\n        }\n        break\n      }\n      case EP.GAME_START: {\n        const p = (m.p ?? {}) as { roomId?: string }\n        // 服务器确认开始，此时才算真的在玩\n        playing = true\n        window.clearTimeout(watchdog)\n        if (p.roomId) {\n          assignedRoomId = p.roomId\n          cloud.onRoom?.(p.roomId)\n        }\n        setState('playing')\n        options.onReady?.()\n        options.onStart?.()\n        startInput()\n        host.focus({ preventScroll: true })\n        break\n      }\n      case EP.GAME_SET_PLAYER_INDEX: {\n        // 服务器可能改判手柄位，界面上要显示真实的那个\n        const idx = Number(m.p)\n        if (!Number.isNaN(idx)) cloud.onPlayerIndex?.(idx)\n        break\n      }\n      case EP.GAME_ERROR_NO_FREE_SLOTS:\n        // 服务器拒绝了，这局根本没开始\n        startSent = false\n        setState('no-slots')\n        fail(rt.cloudNoSlots)\n        break\n      case EP.LATENCY_CHECK: {\n        // coordinator 让我们测几个 worker 的延迟：这里不做真实测量，全部回 0 让它随便选\n        const list = (m.p as string[] | undefined) ?? []\n        const res: Record<string, number> = {}\n        for (const addr of list) res[addr] = 0\n        if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ t: EP.LATENCY_CHECK, id: m.id, p: res }))\n        break\n      }\n      default:\n        break\n    }\n  }\n\n  /** 包处理里出的异常要变成可见的错误，不能静默吞掉让界面一直转圈 */\n  const handlePacket = (m: Packet) => {\n    try {\n      onPacket(m)\n    } catch (e) {\n      fail(fmt(rt.cloudProtocolError, { msg: e instanceof Error ? e.message : String(e) }))\n    }\n  }\n\n  setState('connecting')\n  try {\n    ws = new WebSocket(wsUrl(cloud.roomId))\n  } catch (e) {\n    fail(fmt(rt.cloudConnectFailed, { msg: e instanceof Error ? e.message : String(e) }))\n    return () => {\n      destroyed = true\n      window.clearTimeout(watchdog)\n      host.remove()\n    }\n  }\n  ws.onmessage = (ev) => {\n    let packet: Packet | null = null\n    try {\n      packet = JSON.parse(ev.data as string) as Packet\n    } catch {\n      return\n    }\n    handlePacket(packet)\n  }\n  ws.onerror = () => {\n    if (!playing) fail(fmt(rt.cloudConnectFailed, { msg: CLOUDGAME_URL }))\n  }\n  ws.onclose = () => {\n    if (destroyed) return\n    // 开局前断 = 连不上；开局后断 = 信令掉线，游戏也维持不下去了\n    setState('disconnected')\n    fail(playing ? rt.cloudDisconnected : fmt(rt.cloudConnectFailed, { msg: CLOUDGAME_URL }))\n  }\n\n  /* ---------------- 输入 ---------------- */\n  const state = new Int16Array(5) // [buttons, lx, ly, rx, ry]\n  let keyboardBits = 0\n  let lastSent = ''\n  let raf = 0\n\n  const sendPad = () => {\n    if (dataChannel?.readyState !== 'open') return\n    const sig = state.join(',')\n    if (sig === lastSent) return\n    lastSent = sig\n    dataChannel.send(new Uint16Array(state.buffer))\n  }\n\n  const pollGamepad = () => {\n    let bits = keyboardBits\n    let lx = 0\n    let ly = 0\n    let rx = 0\n    let ry = 0\n    const pads = typeof navigator.getGamepads === 'function' ? navigator.getGamepads() : []\n    for (const gp of pads) {\n      if (!gp) continue\n      gp.buttons.forEach((b, i) => {\n        const key = GAMEPAD_BUTTONS[i]\n        if (key && (b.pressed || b.value > 0.5)) bits |= BIT[key]\n      })\n      const ax = (i: number) => {\n        const v = gp.axes[i] ?? 0\n        return Math.abs(v) < 0.15 ? 0 : Math.trunc(Math.max(-1, Math.min(1, v)) * 32767)\n      }\n      lx ||= ax(0)\n      ly ||= ax(1)\n      rx ||= ax(2)\n      ry ||= ax(3)\n      // 左摇杆也当十字键用\n      if (lx < -16000) bits |= BIT.left\n      if (lx > 16000) bits |= BIT.right\n      if (ly < -16000) bits |= BIT.up\n      if (ly > 16000) bits |= BIT.down\n      break // 只取第一只手柄\n    }\n    state[0] = bits\n    state[1] = lx\n    state[2] = ly\n    state[3] = rx\n    state[4] = ry\n    sendPad()\n    raf = requestAnimationFrame(pollGamepad)\n  }\n\n  const onKeyDown = (e: KeyboardEvent) => {\n    const key = KEYMAP[e.code]\n    if (!key) return\n    const active = document.activeElement\n    // 在输入框里打字时不要抢键盘\n    if (isEditable(active)) return\n    // 焦点在页面上别的按钮 / 链接上时，Enter 留给它，别把「回车激活」吞掉\n    if (e.code === 'Enter' && active && active !== document.body && !host.contains(active)) return\n    e.preventDefault()\n    if (e.repeat) return\n    keyboardBits |= BIT[key]\n  }\n\n  /**\n   * 松开永远要处理，且不能带任何焦点条件 ——\n   * 否则「按住方向键时焦点跑到别处」会让这个键永远卡在按下状态。\n   */\n  const onKeyUp = (e: KeyboardEvent) => {\n    const key = KEYMAP[e.code]\n    if (!key) return\n    keyboardBits &= ~BIT[key]\n  }\n\n  /** 切到别的窗口 / 标签页时把所有键松开，避免回来时角色还在跑 */\n  const releaseAll = () => {\n    keyboardBits = 0\n  }\n  const onVisibility = () => {\n    if (document.hidden) releaseAll()\n  }\n  const onClick = () => {\n    host.focus({ preventScroll: true })\n    void video.play().catch(() => {})\n  }\n\n  let inputStarted = false\n  const startInput = () => {\n    if (inputStarted || destroyed) return\n    inputStarted = true\n    window.addEventListener('keydown', onKeyDown)\n    window.addEventListener('keyup', onKeyUp)\n    window.addEventListener('blur', releaseAll)\n    document.addEventListener('visibilitychange', onVisibility)\n    host.addEventListener('click', onClick)\n    raf = requestAnimationFrame(pollGamepad)\n  }\n\n  /* ---------------- 销毁 ---------------- */\n  return () => {\n    destroyed = true\n    window.clearTimeout(watchdog)\n    cancelAnimationFrame(raf)\n    window.removeEventListener('keydown', onKeyDown)\n    window.removeEventListener('keyup', onKeyUp)\n    window.removeEventListener('blur', releaseAll)\n    document.removeEventListener('visibilitychange', onVisibility)\n    host.removeEventListener('click', onClick)\n    try {\n      // 只有真的开局了才需要告诉服务器退出，且必须带服务器分配的房间 id\n      if (playing && assignedRoomId) send(EP.GAME_QUIT, { room_id: assignedRoomId })\n    } catch {\n      /* ignore */\n    }\n    try {\n      dataChannel?.close()\n      pc?.close()\n    } catch {\n      /* ignore */\n    }\n    try {\n      // 先摘掉回调再关，避免 close 触发 onclose 里的 fail\n      if (ws) {\n        ws.onmessage = null\n        ws.onerror = null\n        ws.onclose = null\n        ws.close()\n      }\n    } catch {\n      /* ignore */\n    }\n    for (const track of stream.getTracks()) {\n      track.stop()\n      stream.removeTrack(track)\n    }\n    video.srcObject = null\n    host.remove()\n  }\n}\n\nexport const cloudGameRuntime: Runtime = {\n  id: 'cloudgame',\n  name: 'Cloud',\n  get description() {\n    return getT().runtime.cloudDesc\n  },\n  // 不参与「按扩展名选引擎」：联机是用户显式选择的模式，不是文件格式决定的\n  extensions: [],\n  priority: 0,\n  available: () => Boolean(CLOUDGAME_URL),\n  supports: (platform) => Boolean(CLOUD_PLATFORM_CORES[platform]),\n  engineLabel: (platform) => CLOUD_PLATFORM_CORES[platform] ?? '—',\n  mount,\n}\n\n/** 该平台能否联机（引擎可用且平台有对应核心） */\nexport function cloudPlayable(platform: PlatformId): boolean {\n  return cloudGameRuntime.available() && cloudGameRuntime.supports(platform)\n}\n",
 "src/services/rooms.ts": "/**\n * 联机房间：列表 + 心跳。\n *\n * 房间本身由 cloud-game 服务器管理（见 src/emulator/adapters/cloudgame.ts），\n * 但它不对外提供「有哪些房间」。所以每个正在联机的浏览器定期向本站后端\n * /api/rooms/heartbeat 报到，侧边栏「联机玩」从 /api/rooms 读列表。\n *\n * 没配置 VITE_API_URL 时房间列表不可用（联机本身仍可用，只是别人看不到你的房间，\n * 需要手动分享链接）。\n */\nimport { useEffect, useState, useSyncExternalStore } from 'react'\nimport { api, apiEnabled } from './api'\nimport { getCurrentUser } from './auth'\nimport { randomId } from './localStore'\n\nexport interface RoomMember {\n  nickname: string\n  playerIndex: number\n  host: boolean\n}\n\nexport interface Room {\n  roomId: string\n  gameSlug: string\n  createdAt: number\n  host: { nickname: string; userId: string | null } | null\n  players: number\n  playerIndexes: number[]\n  members: RoomMember[]\n}\n\nexport const MAX_PLAYERS = 4\nconst HEARTBEAT_MS = 10_000\nconst LIST_POLL_MS = 8_000\n\n/** 本浏览器的成员 id（游客也要有一个稳定身份） */\nconst MEMBER_KEY = '8bitgo.room.member'\nexport function memberId(): string {\n  try {\n    let id = sessionStorage.getItem(MEMBER_KEY)\n    if (!id) {\n      id = randomId('m')\n      sessionStorage.setItem(MEMBER_KEY, id)\n    }\n    return id\n  } catch {\n    return randomId('m')\n  }\n}\n\nconst GUEST_KEY = '8bitgo.room.guest'\n/** 显示名：登录用户用昵称，游客用「Guest-xxxx」并在本浏览器里保持稳定 */\nexport function displayName(): string {\n  const user = getCurrentUser()\n  if (user?.nickname) return user.nickname\n  try {\n    let g = localStorage.getItem(GUEST_KEY)\n    if (!g) {\n      g = `Guest-${Math.random().toString(36).slice(2, 6).toUpperCase()}`\n      localStorage.setItem(GUEST_KEY, g)\n    }\n    return g\n  } catch {\n    return 'Guest'\n  }\n}\n\nexport function roomsEnabled(): boolean {\n  return apiEnabled()\n}\n\n/** 联机页面链接：朋友打开即可加入 */\nexport function roomLink(gameSlug: string, roomId: string): string {\n  const origin = typeof window !== 'undefined' ? window.location.origin : ''\n  return `${origin}/games/${gameSlug}?room=${encodeURIComponent(roomId)}`\n}\n\nexport async function fetchRooms(): Promise<Room[]> {\n  if (!roomsEnabled()) return []\n  return api.get<Room[]>('/api/rooms')\n}\n\nexport async function fetchRoom(roomId: string): Promise<Room | null> {\n  if (!roomsEnabled()) return null\n  try {\n    return await api.get<Room>(`/api/rooms/${encodeURIComponent(roomId)}`)\n  } catch {\n    return null\n  }\n}\n\n/**\n * 在房间里期间保持心跳；返回停止函数（离开房间时调用，会立刻从列表移除）。\n */\nexport function keepAlive(input: { roomId: string; gameSlug: string; playerIndex: number; host: boolean }): () => void {\n  if (!roomsEnabled()) return () => {}\n  const me = memberId()\n  let stopped = false\n  const beat = () => {\n    if (stopped) return\n    void api\n      .post<Room>('/api/rooms/heartbeat', { ...input, memberId: me, nickname: displayName() })\n      .then((room) => cache.set(room))\n      .catch(() => {})\n  }\n  beat()\n  const timer = window.setInterval(beat, HEARTBEAT_MS)\n  return () => {\n    stopped = true\n    window.clearInterval(timer)\n    void api.del(`/api/rooms/${encodeURIComponent(input.roomId)}/members/${me}`).catch(() => {})\n    cache.remove(input.roomId)\n  }\n}\n\n/* ---------------- 列表缓存（多个组件共享一份轮询） ---------------- */\nconst cache = (() => {\n  let rooms: Room[] = []\n  const listeners = new Set<() => void>()\n  let timer = 0\n  const emit = () => listeners.forEach((l) => l())\n  const refresh = async () => {\n    try {\n      rooms = await fetchRooms()\n      emit()\n    } catch {\n      /* 后端不可达时保留上次结果 */\n    }\n  }\n  return {\n    get: () => rooms,\n    set(room: Room) {\n      const i = rooms.findIndex((r) => r.roomId === room.roomId)\n      rooms = i >= 0 ? rooms.map((r) => (r.roomId === room.roomId ? room : r)) : [room, ...rooms]\n      emit()\n    },\n    remove(roomId: string) {\n      // 乐观更新：自己先从人数里减掉，随后再拉一次真实列表\n      rooms = rooms\n        .map((r) => (r.roomId === roomId ? { ...r, players: Math.max(0, r.players - 1) } : r))\n        .filter((r) => r.players > 0)\n      emit()\n      window.setTimeout(() => void refresh(), 500)\n    },\n    subscribe(l: () => void) {\n      listeners.add(l)\n      if (listeners.size === 1 && roomsEnabled()) {\n        void refresh()\n        timer = window.setInterval(() => void refresh(), LIST_POLL_MS)\n      }\n      return () => {\n        listeners.delete(l)\n        if (listeners.size === 0) window.clearInterval(timer)\n      }\n    },\n    refresh,\n  }\n})()\n\n/** 在线房间列表（自动轮询，多个组件共享一个定时器） */\nexport function useRooms(): Room[] {\n  return useSyncExternalStore(cache.subscribe, cache.get, () => [])\n}\n\n/**\n * 某个房间的实时信息（进入房间页时用，用于选空闲手柄位）。\n * undefined = 还在查询；null = 查不到（房间已关闭，或没配置后端）\n */\nexport function useRoom(roomId: string | undefined): Room | null | undefined {\n  const rooms = useRooms()\n  // 轮询列表里已经有这个房间就直接用，不必额外发请求\n  const fromList = roomId ? rooms.find((r) => r.roomId === roomId) : undefined\n  // 列表里没有（比如刚从邀请链接进来、列表还没轮到）才单独查一次\n  const [fetched, setFetched] = useState<{ roomId: string; room: Room | null } | null>(null)\n\n  useEffect(() => {\n    if (!roomId || fromList) return\n    let cancelled = false\n    void fetchRoom(roomId).then((r) => {\n      if (!cancelled) setFetched({ roomId, room: r })\n    })\n    return () => {\n      cancelled = true\n    }\n  }, [roomId, fromList])\n\n  if (!roomId) return undefined\n  if (fromList) return fromList\n  // 只认当前 roomId 的查询结果，切换房间时不会短暂显示上一个\n  return fetched?.roomId === roomId ? fetched.room : undefined\n}\n\n/** 下一个空闲的手柄位（0 起） */\nexport function freePlayerIndex(room: Room | null | undefined, max = MAX_PLAYERS): number {\n  const taken = new Set(room?.playerIndexes ?? [])\n  for (let i = 0; i < max; i++) if (!taken.has(i)) return i\n  return max - 1\n}\n",
 "src/pages/RoomsPage.tsx": "import { getMultiplayerGames } from '@/services/games'\nimport { useSeo } from '@/services/seo'\nimport { useT, fmt } from '@/services/i18n'\nimport { roomsEnabled, useRooms } from '@/services/rooms'\nimport { cloudPlayable, CLOUDGAME_URL } from '@/emulator'\nimport { GameCard } from '@/components/game/GameCard'\nimport { RoomCard } from '@/components/game/RoomCard'\nimport { SectionHeader } from '@/components/ui/SectionHeader'\n\n/**\n * 联机玩：正在进行中的房间列表。\n * 每个正在联机的玩家自动拥有一个房间（见 EmulatorPlayer），这里按创建时间倒序展示，\n * 点进去就是该游戏的详情页（带 ?room=），选好手柄位即可加入。\n */\nexport function RoomsPage() {\n  const t = useT()\n  useSeo({ title: t.rooms.title, description: t.rooms.seo, noindex: true })\n  const rooms = useRooms()\n  const enabled = roomsEnabled() && Boolean(CLOUDGAME_URL)\n  const suggestions = getMultiplayerGames(12).filter((g) => cloudPlayable(g.platform))\n\n  return (\n    <div className=\"container-x py-8 sm:py-10\">\n      <div className=\"max-w-2xl\">\n        <span className=\"text-pixel text-[11px] text-brand-hover\">MULTIPLAYER</span>\n        <h1 className=\"mt-2 text-3xl font-extrabold tracking-tight\">{t.rooms.h1}</h1>\n        <p className=\"mt-3 leading-relaxed text-muted\">{t.rooms.intro}</p>\n      </div>\n\n      <section className=\"mt-8\">\n        <SectionHeader\n          title={t.rooms.liveTitle}\n          subtitle={enabled ? fmt(t.rooms.liveCount, { n: String(rooms.length) }) : undefined}\n          icon=\"👥\"\n          actions={\n            enabled ? (\n              <span className=\"inline-flex items-center gap-1.5 text-xs text-muted\">\n                <span className=\"h-2 w-2 animate-pulse rounded-full bg-online\" />\n                {t.rooms.autoRefresh}\n              </span>\n            ) : undefined\n          }\n        />\n\n        {!enabled ? (\n          <div className=\"rounded-2xl border border-line bg-surface p-6 text-sm text-muted\">\n            <p className=\"font-semibold text-fg\">{t.rooms.disabledTitle}</p>\n            <p className=\"mt-1 leading-relaxed\">{t.rooms.disabledBody}</p>\n          </div>\n        ) : rooms.length === 0 ? (\n          <div className=\"rounded-2xl border border-dashed border-line-strong bg-surface p-8 text-center\">\n            <p className=\"text-3xl\" aria-hidden>\n              🕹️\n            </p>\n            <p className=\"mt-2 font-semibold\">{t.rooms.emptyTitle}</p>\n            <p className=\"mt-1 text-sm text-muted\">{t.rooms.emptyBody}</p>\n          </div>\n        ) : (\n          <ul className=\"grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4\">\n            {rooms.map((room) => (\n              <li key={room.roomId}>\n                <RoomCard room={room} />\n              </li>\n            ))}\n          </ul>\n        )}\n      </section>\n\n      {suggestions.length > 0 && (\n        <section className=\"mt-10\">\n          <SectionHeader title={t.rooms.startTitle} subtitle={t.rooms.startSubtitle} icon=\"🎮\" moreTo=\"/games?multiplayer=1\" />\n          <div className=\"grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-6\">\n            {suggestions.map((g) => (\n              <GameCard key={g.slug} game={g} showCoin={false} />\n            ))}\n          </div>\n        </section>\n      )}\n    </div>\n  )\n}\n",
 "src/components/game/RoomCard.tsx": "import { Link } from 'react-router-dom'\nimport { getGame } from '@/services/games'\nimport { platformMap } from '@/data/platforms'\nimport { useLang } from '@/services/lang'\nimport { useT, fmt } from '@/services/i18n'\nimport { gameTitle, platformLabel } from '@/services/i18nData'\nimport type { Room } from '@/services/rooms'\nimport { GameCover } from './GameCover'\nimport { Badge } from '@/components/ui/Badge'\nimport { cx } from '@/lib/format'\n\n/** 房间卡片：封面 = 正在玩的游戏，下面是 host 与人数 */\nexport function RoomCard({ room, compact = false }: { room: Room; compact?: boolean }) {\n  const t = useT()\n  const lang = useLang()\n  const game = getGame(room.gameSlug)\n  const max = game?.players ?? 2\n  const full = room.players >= max\n  const to = `/games/${room.gameSlug}?room=${encodeURIComponent(room.roomId)}`\n\n  if (compact) {\n    return (\n      <Link to={to} className=\"flex items-center gap-2.5 rounded-lg px-2 py-1.5 transition hover:bg-black/5\" title={game ? gameTitle(game, lang) : room.gameSlug}>\n        <span className=\"w-14 shrink-0 overflow-hidden rounded-md\">\n          {game ? <GameCover game={game} ratio=\"landscape\" showTitle={false} showBadge={false} iconSize=\"sm\" /> : <span className=\"block aspect-[4/3] bg-surface-3\" />}\n        </span>\n        <span className=\"min-w-0 flex-1\">\n          <span className=\"block truncate text-xs font-semibold\">{game ? gameTitle(game, lang) : room.gameSlug}</span>\n          <span className=\"block truncate text-[11px] text-muted\">\n            👑 {room.host?.nickname ?? '—'}\n          </span>\n        </span>\n        <span className={cx('shrink-0 text-[11px] font-semibold', full ? 'text-dim' : 'text-online')}>\n          {room.players}/{max}\n        </span>\n      </Link>\n    )\n  }\n\n  return (\n    <Link\n      to={to}\n      className=\"group card-hover block overflow-hidden rounded-card border border-line bg-surface hover:border-brand/60\"\n    >\n      <div className=\"relative\">\n        {game ? (\n          <GameCover game={game} ratio=\"landscape\" showTitle={false} />\n        ) : (\n          <div className=\"grid aspect-[4/3] place-items-center bg-surface-3 text-4xl\">🎮</div>\n        )}\n        <Badge tone={full ? 'dark' : 'online'} className=\"absolute bottom-2 right-2\">\n          👥 {room.players}/{max}\n        </Badge>\n        <span className=\"absolute left-2 top-2 inline-flex items-center gap-1 rounded bg-black/60 px-1.5 py-1 text-[10px] font-semibold text-white backdrop-blur\">\n          <span className={cx('h-1.5 w-1.5 rounded-full', full ? 'bg-dim' : 'animate-pulse bg-online')} />\n          {full ? t.rooms.full : t.rooms.open}\n        </span>\n      </div>\n      <div className=\"space-y-1.5 p-3\">\n        <h3 className=\"truncate text-sm font-semibold leading-tight\">{game ? gameTitle(game, lang) : room.gameSlug}</h3>\n        <div className=\"flex items-center justify-between gap-2 text-[11px] text-muted\">\n          <span className=\"truncate\">\n            👑 {fmt(t.rooms.hostLabel, { name: room.host?.nickname ?? '—' })}\n          </span>\n          {game && <span className=\"shrink-0\">{platformLabel(t, game.platform, platformMap[game.platform]?.name ?? game.platform)}</span>}\n        </div>\n        <div className=\"flex flex-wrap gap-1\">\n          {Array.from({ length: max }, (_, i) => {\n            const m = room.members.find((x) => x.playerIndex === i)\n            return (\n              <span\n                key={i}\n                className={cx(\n                  'rounded px-1.5 py-0.5 text-[10px] font-semibold',\n                  m ? 'bg-brand-soft text-brand-hover' : 'border border-dashed border-line-strong text-dim',\n                )}\n                title={m?.nickname}\n              >\n                {i + 1}P {m ? `· ${m.nickname}` : `· ${t.rooms.slotFree}`}\n              </span>\n            )\n          })}\n        </div>\n      </div>\n    </Link>\n  )\n}\n",
 "server/src/routes/rooms.js": "import { Router } from 'express'\nimport { optionalUser } from '../auth.js'\n\n/**\n * 联机房间注册表（内存版）。\n *\n * cloud-game 本身不对外暴露「有哪些房间」，所以前端在联机时定期向这里心跳，\n * 侧边栏「联机玩」就从这里读房间列表。\n *\n *   POST   /api/rooms/heartbeat   { roomId, gameSlug, memberId, nickname, playerIndex, host }\n *   DELETE /api/rooms/:roomId/members/:memberId   离开\n *   GET    /api/rooms             在线房间列表\n *\n * 成员超过 MEMBER_TTL 没心跳视为掉线；房间没有成员即消失。\n * 只在内存里，重启后清空（房间本来就是临时的）。多实例部署时请改成 Redis。\n */\nexport const roomsRouter = Router()\n\nconst MEMBER_TTL = 30_000\nconst rooms = new Map() // roomId -> { roomId, gameSlug, createdAt, members: Map<memberId, member> }\n\nfunction prune(now = Date.now()) {\n  for (const [id, room] of rooms) {\n    for (const [mid, m] of room.members) {\n      if (now - m.seenAt > MEMBER_TTL) room.members.delete(mid)\n    }\n    if (room.members.size === 0) rooms.delete(id)\n  }\n}\nsetInterval(prune, 10_000).unref()\n\nfunction publicRoom(room) {\n  const members = [...room.members.values()].sort((a, b) => a.playerIndex - b.playerIndex)\n  const host = members.find((m) => m.host) ?? members[0]\n  return {\n    roomId: room.roomId,\n    gameSlug: room.gameSlug,\n    createdAt: room.createdAt,\n    host: host ? { nickname: host.nickname, userId: host.userId } : null,\n    players: members.length,\n    playerIndexes: members.map((m) => m.playerIndex),\n    members: members.map((m) => ({ nickname: m.nickname, playerIndex: m.playerIndex, host: Boolean(m.host) })),\n  }\n}\n\nconst str = (v, max = 120) => (typeof v === 'string' ? v.trim().slice(0, max) : '')\n\nroomsRouter.get('/', (_req, res) => {\n  prune()\n  const list = [...rooms.values()].map(publicRoom).sort((a, b) => b.createdAt - a.createdAt)\n  res.json(list)\n})\n\nroomsRouter.get('/:roomId', (req, res) => {\n  prune()\n  const room = rooms.get(req.params.roomId)\n  if (!room) return res.status(404).json({ error: 'room not found' })\n  res.json(publicRoom(room))\n})\n\nroomsRouter.post('/heartbeat', optionalUser, (req, res) => {\n  const roomId = str(req.body.roomId, 200)\n  const gameSlug = str(req.body.gameSlug)\n  const memberId = str(req.body.memberId, 64)\n  if (!roomId || !gameSlug || !memberId) return res.status(400).json({ error: 'roomId, gameSlug, memberId required' })\n\n  const playerIndex = Math.max(0, Math.min(3, Number(req.body.playerIndex) || 0))\n  const nickname = str(req.body.nickname, 32) || (req.user?.nickname ?? 'Guest')\n  const now = Date.now()\n\n  let room = rooms.get(roomId)\n  if (!room) {\n    room = { roomId, gameSlug, createdAt: now, members: new Map() }\n    rooms.set(roomId, room)\n  }\n  const existing = room.members.get(memberId)\n  // 第一个进来的就是 host；后来者即使自称 host 也不算\n  const host = existing ? existing.host : room.members.size === 0 || Boolean(req.body.host && ![...room.members.values()].some((m) => m.host))\n  room.members.set(memberId, { memberId, nickname, playerIndex, host, userId: req.user?.id ?? null, seenAt: now })\n  res.json(publicRoom(room))\n})\n\nroomsRouter.delete('/:roomId/members/:memberId', (req, res) => {\n  const room = rooms.get(req.params.roomId)\n  if (room) {\n    room.members.delete(req.params.memberId)\n    if (room.members.size === 0) rooms.delete(room.roomId)\n  }\n  res.json({ ok: true })\n})\n"
}

PATCHES = [{'file': 'src/components/layout/nav.ts', 'pairs': [["    { label: t.nav.playOnline, to: '/games?multiplayer=1', icon: '👥', exact: true, disabled: true, badge: 'coming soon' },", "    { label: t.nav.playOnline, to: '/rooms', icon: '👥', exact: true },"]], 'must': True}, {'file': 'src/components/layout/Sidebar.tsx', 'pairs': [["import { FEATURES } from '@/config/features'\n", "import { FEATURES } from '@/config/features'\nimport { useRooms } from '@/services/rooms'\nimport { RoomCard } from '@/components/game/RoomCard'\n"], ['          <NavGroup title={t.sidebar.groupNav} collapsed={collapsed}>\n            {mainNavFor(t).map((item) => (\n              <NavItem key={item.to} item={item} collapsed={collapsed} />\n            ))}\n          </NavGroup>\n', "          <NavGroup title={t.sidebar.groupNav} collapsed={collapsed}>\n            {mainNavFor(t).map((item) => (\n              <NavItem key={item.to} item={item} collapsed={collapsed} trailing={item.to === '/rooms' ? <RoomCount /> : undefined} />\n            ))}\n          </NavGroup>\n\n          <RoomsBox collapsed={collapsed} />\n"], ['/** 随机跳转到一款可在线运行的游戏 */', '/** 「联机玩」右侧的在线房间数 */\nfunction RoomCount() {\n  const rooms = useRooms()\n  if (rooms.length === 0) return null\n  return (\n    <span className="inline-flex items-center gap-1 rounded bg-online/15 px-1.5 py-0.5 text-[10px] font-bold text-online">\n      <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-online" />\n      {rooms.length}\n    </span>\n  )\n}\n\n/** 联机玩：正在进行的房间（最多 5 个），封面 = 正在玩的游戏，显示房主与人数 */\nfunction RoomsBox({ collapsed }: { collapsed: boolean }) {\n  const t = useT()\n  const rooms = useRooms()\n  const { setMobileOpen } = useShell()\n  if (rooms.length === 0) return null\n  return (\n    <div className={cx(\'mb-3\', collapsed && \'lg:hidden\')} onClick={() => setMobileOpen(false)}>\n      <p className="text-pixel mb-1.5 px-3 text-[10px] uppercase tracking-wider text-dim">{t.rooms.sidebarTitle}</p>\n      <ul className="space-y-0.5">\n        {rooms.slice(0, 5).map((room) => (\n          <li key={room.roomId}>\n            <RoomCard room={room} compact />\n          </li>\n        ))}\n      </ul>\n      {rooms.length > 5 && (\n        <Link to="/rooms" className="mt-1 block px-3 text-[11px] text-muted hover:text-fg">\n          {t.rooms.sidebarMore} →\n        </Link>\n      )}\n    </div>\n  )\n}\n\n/** 随机跳转到一款可在线运行的游戏 */']], 'must': True}, {'file': 'src/AppRoutes.tsx', 'pairs': [["import { PlayLocalPage } from '@/pages/PlayLocalPage'\n", "import { PlayLocalPage } from '@/pages/PlayLocalPage'\nimport { RoomsPage } from '@/pages/RoomsPage'\n"], ['          <Route path="/play-local" element={<PlayLocalPage />} />\n', '          <Route path="/play-local" element={<PlayLocalPage />} />\n          <Route path="/rooms" element={<RoomsPage />} />\n']], 'must': True}, {'file': 'src/pages/GameDetailPage.tsx', 'pairs': [["import { Link, useParams } from 'react-router-dom'", "import { Link, useParams, useSearchParams } from 'react-router-dom'"], ["  const { slug = '' } = useParams<{ slug: string }>()\n", "  const { slug = '' } = useParams<{ slug: string }>()\n  const [searchParams] = useSearchParams()\n  const joinRoomId = searchParams.get('room') ?? undefined\n"], ['              gameName={game.title}\n              icon={game.icon}\n', '              gameName={game.title}\n              gameSlug={game.slug}\n              maxPlayers={game.players}\n              joinRoomId={joinRoomId}\n              icon={game.icon}\n']], 'must': True}, {'file': 'server/src/index.js', 'pairs': [["import { adminRouter } from './routes/admin.js'\n", "import { adminRouter } from './routes/admin.js'\nimport { roomsRouter } from './routes/rooms.js'\n"], ["app.use('/api/admin', adminRouter)\n", "app.use('/api/admin', adminRouter)\napp.use('/api/rooms', roomsRouter)\n"]], 'must': True}, {'file': 'src/vite-env.d.ts', 'pairs': [['  readonly VITE_J2ME_PATH?: string\n', '  readonly VITE_J2ME_PATH?: string\n  readonly VITE_CLOUDGAME_URL?: string\n  readonly VITE_CLOUDGAME_ZONE?: string\n  readonly VITE_API_URL?: string\n']], 'must': True}, {'file': '.env.example', 'pairs': [['VITE_J2ME_PATH=\n', 'VITE_J2ME_PATH=\n# 远程联机：cloud-game coordinator 地址（http(s)://…，本地 docker 为 http://localhost:8000）。留空则没有联机入口\nVITE_CLOUDGAME_URL=\n# 可选：cloud-game 的 worker 区域（ISO 国家码），多区域部署时用\nVITE_CLOUDGAME_ZONE=\n']], 'must': False}, {'file': 'src/emulator/README.md', 'pairs': [['    └── j2me.ts           Java 手机游戏 (.jar)，需自托管\n', '    ├── j2me.ts           Java 手机游戏 (.jar)，需自托管\n    └── cloudgame.ts      远程联机：游戏跑在 cloud-game 服务器上，WebRTC 推流\n'], ['| J2ME | Java `.jar` | 取决于你选的实现 | **需自托管**，见下 |\n', '| J2ME | Java `.jar` | 取决于你选的实现 | **需自托管**，见下 |\n| Cloud | 远程联机（NES / SNES / GBA / GB / N64 / PS1 / 街机 / DOS / MD） | Apache-2.0 | **需自托管** cloud-game，见 `deploy/cloudgame/` |\n'], ['## J2ME（Java 手机游戏）\n', '## 远程联机（cloudgame）\n\n游戏不在浏览器里跑，而是在 [cloud-game](https://github.com/giongto35/cloud-game) 服务器上由 libretro 核心运行，\n画面 / 声音经 WebRTC 推回来，手柄输入经 DataChannel 发过去。同一房间的人看同一路流、各控各的手柄位。\n\n- 它**不参与**「按格式选引擎」：用户在播放器里切到「联机模式」时才用（详情页在联机可用时默认联机）。\n- 开始游戏即自动创建房间，房间通过本站后端 `/api/rooms` 心跳登记，出现在侧边栏「联机玩」；\n  朋友打开 `/games/<slug>?room=<id>` 即可加入并自动分到空闲手柄位。\n- 服务器只能跑它自己文件系统里的 ROM（文件名 = `<slug>.<ext>`），不能上传本地文件；\n  `deploy/cloudgame/sync-roms.sh` 负责把 R2 里的 ROM 同步过去。\n- 启用：`.env` 设 `VITE_CLOUDGAME_URL`（coordinator 地址）和 `VITE_API_URL`（房间列表）。部署见 `deploy/cloudgame/README.md`。\n\n## J2ME（Java 手机游戏）\n']], 'must': True}]

I18N = {
 "zh-Hans": {
  "rooms": {
   "title": "联机玩 · 房间列表",
   "seo": "和朋友远程联机玩经典游戏：加入正在进行的房间，或自己开一局。",
   "h1": "联机玩",
   "intro": "游戏在云端运行，每个正在联机的玩家自动拥有一个房间。挑一个房间加入，选好手柄位就能一起玩；也可以自己开一局等朋友来。",
   "liveTitle": "正在进行的房间",
   "liveCount": "{n} 个房间在线",
   "autoRefresh": "自动刷新",
   "disabledTitle": "联机功能尚未开启",
   "disabledBody": "需要部署 cloud-game 服务器并在 .env 里配置 VITE_CLOUDGAME_URL 与 VITE_API_URL，房间列表才会出现。",
   "emptyTitle": "现在没有房间",
   "emptyBody": "挑一款支持联机的游戏，点「开始游戏」就会自动创建房间。",
   "startTitle": "开一局",
   "startSubtitle": "这些游戏支持远程联机",
   "full": "已满",
   "open": "可加入",
   "hostLabel": "房主 {name}",
   "slotFree": "空位",
   "sidebarTitle": "联机玩",
   "sidebarMore": "查看全部房间"
  },
  "player": {
   "onlineStart": "开始游戏 · 自动创建房间",
   "onlineHint": "游戏在云端运行，开始后自动创建房间（最多 {max} 人），朋友打开邀请链接即可加入。",
   "localInstead": "本地运行",
   "localInsteadHint": "（由 {runtime} 在浏览器内运行，不联机）",
   "onlineInstead": "切换到联机模式",
   "joinRoom": "加入房间",
   "joinHint": "{host} 的房间 · {players}/{max} 人 · 你将使用 {slot}P 手柄",
   "joinHintNoList": "点击加入该房间，进入后选择手柄位。",
   "roomLookup": "正在查询房间…",
   "roomGone": "这个房间已经关闭了，你可以自己开一局。",
   "roomFull": "房间已满",
   "createOwnRoom": "自己开一局",
   "roomBadge": "房间 {players}/{max}",
   "slotLabel": "{n}P",
   "copyInvite": "复制邀请链接",
   "copied": "已复制",
   "leaveRoom": "⏏ 离开房间",
   "cloudState": {
    "connecting": "正在连接联机服务器…",
    "negotiating": "正在建立视频通道…",
    "starting": "正在启动游戏…",
    "playing": "联机中",
    "disconnected": "连接已断开",
    "no-slots": "服务器没有空闲位置"
   }
  },
  "runtime": {
   "cloudDesc": "远程联机：游戏在 cloud-game 服务器上运行，画面经 WebRTC 推送到浏览器",
   "cloudNotConfigured": "尚未配置联机服务器（VITE_CLOUDGAME_URL）",
   "cloudNoSession": "缺少联机会话参数",
   "cloudDisconnected": "与联机服务器的连接已断开",
   "cloudWebrtcFailed": "建立视频通道失败：{msg}",
   "cloudConnectFailed": "无法连接联机服务器：{msg}",
   "cloudNoSlots": "联机服务器暂时没有空闲位置，请稍后再试",
   "cloudTimeout": "联机服务器长时间没有响应，请稍后重试",
   "cloudProtocolError": "联机通信出错：{msg}"
  }
 },
 "zh-Hant": {
  "rooms": {
   "title": "連線玩 · 房間列表",
   "seo": "和朋友遠端連線玩經典遊戲：加入進行中的房間，或自己開一局。",
   "h1": "連線玩",
   "intro": "遊戲在雲端執行，每個正在連線的玩家自動擁有一個房間。挑一個房間加入，選好手把位就能一起玩；也可以自己開一局等朋友來。",
   "liveTitle": "進行中的房間",
   "liveCount": "{n} 個房間線上",
   "autoRefresh": "自動重新整理",
   "disabledTitle": "連線功能尚未開啟",
   "disabledBody": "需要部署 cloud-game 伺服器並在 .env 裡設定 VITE_CLOUDGAME_URL 與 VITE_API_URL，房間列表才會出現。",
   "emptyTitle": "現在沒有房間",
   "emptyBody": "挑一款支援連線的遊戲，點「開始遊戲」就會自動建立房間。",
   "startTitle": "開一局",
   "startSubtitle": "這些遊戲支援遠端連線",
   "full": "已滿",
   "open": "可加入",
   "hostLabel": "房主 {name}",
   "slotFree": "空位",
   "sidebarTitle": "連線玩",
   "sidebarMore": "查看全部房間"
  },
  "player": {
   "onlineStart": "開始遊戲 · 自動建立房間",
   "onlineHint": "遊戲在雲端執行，開始後自動建立房間（最多 {max} 人），朋友打開邀請連結即可加入。",
   "localInstead": "本機執行",
   "localInsteadHint": "（由 {runtime} 在瀏覽器內執行，不連線）",
   "onlineInstead": "切換到連線模式",
   "joinRoom": "加入房間",
   "joinHint": "{host} 的房間 · {players}/{max} 人 · 你將使用 {slot}P 手把",
   "joinHintNoList": "點擊加入該房間，進入後選擇手把位。",
   "roomLookup": "正在查詢房間…",
   "roomGone": "這個房間已經關閉了，你可以自己開一局。",
   "roomFull": "房間已滿",
   "createOwnRoom": "自己開一局",
   "roomBadge": "房間 {players}/{max}",
   "slotLabel": "{n}P",
   "copyInvite": "複製邀請連結",
   "copied": "已複製",
   "leaveRoom": "⏏ 離開房間",
   "cloudState": {
    "connecting": "正在連線伺服器…",
    "negotiating": "正在建立視訊通道…",
    "starting": "正在啟動遊戲…",
    "playing": "連線中",
    "disconnected": "連線已中斷",
    "no-slots": "伺服器沒有空閒位置"
   }
  },
  "runtime": {
   "cloudDesc": "遠端連線：遊戲在 cloud-game 伺服器上執行，畫面經 WebRTC 推送到瀏覽器",
   "cloudNotConfigured": "尚未設定連線伺服器（VITE_CLOUDGAME_URL）",
   "cloudNoSession": "缺少連線工作階段參數",
   "cloudDisconnected": "與連線伺服器的連線已中斷",
   "cloudWebrtcFailed": "建立視訊通道失敗：{msg}",
   "cloudConnectFailed": "無法連線伺服器：{msg}",
   "cloudNoSlots": "伺服器暫時沒有空閒位置，請稍後再試",
   "cloudTimeout": "連線伺服器長時間沒有回應，請稍後重試",
   "cloudProtocolError": "連線通訊出錯：{msg}"
  }
 },
 "en": {
  "rooms": {
   "title": "Multiplayer · Rooms",
   "seo": "Play retro classics online with friends: join a live room or start your own.",
   "h1": "Multiplayer",
   "intro": "Games run in the cloud, and every player who is online automatically has a room. Pick a room, grab a free controller slot and play together — or start your own and wait for friends.",
   "liveTitle": "Live rooms",
   "liveCount": "{n} rooms online",
   "autoRefresh": "auto refresh",
   "disabledTitle": "Multiplayer is not enabled yet",
   "disabledBody": "Deploy the cloud-game server and set VITE_CLOUDGAME_URL and VITE_API_URL in .env to enable the room list.",
   "emptyTitle": "No rooms right now",
   "emptyBody": "Pick a multiplayer game and press \"Start\" — a room is created automatically.",
   "startTitle": "Start a room",
   "startSubtitle": "These games support online multiplayer",
   "full": "Full",
   "open": "Open",
   "hostLabel": "Host {name}",
   "slotFree": "free",
   "sidebarTitle": "Multiplayer",
   "sidebarMore": "All rooms"
  },
  "player": {
   "onlineStart": "Start · create a room",
   "onlineHint": "The game runs in the cloud. Starting creates a room (up to {max} players) — friends join through the invite link.",
   "localInstead": "Play locally",
   "localInsteadHint": "(runs in your browser via {runtime}, no multiplayer)",
   "onlineInstead": "Switch to multiplayer",
   "joinRoom": "Join room",
   "joinHint": "{host}'s room · {players}/{max} players · you will be player {slot}",
   "joinHintNoList": "Click to join this room and pick a controller slot.",
   "roomLookup": "Looking up the room…",
   "roomGone": "This room has closed — you can start your own.",
   "roomFull": "Room is full",
   "createOwnRoom": "Start my own room",
   "roomBadge": "Room {players}/{max}",
   "slotLabel": "{n}P",
   "copyInvite": "Copy invite link",
   "copied": "Copied",
   "leaveRoom": "⏏ Leave room",
   "cloudState": {
    "connecting": "Connecting to the multiplayer server…",
    "negotiating": "Setting up the video stream…",
    "starting": "Starting the game…",
    "playing": "Online",
    "disconnected": "Connection lost",
    "no-slots": "No free slots on the server"
   }
  },
  "runtime": {
   "cloudDesc": "Online multiplayer: the game runs on a cloud-game server and streams to your browser over WebRTC",
   "cloudNotConfigured": "Multiplayer server not configured (VITE_CLOUDGAME_URL)",
   "cloudNoSession": "Missing multiplayer session parameters",
   "cloudDisconnected": "Connection to the multiplayer server was lost",
   "cloudWebrtcFailed": "Could not set up the video stream: {msg}",
   "cloudConnectFailed": "Could not reach the multiplayer server: {msg}",
   "cloudNoSlots": "The multiplayer server has no free slots right now, please try again later",
   "cloudTimeout": "The multiplayer server did not respond in time, please try again",
   "cloudProtocolError": "Multiplayer communication error: {msg}"
  }
 },
 "es": {
  "rooms": {
   "title": "Multijugador · Salas",
   "seo": "Juega clásicos retro online con amigos: únete a una sala activa o crea la tuya.",
   "h1": "Multijugador",
   "intro": "Los juegos se ejecutan en la nube y cada jugador conectado tiene automáticamente una sala. Elige una sala, ocupa un mando libre y jugad juntos, o crea la tuya y espera a tus amigos.",
   "liveTitle": "Salas activas",
   "liveCount": "{n} salas online",
   "autoRefresh": "actualización automática",
   "disabledTitle": "El multijugador aún no está activado",
   "disabledBody": "Despliega el servidor cloud-game y define VITE_CLOUDGAME_URL y VITE_API_URL en .env para activar la lista de salas.",
   "emptyTitle": "No hay salas ahora mismo",
   "emptyBody": "Elige un juego multijugador y pulsa «Empezar»: la sala se crea sola.",
   "startTitle": "Crear una sala",
   "startSubtitle": "Estos juegos admiten multijugador online",
   "full": "Llena",
   "open": "Abierta",
   "hostLabel": "Anfitrión {name}",
   "slotFree": "libre",
   "sidebarTitle": "Multijugador",
   "sidebarMore": "Todas las salas"
  },
  "player": {
   "onlineStart": "Empezar · crear sala",
   "onlineHint": "El juego se ejecuta en la nube. Al empezar se crea una sala (hasta {max} jugadores) y tus amigos entran con el enlace de invitación.",
   "localInstead": "Jugar en local",
   "localInsteadHint": "(se ejecuta en tu navegador con {runtime}, sin multijugador)",
   "onlineInstead": "Cambiar a multijugador",
   "joinRoom": "Unirse a la sala",
   "joinHint": "Sala de {host} · {players}/{max} jugadores · serás el jugador {slot}",
   "joinHintNoList": "Haz clic para unirte a esta sala y elegir un mando.",
   "roomLookup": "Buscando la sala…",
   "roomGone": "Esta sala se ha cerrado; puedes crear la tuya.",
   "roomFull": "Sala llena",
   "createOwnRoom": "Crear mi propia sala",
   "roomBadge": "Sala {players}/{max}",
   "slotLabel": "{n}P",
   "copyInvite": "Copiar enlace de invitación",
   "copied": "Copiado",
   "leaveRoom": "⏏ Salir de la sala",
   "cloudState": {
    "connecting": "Conectando con el servidor…",
    "negotiating": "Preparando el vídeo…",
    "starting": "Iniciando el juego…",
    "playing": "En línea",
    "disconnected": "Conexión perdida",
    "no-slots": "No hay plazas libres en el servidor"
   }
  },
  "runtime": {
   "cloudDesc": "Multijugador online: el juego se ejecuta en un servidor cloud-game y se transmite al navegador por WebRTC",
   "cloudNotConfigured": "Servidor multijugador no configurado (VITE_CLOUDGAME_URL)",
   "cloudNoSession": "Faltan los parámetros de la sesión multijugador",
   "cloudDisconnected": "Se perdió la conexión con el servidor multijugador",
   "cloudWebrtcFailed": "No se pudo establecer el vídeo: {msg}",
   "cloudConnectFailed": "No se pudo conectar con el servidor multijugador: {msg}",
   "cloudNoSlots": "El servidor multijugador no tiene plazas libres ahora mismo, inténtalo más tarde",
   "cloudTimeout": "El servidor multijugador no respondió a tiempo, inténtalo de nuevo",
   "cloudProtocolError": "Error de comunicación multijugador: {msg}"
  }
 },
 "fr": {
  "rooms": {
   "title": "Multijoueur · Salons",
   "seo": "Jouez aux classiques rétro en ligne avec vos amis : rejoignez un salon ouvert ou créez le vôtre.",
   "h1": "Multijoueur",
   "intro": "Les jeux tournent dans le cloud et chaque joueur connecté possède automatiquement un salon. Choisissez un salon, prenez une manette libre et jouez ensemble, ou créez le vôtre en attendant vos amis.",
   "liveTitle": "Salons en cours",
   "liveCount": "{n} salons en ligne",
   "autoRefresh": "actualisation auto",
   "disabledTitle": "Le multijoueur n’est pas encore activé",
   "disabledBody": "Déployez le serveur cloud-game et définissez VITE_CLOUDGAME_URL et VITE_API_URL dans .env pour activer la liste des salons.",
   "emptyTitle": "Aucun salon pour le moment",
   "emptyBody": "Choisissez un jeu multijoueur et cliquez sur « Démarrer » : le salon est créé automatiquement.",
   "startTitle": "Créer un salon",
   "startSubtitle": "Ces jeux prennent en charge le multijoueur en ligne",
   "full": "Complet",
   "open": "Ouvert",
   "hostLabel": "Hôte {name}",
   "slotFree": "libre",
   "sidebarTitle": "Multijoueur",
   "sidebarMore": "Tous les salons"
  },
  "player": {
   "onlineStart": "Démarrer · créer un salon",
   "onlineHint": "Le jeu tourne dans le cloud. Le démarrage crée un salon (jusqu’à {max} joueurs) et vos amis le rejoignent via le lien d’invitation.",
   "localInstead": "Jouer en local",
   "localInsteadHint": "(dans votre navigateur via {runtime}, sans multijoueur)",
   "onlineInstead": "Passer en multijoueur",
   "joinRoom": "Rejoindre le salon",
   "joinHint": "Salon de {host} · {players}/{max} joueurs · vous serez le joueur {slot}",
   "joinHintNoList": "Cliquez pour rejoindre ce salon et choisir une manette.",
   "roomLookup": "Recherche du salon…",
   "roomGone": "Ce salon est fermé ; vous pouvez créer le vôtre.",
   "roomFull": "Salon complet",
   "createOwnRoom": "Créer mon propre salon",
   "roomBadge": "Salon {players}/{max}",
   "slotLabel": "{n}P",
   "copyInvite": "Copier le lien d’invitation",
   "copied": "Copié",
   "leaveRoom": "⏏ Quitter le salon",
   "cloudState": {
    "connecting": "Connexion au serveur…",
    "negotiating": "Préparation du flux vidéo…",
    "starting": "Lancement du jeu…",
    "playing": "En ligne",
    "disconnected": "Connexion perdue",
    "no-slots": "Aucune place libre sur le serveur"
   }
  },
  "runtime": {
   "cloudDesc": "Multijoueur en ligne : le jeu tourne sur un serveur cloud-game et est diffusé vers le navigateur en WebRTC",
   "cloudNotConfigured": "Serveur multijoueur non configuré (VITE_CLOUDGAME_URL)",
   "cloudNoSession": "Paramètres de session multijoueur manquants",
   "cloudDisconnected": "Connexion au serveur multijoueur perdue",
   "cloudWebrtcFailed": "Impossible d’établir le flux vidéo : {msg}",
   "cloudConnectFailed": "Impossible de joindre le serveur multijoueur : {msg}",
   "cloudNoSlots": "Le serveur multijoueur n’a aucune place libre pour l’instant, réessayez plus tard",
   "cloudTimeout": "Le serveur multijoueur n’a pas répondu à temps, réessayez",
   "cloudProtocolError": "Erreur de communication multijoueur : {msg}"
  }
 },
 "it": {
  "rooms": {
   "title": "Multigiocatore · Stanze",
   "seo": "Gioca ai classici retro online con gli amici: entra in una stanza attiva o creane una tua.",
   "h1": "Multigiocatore",
   "intro": "I giochi girano nel cloud e ogni giocatore connesso ha automaticamente una stanza. Scegli una stanza, prendi un controller libero e giocate insieme, oppure creane una tua e aspetta gli amici.",
   "liveTitle": "Stanze attive",
   "liveCount": "{n} stanze online",
   "autoRefresh": "aggiornamento automatico",
   "disabledTitle": "Il multigiocatore non è ancora attivo",
   "disabledBody": "Distribuisci il server cloud-game e imposta VITE_CLOUDGAME_URL e VITE_API_URL in .env per attivare l’elenco delle stanze.",
   "emptyTitle": "Nessuna stanza al momento",
   "emptyBody": "Scegli un gioco multigiocatore e premi «Inizia»: la stanza viene creata da sola.",
   "startTitle": "Crea una stanza",
   "startSubtitle": "Questi giochi supportano il multigiocatore online",
   "full": "Piena",
   "open": "Aperta",
   "hostLabel": "Host {name}",
   "slotFree": "libero",
   "sidebarTitle": "Multigiocatore",
   "sidebarMore": "Tutte le stanze"
  },
  "player": {
   "onlineStart": "Inizia · crea una stanza",
   "onlineHint": "Il gioco gira nel cloud. All’avvio viene creata una stanza (fino a {max} giocatori) e gli amici entrano con il link di invito.",
   "localInstead": "Gioca in locale",
   "localInsteadHint": "(nel tuo browser con {runtime}, senza multigiocatore)",
   "onlineInstead": "Passa al multigiocatore",
   "joinRoom": "Entra nella stanza",
   "joinHint": "Stanza di {host} · {players}/{max} giocatori · sarai il giocatore {slot}",
   "joinHintNoList": "Clicca per entrare in questa stanza e scegliere un controller.",
   "roomLookup": "Ricerca della stanza…",
   "roomGone": "Questa stanza è chiusa: puoi crearne una tua.",
   "roomFull": "Stanza piena",
   "createOwnRoom": "Crea la mia stanza",
   "roomBadge": "Stanza {players}/{max}",
   "slotLabel": "{n}P",
   "copyInvite": "Copia link di invito",
   "copied": "Copiato",
   "leaveRoom": "⏏ Esci dalla stanza",
   "cloudState": {
    "connecting": "Connessione al server…",
    "negotiating": "Preparazione del video…",
    "starting": "Avvio del gioco…",
    "playing": "Online",
    "disconnected": "Connessione persa",
    "no-slots": "Nessun posto libero sul server"
   }
  },
  "runtime": {
   "cloudDesc": "Multigiocatore online: il gioco gira su un server cloud-game e viene trasmesso al browser via WebRTC",
   "cloudNotConfigured": "Server multigiocatore non configurato (VITE_CLOUDGAME_URL)",
   "cloudNoSession": "Parametri della sessione multigiocatore mancanti",
   "cloudDisconnected": "Connessione al server multigiocatore persa",
   "cloudWebrtcFailed": "Impossibile stabilire il flusso video: {msg}",
   "cloudConnectFailed": "Impossibile raggiungere il server multigiocatore: {msg}",
   "cloudNoSlots": "Il server multigiocatore non ha posti liberi al momento, riprova più tardi",
   "cloudTimeout": "Il server multigiocatore non ha risposto in tempo, riprova",
   "cloudProtocolError": "Errore di comunicazione multigiocatore: {msg}"
  }
 },
 "de": {
  "rooms": {
   "title": "Multiplayer · Räume",
   "seo": "Retro-Klassiker online mit Freunden spielen: einem offenen Raum beitreten oder selbst einen eröffnen.",
   "h1": "Multiplayer",
   "intro": "Die Spiele laufen in der Cloud, und jeder Spieler, der online ist, hat automatisch einen Raum. Wähle einen Raum, nimm dir einen freien Controller-Platz und spielt zusammen – oder eröffne selbst einen und warte auf Freunde.",
   "liveTitle": "Laufende Räume",
   "liveCount": "{n} Räume online",
   "autoRefresh": "automatisch aktualisiert",
   "disabledTitle": "Multiplayer ist noch nicht aktiviert",
   "disabledBody": "Stelle den cloud-game-Server bereit und setze VITE_CLOUDGAME_URL und VITE_API_URL in .env, damit die Raumliste erscheint.",
   "emptyTitle": "Gerade keine Räume",
   "emptyBody": "Wähle ein Multiplayer-Spiel und drücke „Starten“ – der Raum wird automatisch erstellt.",
   "startTitle": "Raum eröffnen",
   "startSubtitle": "Diese Spiele unterstützen Online-Multiplayer",
   "full": "Voll",
   "open": "Offen",
   "hostLabel": "Host {name}",
   "slotFree": "frei",
   "sidebarTitle": "Multiplayer",
   "sidebarMore": "Alle Räume"
  },
  "player": {
   "onlineStart": "Starten · Raum erstellen",
   "onlineHint": "Das Spiel läuft in der Cloud. Beim Start wird ein Raum erstellt (bis zu {max} Spieler) – Freunde treten über den Einladungslink bei.",
   "localInstead": "Lokal spielen",
   "localInsteadHint": "(läuft im Browser über {runtime}, ohne Multiplayer)",
   "onlineInstead": "Zu Multiplayer wechseln",
   "joinRoom": "Raum beitreten",
   "joinHint": "Raum von {host} · {players}/{max} Spieler · du bist Spieler {slot}",
   "joinHintNoList": "Klicke, um diesem Raum beizutreten und einen Controller-Platz zu wählen.",
   "roomLookup": "Raum wird gesucht…",
   "roomGone": "Dieser Raum wurde geschlossen – du kannst selbst einen eröffnen.",
   "roomFull": "Raum ist voll",
   "createOwnRoom": "Eigenen Raum eröffnen",
   "roomBadge": "Raum {players}/{max}",
   "slotLabel": "{n}P",
   "copyInvite": "Einladungslink kopieren",
   "copied": "Kopiert",
   "leaveRoom": "⏏ Raum verlassen",
   "cloudState": {
    "connecting": "Verbindung zum Server…",
    "negotiating": "Videostream wird eingerichtet…",
    "starting": "Spiel wird gestartet…",
    "playing": "Online",
    "disconnected": "Verbindung verloren",
    "no-slots": "Keine freien Plätze auf dem Server"
   }
  },
  "runtime": {
   "cloudDesc": "Online-Multiplayer: Das Spiel läuft auf einem cloud-game-Server und wird per WebRTC in den Browser gestreamt",
   "cloudNotConfigured": "Multiplayer-Server nicht konfiguriert (VITE_CLOUDGAME_URL)",
   "cloudNoSession": "Multiplayer-Sitzungsparameter fehlen",
   "cloudDisconnected": "Verbindung zum Multiplayer-Server verloren",
   "cloudWebrtcFailed": "Videostream konnte nicht aufgebaut werden: {msg}",
   "cloudConnectFailed": "Multiplayer-Server nicht erreichbar: {msg}",
   "cloudNoSlots": "Der Multiplayer-Server hat gerade keine freien Plätze, bitte später erneut versuchen",
   "cloudTimeout": "Der Multiplayer-Server hat nicht rechtzeitig geantwortet, bitte erneut versuchen",
   "cloudProtocolError": "Multiplayer-Kommunikationsfehler: {msg}"
  }
 },
 "ja": {
  "rooms": {
   "title": "オンライン対戦 · ルーム一覧",
   "seo": "友達とレトロゲームをオンラインで一緒にプレイ。進行中のルームに参加するか、自分でルームを作ろう。",
   "h1": "オンライン対戦",
   "intro": "ゲームはクラウドで動き、オンライン中のプレイヤーは自動的に自分のルームを持ちます。ルームを選んで空いているコントローラー枠に入れば一緒に遊べます。自分でルームを作って友達を待つこともできます。",
   "liveTitle": "進行中のルーム",
   "liveCount": "{n} ルームがオンライン",
   "autoRefresh": "自動更新",
   "disabledTitle": "オンライン対戦はまだ有効になっていません",
   "disabledBody": "cloud-game サーバーを配置し、.env に VITE_CLOUDGAME_URL と VITE_API_URL を設定するとルーム一覧が表示されます。",
   "emptyTitle": "現在ルームはありません",
   "emptyBody": "マルチプレイ対応のゲームを選んで「スタート」を押すと、ルームが自動的に作られます。",
   "startTitle": "ルームを作る",
   "startSubtitle": "これらのゲームはオンライン対戦に対応しています",
   "full": "満員",
   "open": "参加可能",
   "hostLabel": "ホスト {name}",
   "slotFree": "空き",
   "sidebarTitle": "オンライン対戦",
   "sidebarMore": "すべてのルーム"
  },
  "player": {
   "onlineStart": "スタート · ルームを作成",
   "onlineHint": "ゲームはクラウドで動作します。スタートするとルーム（最大 {max} 人）が作られ、友達は招待リンクから参加できます。",
   "localInstead": "ローカルで遊ぶ",
   "localInsteadHint": "（{runtime} でブラウザ内実行、オンライン対戦なし）",
   "onlineInstead": "オンライン対戦に切り替える",
   "joinRoom": "ルームに参加",
   "joinHint": "{host} のルーム · {players}/{max} 人 · あなたは {slot}P",
   "joinHintNoList": "クリックしてこのルームに参加し、コントローラー枠を選んでください。",
   "roomLookup": "ルームを確認中…",
   "roomGone": "このルームは閉じられました。自分でルームを作れます。",
   "roomFull": "ルームは満員です",
   "createOwnRoom": "自分でルームを作る",
   "roomBadge": "ルーム {players}/{max}",
   "slotLabel": "{n}P",
   "copyInvite": "招待リンクをコピー",
   "copied": "コピーしました",
   "leaveRoom": "⏏ ルームを退出",
   "cloudState": {
    "connecting": "サーバーに接続中…",
    "negotiating": "映像ストリームを準備中…",
    "starting": "ゲームを起動中…",
    "playing": "オンライン",
    "disconnected": "接続が切れました",
    "no-slots": "サーバーに空きがありません"
   }
  },
  "runtime": {
   "cloudDesc": "オンライン対戦：ゲームは cloud-game サーバー上で動作し、WebRTC でブラウザに配信されます",
   "cloudNotConfigured": "対戦サーバーが設定されていません（VITE_CLOUDGAME_URL）",
   "cloudNoSession": "対戦セッションのパラメータがありません",
   "cloudDisconnected": "対戦サーバーとの接続が切れました",
   "cloudWebrtcFailed": "映像ストリームを確立できません：{msg}",
   "cloudConnectFailed": "対戦サーバーに接続できません：{msg}",
   "cloudNoSlots": "対戦サーバーに現在空きがありません。しばらくしてからお試しください",
   "cloudTimeout": "対戦サーバーから応答がありません。しばらくしてからお試しください",
   "cloudProtocolError": "対戦通信エラー：{msg}"
  }
 }
}


def write_files():
    for rel, content in FILES.items():
        p = os.path.join(ROOT, rel)
        os.makedirs(os.path.dirname(p), exist_ok=True)
        old = open(p, encoding='utf-8').read() if os.path.exists(p) else None
        if old == content:
            print('skip ', rel)
            continue
        open(p, 'w', encoding='utf-8').write(content)
        print('write', rel)


def apply_patches():
    for item in PATCHES:
        rel = item['file']
        p = os.path.join(ROOT, rel)
        if not os.path.exists(p):
            if item['must']:
                raise SystemExit(f'找不到文件：{rel}')
            continue
        s = open(p, encoding='utf-8').read()
        orig = s
        for old, new in item['pairs']:
            if new in s:
                continue
            if old not in s:
                if item['must']:
                    raise SystemExit(f'[{rel}] 找不到锚点：{old[:60]!r}\n（上游可能改动了这段代码，需要人工确认）')
                continue
            s = s.replace(old, new, 1)
        if s != orig:
            open(p, 'w', encoding='utf-8').write(s)
            print('patch', rel)
        else:
            print('skip ', rel)


def q(s):
    return "'" + s.replace('\\', '\\\\').replace("'", "\\'") + "'"


def block(d, indent='    '):
    out = []
    for k, v in d.items():
        key = k if re.match(r'^[A-Za-z_]\w*$', k) else q(k)
        if isinstance(v, dict):
            out.append(f"{indent}{key}: {{\n{block(v, indent + '  ')}{indent}}},\n")
        else:
            out.append(f"{indent}{key}: {q(v)},\n")
    return ''.join(out)


def apply_i18n():
    for lang, d in I18N.items():
        p = os.path.join(ROOT, 'src/locales', lang + '.ts')
        if not os.path.exists(p):
            print('skip  locales/' + lang)
            continue
        s = open(p, encoding='utf-8').read()
        if '\n  rooms: {\n' in s:
            print('skip  locales/' + lang)
            continue
        if '\n  player: {\n' not in s or '\n  runtime: {\n' not in s:
            raise SystemExit(f'locales/{lang}.ts 结构不符合预期，需要人工确认')
        s = s.replace('\n  player: {\n',
                      '\n  /* ---------------- 联机房间 ---------------- */\n  rooms: {\n' + block(d['rooms']) + '  },\n\n  player: {\n', 1)
        s = s.replace('\n  player: {\n', '\n  player: {\n' + block(d['player']), 1)
        s = s.replace('\n  runtime: {\n', '\n  runtime: {\n' + block(d['runtime']), 1)
        open(p, 'w', encoding='utf-8').write(s)
        print('i18n ', lang)


if __name__ == '__main__':
    if not os.path.isdir(os.path.join(ROOT, 'src/emulator')):
        raise SystemExit(f'{ROOT} 看起来不是 8bitgo 项目根目录')
    write_files()
    apply_patches()
    apply_i18n()
    print('\n完成。接着跑：npx tsc -b   （应无输出）')
