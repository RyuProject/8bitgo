#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
观众模式的界面部分（直播第一步的收尾）。幂等。

    python3 patches/spectator-ui.py [项目路径]

前置：先跑 spectator-server.py 和 spectator-client.py。

做的事：
  1. 适配器：观众身份可以在运行中切换（上场 / 退到观众席），不用断线重连
  2. 房间列表带上「几个人在看」
  3. 房间卡片：满员时不再是死路一条，改成「观看」
  4. 播放器：加入时可以选「只看不玩」；工具栏显示观众数并能切换身份
  5. 侧边栏「直播」变成真的 —— 指向 /rooms?live=1，数据就是信令服务器上的房间
  6. 八种语言的文案
"""
import sys, os, re

ROOT = os.path.abspath(sys.argv[1] if len(sys.argv) > 1 else '.')


def edit(rel, edits, marker):
    """按锚点替换。marker 已存在就跳过（幂等）。"""
    p = os.path.join(ROOT, rel)
    with open(p, encoding='utf-8') as f:
        s = f.read()
    if marker in s:
        print('skip ', rel)
        return
    for old, new in edits:
        assert old in s, f'[{rel}] 找不到锚点：{old[:80]!r}'
        assert s.count(old) == 1, f'[{rel}] 锚点不唯一：{old[:80]!r}'
        s = s.replace(old, new, 1)
    with open(p, 'w', encoding='utf-8') as f:
        f.write(s)
    print('patch', rel)


# ────────────────────────── 1. 适配器：身份可切换 ──────────────────────────
edit('src/emulator/adapters/emulatorjs.ts', [
    # 接口：加一个「把切换函数交出去」的回调
    ("""  role?: 'player' | 'spectator'
  roomId?: string""",
     """  role?: 'player' | 'spectator'
  /**
   * 进房后把「切身份」的函数交给调用方，观众想上场时不用断线重连。
   * 传 true 掐断输入（观众），传 false 恢复（玩家）。
   */
  onSpectatorControl?: (setSpectator: (on: boolean) => void) => void
  roomId?: string"""),

    # 一次性掐断 → 可来回切
    ("""    // 观众：把 netplay 的输入转发换成空实现。
    // EmulatorJS 的调用链是 键盘 → GameManager.simulateInput → netplay.simulateInput → 发给房主，
    // 把最后这一环换掉，观众按什么都传不出去（画面和声音照常收）。
    if (netplay.role === 'spectator') {
      try {
        np.simulateInput = () => {}
      } catch {
        /* 换不掉也不致命，服务端那边本来就不给观众手柄位 */
      }
    }
""",
     """    // 观众：把 netplay 的输入转发换成空实现。
    // EmulatorJS 里 键盘 → GameManager.simulateInput → netplay.simulateInput，
    // 而 netplay.simulateInput 既把输入喂给本地模拟器、又发 sync-control 给房主，
    // 所以换掉这一环，观众按什么都不会生效，画面和声音照常收。
    const realInput = np.simulateInput?.bind(np)
    const applyRole = (spectator: boolean) => {
      try {
        if (spectator) np.simulateInput = () => {}
        else if (realInput) np.simulateInput = realInput
      } catch {
        /* 换不掉也不致命：服务端那边本来就不给观众手柄位 */
      }
    }
    applyRole(netplay.role === 'spectator')
    netplay.onSpectatorControl?.(applyRole)
"""),
], marker='onSpectatorControl')


# ────────────────────────── 2. 房间列表带观众数 ──────────────────────────
edit('src/services/allRooms.ts', [
    ("""        players: r.players,
        max: r.max,""",
     """        players: r.players,
        max: r.max,
        spectators: r.spectators ?? 0,"""),
], marker='spectators')


# ────────────────────────── 3. 房间卡片 ──────────────────────────
edit('src/components/game/RoomCard.tsx', [
    ("""  players: number
  max: number
  host: { nickname: string } | null""",
     """  players: number
  max: number
  /** 只看不玩的人数。P2P 房间天然就是一路直播，这里就是「几个人在看」 */
  spectators?: number
  host: { nickname: string } | null"""),

    ("""    players: r.players,
    max: 4,""",
     """    players: r.players,
    max: 4,
    spectators: 0,"""),

    # 满员不再是死路：改成「观看」
    ("""  const full = room.players >= max
  // P2P 房间走 ?p2p=，云端房间走 ?room=
  const param = room.kind === 'p2p' ? 'p2p' : 'room'
  const to = `/games/${room.gameSlug}?${param}=${encodeURIComponent(room.roomId)}`""",
     """  const full = room.players >= max
  const viewers = room.spectators ?? 0
  // 手柄位满了也能进 —— 以观众身份看房主的画面（只有 P2P 房间支持）
  const watchable = room.kind === 'p2p'
  // P2P 房间走 ?p2p=，云端房间走 ?room=
  const param = room.kind === 'p2p' ? 'p2p' : 'room'
  const to =
    `/games/${room.gameSlug}?${param}=${encodeURIComponent(room.roomId)}` +
    (full && watchable ? '&watch=1' : '')"""),

    # compact：人数后面补观众数
    ("""        <span className={cx('shrink-0 text-[11px] font-semibold', full ? 'text-dim' : 'text-online')}>
          {room.players}/{max}
        </span>""",
     """        <span className={cx('shrink-0 text-[11px] font-semibold', full ? 'text-dim' : 'text-online')}>
          {room.players}/{max}
          {viewers > 0 && <span className="ml-1 font-normal text-muted">👀 {viewers}</span>}
        </span>"""),

    # 大卡片：右下角人数旁边加观众数
    ("""        <Badge tone={full ? 'dark' : 'online'} className="absolute bottom-2 right-2">
          👥 {room.players}/{max}
        </Badge>""",
     """        <Badge tone={full ? 'dark' : 'online'} className="absolute bottom-2 right-2">
          👥 {room.players}/{max}
        </Badge>
        {viewers > 0 && (
          <Badge tone="dark" className="absolute bottom-2 left-2">
            👀 {fmt(t.rooms.viewers, { n: String(viewers) })}
          </Badge>
        )}"""),

    # 左上角状态条：满员 → 「观看」而不是灰掉的「已满」
    ("""          <span className={cx('h-1.5 w-1.5 rounded-full', full ? 'bg-dim' : 'animate-pulse bg-online')} />
          {full ? t.rooms.full : t.rooms.open}""",
     """          <span className={cx('h-1.5 w-1.5 rounded-full', full && !watchable ? 'bg-dim' : 'animate-pulse bg-online')} />
          {!full ? t.rooms.open : watchable ? `👀 ${t.rooms.watch}` : t.rooms.full}"""),
], marker='spectators')


# ────────────────────────── 4. 播放器 ──────────────────────────
edit('src/emulator/EmulatorPlayer.tsx', [
    # 4.1 props
    ("""  /** 邀请链接带进来的云端房间 id（详情页 ?room=，付费通道） */
  cloudInvite?: string""",
     """  /** 邀请链接带进来的云端房间 id（详情页 ?room=，付费通道） */
  cloudInvite?: string
  /** 从「直播」入口进来（详情页 ?watch=1）：默认以观众身份加入，只看不玩 */
  watch?: boolean"""),

    ("""  invite,
  cloudInvite,
  backdrop,""",
     """  invite,
  cloudInvite,
  watch = false,
  backdrop,"""),

    # 4.2 状态
    ("""  /** 服务端下发的房间令牌：取存档、接手房主要用它证明自己是房间成员 */
  const roomTokenRef = useRef<string>('')""",
     """  /** 服务端下发的房间令牌：取存档、接手房主、切身份都要用它证明自己是房间成员 */
  const roomTokenRef = useRef<string>('')
  /** 我在房间里的身份。观众只收画面和声音，按键不生效 */
  const [role, setRole] = useState<RoomRole>('player')
  /** 我是不是房主（房主的机器在跑游戏，不能退到观众席） */
  const [isHost, setIsHost] = useState(false)
  /** 适配器交出来的「切身份」函数：不用断线重连就能上场 / 退下 */
  const roleSwitchRef = useRef<((spectator: boolean) => void) | null>(null)"""),

    # 4.3 邀请房间：满员时还能不能当观众
    ("""  const inviteFull = Boolean(inviteRoom && inviteRoom.players >= inviteRoom.max)""",
     """  const inviteFull = Boolean(inviteRoom && inviteRoom.players >= inviteRoom.max)
  /**
   * 手柄位满了还有没有观众席。
   * 老服务端不下发 maxSpectators，这里会算成 0 —— 行为退回原来的「房间已满」，不会出错。
   */
  const spectatorSeatFree = Boolean(
    inviteRoom && (inviteRoom.spectators ?? 0) < (inviteRoom.maxSpectators ?? 0),
  )
  /** 能不能以观众身份进这个房间（只有 P2P 房间是一路直播） */
  const canWatch = p2pOk && Boolean(inviteRoom) && spectatorSeatFree
  /**
   * 这次进房会不会是观众：从「直播」入口点进来的（?watch=1），
   * 或者手柄位已经坐满了。按钮文案和下面的说明都跟着它走，
   * 免得写着「加入房间」结果进去发现动不了。
   */
  const willWatch = canWatch && (watch || inviteFull)
  /** 正在看的人数（自己所在的房间） */
  const myNetRoom = session?.netplay && roomId ? p2pRooms.find((r) => r.roomId === roomId) : undefined
  const viewers = myNetRoom?.spectators ?? 0"""),

    # 4.4 startP2p 支持身份
    ("""  const startP2p = (join?: string, takeOver?: { from: string; state: Uint8Array | null }) => {
    if (!gameSlug || !romUrl) return
    setError(null)
    if (!takeOver) setNotice(null)
    setRoomId(join ?? null)
    setPlayers(1)""",
     """  const startP2p = (
    join?: string,
    takeOver?: { from: string; state: Uint8Array | null },
    asRole: RoomRole = 'player',
  ) => {
    if (!gameSlug || !romUrl) return
    setError(null)
    if (!takeOver) setNotice(null)
    setRoomId(join ?? null)
    setPlayers(1)
    setRole(asRole)
    setIsHost(!join)
    roleSwitchRef.current = null"""),

    ("""        mode: join ? 'join' : 'host',
        roomId: join,""",
     """        mode: join ? 'join' : 'host',
        role: asRole,
        onSpectatorControl: (fn) => (roleSwitchRef.current = fn),
        roomId: join,"""),

    ("""        onRoom: (id, isHost) => {
          setRoomId(id)""",
     """        onRoom: (id, host) => {
          setRoomId(id)
          setIsHost(host)
          // 接手房主之后自然就不是观众了
          if (host) setRole('player')"""),

    ("""          const from = migrateFromRef.current
          if (isHost && from && from !== id) {""",
     """          const from = migrateFromRef.current
          if (host && from && from !== id) {"""),

    # 4.5 进房入口：从直播来的、或者手柄位满了，就当观众
    ("""    if (inviteId && p2pOk) return startP2p(inviteId)""",
     """    if (inviteId && p2pOk) return startP2p(inviteId, undefined, willWatch ? 'spectator' : 'player')"""),

    # 4.6 满员不再堵死
    ("""  const joinBlocked = online && (inviteFull || inviteGone || cloudJoinPending)""",
     """  const joinBlocked = online && ((inviteFull && !canWatch) || inviteGone || cloudJoinPending)

  /**
   * 上场 / 退到观众席。
   * 服务端那边记账（手柄位够不够由它说了算），本地那边掐断或恢复输入转发 ——
   * 真正管用的是本地这一下，因为按键是走 WebRTC 直接到房主的，不经过服务器。
   */
  const toggleRole = async () => {
    if (!roomId || isHost) return
    const next: RoomRole = role === 'spectator' ? 'player' : 'spectator'
    const ok = await setRoomRole(roomId, roomTokenRef.current, next)
    if (!ok) {
      setNotice(t.player.roleFailed)
      return
    }
    roleSwitchRef.current?.(next === 'spectator')
    setRole(next)
    setNotice(null)
    refreshNetplayRooms()
  }"""),

    # 4.6b reset 里把身份也清掉，不然下次开自己的房还带着上一局的观众身份
    ("""    setRoomId(null)
    setPlayers(1)
    setCloudState(null)""",
     """    setRoomId(null)
    setPlayers(1)
    setCloudState(null)
    // 身份跟着房间一起清掉，不然下次开自己的房还会被当成观众
    setRole('player')
    setIsHost(false)
    roleSwitchRef.current = null"""),

    # 4.7 主按钮：图标和文案都跟着 willWatch 走
    ("""                    <span aria-hidden>{online ? '👥' : '▶'}</span>{' '}""",
     """                    <span aria-hidden>{online ? (willWatch ? '👀' : '👥') : '▶'}</span>{' '}"""),

    ("""                    {joining && online
                      ? inviteFull
                        ? t.player.roomFull
                        : inviteGone
                          ? t.player.roomGoneShort
                          : t.player.joinRoom""",
     """                    {joining && online
                      ? willWatch
                        ? t.player.watchRoom
                        : inviteFull
                          ? t.player.roomFull
                          : inviteGone
                            ? t.player.roomGoneShort
                            : t.player.joinRoom"""),

    # 4.8 按钮下面的说明：满员 → 说清楚是观众；没满 → 给个「只看不玩」
    ("""                        {inviteGone
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
                        </button>""",
     """                        {inviteGone
                          ? t.player.roomGone
                          : willWatch
                            ? inviteFull
                              ? t.player.watchHint
                              : t.player.watchHintPick
                            : inviteRoom
                              ? fmt(t.player.joinHint, {
                                  host: inviteRoom.host?.nickname ?? '—',
                                  players: String(inviteRoom.players),
                                  max: String(inviteRoom.max),
                                  slot: String(Math.min(inviteRoom.players + 1, inviteRoom.max)),
                                })
                              : t.player.roomLookup}
                        <br />
                        {/* 位子还空着，但只想看别人玩 */}
                        {canWatch && !willWatch && inviteId && (
                          <button
                            type="button"
                            className="mx-1 underline underline-offset-2 hover:text-white"
                            onClick={() => startP2p(inviteId, undefined, 'spectator')}
                          >
                            {t.player.watchInstead}
                          </button>
                        )}
                        <button
                          type="button"
                          className="mx-1 underline underline-offset-2 hover:text-white"
                          onClick={() => setIgnoreInvite(true)}
                        >
                          {t.player.createOwnRoom}
                        </button>"""),

    # 4.9 工具栏：人数用服务端的（不含观众），加观众数与身份切换
    ("""  const roomPlayers = session?.cloud ? (myCloudRoom?.players ?? 1) : players""",
     """  // 服务端的 players 不含观众，比本地 onPlayers 更准；拿不到时退回本地计数
  const roomPlayers = session?.cloud ? (myCloudRoom?.players ?? 1) : (myNetRoom?.players ?? players)"""),

    ("""              {session?.netplay && <span className="font-normal text-muted">· {t.player.p2pTag}</span>}
            </span>""",
     """              {session?.netplay && <span className="font-normal text-muted">· {t.player.p2pTag}</span>}
            </span>
            {session?.netplay && viewers > 0 && (
              <span className="inline-flex items-center gap-1 rounded-md bg-white/5 px-2 py-1 font-semibold text-muted">
                👀 {fmt(t.player.viewers, { n: String(viewers) })}
              </span>
            )}
            {session?.netplay && role === 'spectator' && (
              <span className="inline-flex items-center gap-1 rounded-md bg-live/15 px-2 py-1 font-semibold text-red-300">
                {t.player.spectatorTag}
              </span>
            )}
            {session?.netplay && roomId && !isHost && (
              <button
                type="button"
                onClick={() => void toggleRole()}
                className="rounded-md border border-line px-2 py-1 text-muted hover:text-fg"
              >
                {role === 'spectator' ? t.player.takeSeat : t.player.goWatch}
              </button>
            )}"""),
], marker='toggleRole')


# 播放器要新增的 import
p = os.path.join(ROOT, 'src/emulator/EmulatorPlayer.tsx')
with open(p, encoding='utf-8') as f:
    s = f.read()
m = re.search(r"^import \{([^}]*)\} from '@/services/netplay'$", s, re.M)
assert m, '找不到 EmulatorPlayer 里的 netplay import'
names = [x.strip() for x in m.group(1).replace('\n', ' ').split(',') if x.strip()]
want = ['setRoomRole', 'type RoomRole']
missing = [w for w in want if w not in names]
if missing:
    names = sorted(set(names + want), key=lambda x: (x.startswith('type '), x))
    block = 'import {\n' + ''.join(f'  {n},\n' for n in names) + "} from '@/services/netplay'"
    s = s[:m.start()] + block + s[m.end():]
    with open(p, 'w', encoding='utf-8') as f:
        f.write(s)
    print('patch EmulatorPlayer 的 import：+', ', '.join(missing))
else:
    print('skip  EmulatorPlayer 的 import')


# ────────────────────────── 5. 「直播」入口变成真的 ──────────────────────────
edit('src/config/features.ts', [
    ("""  live: false,""",
     """  // 直播 = P2P 房间的观众席：房主的画面和声音本来就在往房间里推，
  // 「直播」入口就是这些房间按在看人数排的列表，没有额外成本。
  live: true,"""),
], marker='live: true')

edit('src/components/layout/nav.ts', [
    ("""    ...(FEATURES.live ? [{ label: t.nav.live, to: '/#live', icon: '📺', disabled: true, badge: 'coming soon' }] : []),""",
     """    ...(FEATURES.live ? [{ label: t.nav.live, to: '/rooms?live=1', icon: '📺', exact: true }] : []),"""),
    ("""    ...(FEATURES.live ? [{ label: '8BitGo TV', to: '/tv' }] : []),""",
     """    ...(FEATURES.live ? [{ label: '8BitGo TV', to: '/rooms?live=1' }] : []),"""),
], marker="'/rooms?live=1'")


# ────────────────────────── 6. /rooms?live=1 ──────────────────────────
edit('src/pages/RoomsPage.tsx', [
    ("""import { getMultiplayerGames } from '@/services/games'""",
     """import { useSearchParams } from 'react-router-dom'
import { getMultiplayerGames } from '@/services/games'"""),

    ("""  const t = useT()
  useSeo({ title: t.rooms.title, description: t.rooms.seo, noindex: true })
  const rooms = useAllRooms()
  const enabled = anyRoomsEnabled()""",
     """  const t = useT()
  // ?live=1 —— 同一批房间，换个看法：按「几个人在看」排，文案讲的是看而不是玩
  const [searchParams] = useSearchParams()
  const live = searchParams.get('live') === '1'
  useSeo({
    title: live ? t.rooms.liveH1 : t.rooms.title,
    description: live ? t.rooms.liveSeo : t.rooms.seo,
    noindex: true,
  })
  const all = useAllRooms()
  const rooms = live ? [...all].sort((a, b) => (b.spectators ?? 0) - (a.spectators ?? 0)) : all
  const enabled = anyRoomsEnabled()"""),

    ("""        <span className="text-pixel text-[11px] text-brand-hover">MULTIPLAYER</span>
        <h1 className="mt-2 text-3xl font-extrabold tracking-tight">{t.rooms.h1}</h1>
        <p className="mt-3 leading-relaxed text-muted">{t.rooms.intro}</p>""",
     """        <span className="text-pixel text-[11px] text-brand-hover">{live ? 'LIVE' : 'MULTIPLAYER'}</span>
        <h1 className="mt-2 text-3xl font-extrabold tracking-tight">{live ? t.rooms.liveH1 : t.rooms.h1}</h1>
        <p className="mt-3 leading-relaxed text-muted">{live ? t.rooms.liveIntro : t.rooms.intro}</p>"""),

    ("""          title={t.rooms.liveTitle}""",
     """          title={live ? t.rooms.liveH1 : t.rooms.liveTitle}"""),

    ("""            <p className="mt-2 font-semibold">{t.rooms.emptyTitle}</p>
            <p className="mt-1 text-sm text-muted">{t.rooms.emptyBody}</p>""",
     """            <p className="mt-2 font-semibold">{live ? t.rooms.liveEmptyTitle : t.rooms.emptyTitle}</p>
            <p className="mt-1 text-sm text-muted">{live ? t.rooms.liveEmptyBody : t.rooms.emptyBody}</p>"""),
], marker="live = searchParams.get('live')")


# ────────────────────────── 7. 详情页传 ?watch=1 ──────────────────────────
edit('src/pages/GameDetailPage.tsx', [
    ("""  const cloudInvite = searchParams.get('room') ?? undefined""",
     """  const cloudInvite = searchParams.get('room') ?? undefined
  // 从「直播」进来的：默认只看不玩
  const watchOnly = searchParams.get('watch') === '1'"""),

    ("""              invite={invite}
              cloudInvite={cloudInvite}""",
     """              invite={invite}
              cloudInvite={cloudInvite}
              watch={watchOnly}"""),
], marker='watchOnly')


# ────────────────────────── 8. 八种语言 ──────────────────────────
def q(s: str) -> str:
    return s.replace('\\', '\\\\').replace("'", "\\'").replace('\n', '\\n').replace('\r', '')


def add_keys(lang: str, section: str, pairs: dict):
    """往某个语言文件的某个顶层小节里补键（已有的不动）。"""
    p = os.path.join(ROOT, f'src/locales/{lang}.ts')
    with open(p, encoding='utf-8') as f:
        s = f.read()
    head = f'\n  {section}: {{\n'
    i = s.find(head)
    assert i >= 0, f'[{lang}] 找不到小节 {section}'
    start = i + len(head)
    end = s.find('\n  },\n', start)
    assert end > start, f'[{lang}] {section} 小节没有结尾'
    body = s[start:end]
    add = [f"    {k}: '{q(v)}',"
           for k, v in pairs.items()
           if not re.search(rf'^\s*{re.escape(k)}\s*:', body, re.M)]
    if not add:
        return 0
    s = s[:start] + '\n'.join(add) + '\n' + s[start:]
    with open(p, 'w', encoding='utf-8') as f:
        f.write(s)
    return len(add)


I18N = {
  'zh-Hans': {
    'rooms': {
      'watch': '观看',
      'viewers': '{n} 人在看',
      'liveH1': '正在直播',
      'liveSeo': '看别人玩老游戏：房主的画面和声音实时推给房间里的每个人，点开就能看。',
      'liveIntro': '每个联机房间同时就是一路直播 —— 房主的画面和声音实时推给房间里的人。点进去就能看；手柄位还空着的话，也可以直接上场一起玩。',
      'liveEmptyTitle': '现在没有人在直播',
      'liveEmptyBody': '任何人开一局联机游戏，这里就会出现。',
    },
    'player': {
      'watchRoom': '观看直播',
      'watchInstead': '只看不玩',
      'watchHint': '手柄位满了，你会以观众身份进入：看得到房主的画面和声音，但不能操作。',
      'watchHintPick': '你选的是只看不玩：能看到房主的画面、听到声音，但不参与操作。想上场随时在工具栏点「上场玩」。',
      'spectatorTag': '观众',
      'viewers': '{n} 人在看',
      'takeSeat': '上场玩',
      'goWatch': '退到观众席',
      'roleFailed': '换不了身份：手柄位满了，或者房间已经结束。',
    },
  },
  'zh-Hant': {
    'rooms': {
      'watch': '觀看',
      'viewers': '{n} 人在看',
      'liveH1': '正在直播',
      'liveSeo': '看別人玩老遊戲：房主的畫面和聲音即時推給房間裡的每個人，點開就能看。',
      'liveIntro': '每個連線房間同時就是一路直播 —— 房主的畫面和聲音即時推給房間裡的人。點進去就能看；手把位還空著的話，也可以直接上場一起玩。',
      'liveEmptyTitle': '現在沒有人在直播',
      'liveEmptyBody': '任何人開一局連線遊戲，這裡就會出現。',
    },
    'player': {
      'watchRoom': '觀看直播',
      'watchInstead': '只看不玩',
      'watchHint': '手把位滿了，你會以觀眾身分進入：看得到房主的畫面和聲音，但不能操作。',
      'watchHintPick': '你選的是只看不玩：能看到房主的畫面、聽到聲音，但不參與操作。想上場隨時在工具列點「上場玩」。',
      'spectatorTag': '觀眾',
      'viewers': '{n} 人在看',
      'takeSeat': '上場玩',
      'goWatch': '退到觀眾席',
      'roleFailed': '換不了身分：手把位滿了，或者房間已經結束。',
    },
  },
  'en': {
    'rooms': {
      'watch': 'Watch',
      'viewers': '{n} watching',
      'liveH1': 'Live now',
      'liveSeo': 'Watch other people play retro games — the host\u2019s screen and sound are streamed live to everyone in the room.',
      'liveIntro': 'Every multiplayer room is a live stream too — the host\u2019s screen and sound go straight to everyone in it. Open one to watch, or take a free controller slot and play along.',
      'liveEmptyTitle': 'Nobody is streaming right now',
      'liveEmptyBody': 'The moment someone starts a multiplayer game, it shows up here.',
    },
    'player': {
      'watchRoom': 'Watch',
      'watchInstead': 'Just watch',
      'watchHint': 'Every controller slot is taken, so you will join as a spectator: you get the host\u2019s picture and sound, but no controls.',
      'watchHintPick': 'You are joining to watch: you get the host’s picture and sound but no controls. Hit “Take a slot” in the toolbar whenever you want to play.',
      'spectatorTag': 'Spectator',
      'viewers': '{n} watching',
      'takeSeat': 'Take a slot',
      'goWatch': 'Just watch',
      'roleFailed': 'Could not switch: no free controller slot, or the room has ended.',
    },
  },
  'es': {
    'rooms': {
      'watch': 'Ver',
      'viewers': '{n} viendo',
      'liveH1': 'En directo',
      'liveSeo': 'Mira a otros jugar a juegos retro: la imagen y el sonido del anfitrión llegan en directo a toda la sala.',
      'liveIntro': 'Cada sala multijugador es también una retransmisión: la imagen y el sonido del anfitrión llegan a todos los que están dentro. Entra para mirar o, si queda un mando libre, únete a la partida.',
      'liveEmptyTitle': 'Ahora mismo no hay nadie en directo',
      'liveEmptyBody': 'En cuanto alguien empiece una partida multijugador, aparecerá aquí.',
    },
    'player': {
      'watchRoom': 'Ver',
      'watchInstead': 'Solo mirar',
      'watchHint': 'No queda ningún mando libre, así que entrarás como espectador: verás y oirás la partida del anfitrión, pero no podrás jugar.',
      'watchHintPick': 'Entras solo para mirar: verás y oirás la partida del anfitrión, pero sin controles. Pulsa «Coger un mando» en la barra cuando quieras jugar.',
      'spectatorTag': 'Espectador',
      'viewers': '{n} viendo',
      'takeSeat': 'Coger un mando',
      'goWatch': 'Solo mirar',
      'roleFailed': 'No se pudo cambiar: no hay mando libre o la sala ha terminado.',
    },
  },
  'fr': {
    'rooms': {
      'watch': 'Regarder',
      'viewers': '{n} spectateurs',
      'liveH1': 'En direct',
      'liveSeo': 'Regardez d\u2019autres joueurs sur des jeux rétro : l\u2019image et le son de l\u2019hôte sont diffusés en direct à toute la salle.',
      'liveIntro': 'Chaque salle multijoueur est aussi une diffusion en direct : l\u2019image et le son de l\u2019hôte arrivent chez tous ceux qui sont dedans. Entrez pour regarder, ou prenez une manette libre et jouez.',
      'liveEmptyTitle': 'Personne ne diffuse pour le moment',
      'liveEmptyBody': 'Dès que quelqu\u2019un lance une partie multijoueur, elle apparaît ici.',
    },
    'player': {
      'watchRoom': 'Regarder',
      'watchInstead': 'Juste regarder',
      'watchHint': 'Toutes les manettes sont prises : vous entrerez comme spectateur, avec l\u2019image et le son de l\u2019hôte, mais sans les commandes.',
      'watchHintPick': 'Vous entrez pour regarder : image et son de l’hôte, sans les commandes. Cliquez sur « Prendre une manette » dans la barre pour jouer.',
      'spectatorTag': 'Spectateur',
      'viewers': '{n} spectateurs',
      'takeSeat': 'Prendre une manette',
      'goWatch': 'Juste regarder',
      'roleFailed': 'Changement impossible : aucune manette libre, ou la salle est terminée.',
    },
  },
  'it': {
    'rooms': {
      'watch': 'Guarda',
      'viewers': '{n} stanno guardando',
      'liveH1': 'In diretta',
      'liveSeo': 'Guarda altri giocare a giochi retro: immagine e audio dell\u2019host arrivano in diretta a tutta la stanza.',
      'liveIntro': 'Ogni stanza multigiocatore è anche una diretta: immagine e audio dell\u2019host arrivano a tutti quelli che sono dentro. Entra per guardare oppure, se c\u2019è un posto libero, mettiti a giocare.',
      'liveEmptyTitle': 'Al momento non c\u2019è nessuna diretta',
      'liveEmptyBody': 'Appena qualcuno avvia una partita multigiocatore, comparirà qui.',
    },
    'player': {
      'watchRoom': 'Guarda',
      'watchInstead': 'Solo guardare',
      'watchHint': 'I posti sono tutti occupati, quindi entrerai come spettatore: vedi e senti la partita dell\u2019host, ma non puoi giocare.',
      'watchHintPick': 'Entri solo per guardare: immagine e audio dell’host, ma senza comandi. Premi «Prendi un posto» nella barra quando vuoi giocare.',
      'spectatorTag': 'Spettatore',
      'viewers': '{n} stanno guardando',
      'takeSeat': 'Prendi un posto',
      'goWatch': 'Solo guardare',
      'roleFailed': 'Cambio non riuscito: nessun posto libero, o la stanza è finita.',
    },
  },
  'de': {
    'rooms': {
      'watch': 'Zuschauen',
      'viewers': '{n} schauen zu',
      'liveH1': 'Jetzt live',
      'liveSeo': 'Anderen beim Spielen von Retro-Spielen zusehen: Bild und Ton des Gastgebers gehen live an alle im Raum.',
      'liveIntro': 'Jeder Mehrspielerraum ist zugleich ein Livestream: Bild und Ton des Gastgebers gehen direkt an alle im Raum. Zum Zuschauen reinklicken – oder einen freien Controller-Platz nehmen und mitspielen.',
      'liveEmptyTitle': 'Gerade ist niemand live',
      'liveEmptyBody': 'Sobald jemand ein Mehrspieler-Spiel startet, taucht es hier auf.',
    },
    'player': {
      'watchRoom': 'Zuschauen',
      'watchInstead': 'Nur zuschauen',
      'watchHint': 'Alle Controller-Plätze sind belegt, du kommst als Zuschauer rein: Bild und Ton des Gastgebers, aber keine Steuerung.',
      'watchHintPick': 'Du kommst als Zuschauer rein: Bild und Ton des Gastgebers, aber keine Steuerung. Über „Platz nehmen“ in der Leiste kannst du jederzeit mitspielen.',
      'spectatorTag': 'Zuschauer',
      'viewers': '{n} schauen zu',
      'takeSeat': 'Platz nehmen',
      'goWatch': 'Nur zuschauen',
      'roleFailed': 'Wechsel nicht möglich: kein freier Platz, oder der Raum ist zu Ende.',
    },
  },
  'ja': {
    'rooms': {
      'watch': '観戦',
      'viewers': '{n} 人が視聴中',
      'liveH1': '配信中',
      'liveSeo': 'ほかの人のレトロゲームを観る：ホストの画面と音がそのまま部屋の全員に届きます。',
      'liveIntro': 'マルチプレイの部屋は、そのまま配信でもあります。ホストの画面と音が部屋にいる全員に届くので、開けばすぐ観られます。コントローラーの空きがあれば、そのまま参加もできます。',
      'liveEmptyTitle': 'いま配信している人はいません',
      'liveEmptyBody': '誰かがマルチプレイを始めれば、ここに出てきます。',
    },
    'player': {
      'watchRoom': '観戦する',
      'watchInstead': '観るだけ',
      'watchHint': 'コントローラーが満席なので観戦で参加します。ホストの画面と音は届きますが、操作はできません。',
      'watchHintPick': '観るだけで参加します。ホストの画面と音は届きますが、操作はできません。プレイしたくなったらツールバーの「プレイに加わる」から。',
      'spectatorTag': '観戦',
      'viewers': '{n} 人が視聴中',
      'takeSeat': 'プレイに加わる',
      'goWatch': '観戦にまわる',
      'roleFailed': '切り替えできません：空きがないか、部屋が終了しています。',
    },
  },
}

total = 0
for lang, sections in I18N.items():
    n = sum(add_keys(lang, sec, pairs) for sec, pairs in sections.items())
    total += n
    print(f'  {lang}: +{n} 条')
print(f'文案共补 {total} 条')

print('\n完成。')
