/**
 * jsnes 联机面板（与 EmulatorJS 的 MatchControls 平行、互不影响）。
 * 只负责「开房 / 进房 / 调输入延迟 / 复制邀请链接」这一层 UI；
 * 真正的 P2P 握手与逐帧同步在 src/emulator/jsnesNetplay.ts + adapters/jsnes.ts 里。
 *
 * 当前游戏实际跑在 jsnes 时可直接开锁步联机；跑在 EmulatorJS 时仍用它自己的联机链路，
 * 两套协议由播放器按运行时句柄分派，不能只看平台名猜。
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { Button, buttonClasses } from '@/components/ui/Button'
import { playerName } from '@/services/netplay'
import type { RuntimeHandle } from './types'

interface Props {
  handle: RuntimeHandle
  gameSlug?: string
  gameName: string
  /** 邀请链接进来时由面板自己自动加入，状态回调才能落在这张面板上。 */
  initialRoomId?: string
  /** 详情页通用开房按钮进来时，面板挂载后直接创建房间。 */
  autoHost?: boolean
  onClose?: () => void
}

type LinkState = RTCPeerConnectionState | 'idle' | 'connecting'

export function JsnesNetplayPanel({ handle, gameSlug, gameName, initialRoomId = '', autoHost = false, onClose }: Props) {
  const [mode, setMode] = useState<'host' | 'join' | null>(null)
  const [started, setStarted] = useState(false)
  const [roomId, setRoomId] = useState('')
  const [code, setCode] = useState(initialRoomId.toUpperCase())
  const [bufferFrames, setBufferFrames] = useState(2)
  const [linkState, setLinkState] = useState<LinkState>('idle')
  const [players, setPlayers] = useState(1)
  const [copied, setCopied] = useState(false)
  const [error, setError] = useState('')
  const autoJoinStarted = useRef(false)
  const autoHostStarted = useRef(false)

  const inviteLink = useMemo(() => {
    if (!roomId || !gameSlug) return ''
    const u = new URL(window.location.href)
    u.pathname = `/games/${gameSlug}`
    u.search = `jsnesp2p=${roomId}`
    return u.toString()
  }, [roomId, gameSlug])

  const callbacks = {
    onRoom: (id: string) => setRoomId(id),
    onPlayers: (n: number) => setPlayers(n),
    onLinkState: (s: RTCPeerConnectionState) => setLinkState(s),
    onHostLeft: () => setError('对端已离开，联机结束'),
    onError: (message: string) => {
      setLinkState('failed')
      setError(message || '联机失败，请重试')
    },
  }

  const startHost = () => {
    setError('')
    setMode('host')
    const ok = handle.openJsnesNetplay?.({
      mode: 'host',
      roomName: gameName,
      playerName: playerName(),
      bufferFrames,
      ...callbacks,
    })
    if (ok) setStarted(true)
    else setError('这局游戏还没准备好，稍后再试')
  }

  const joinRoom = (rawCode: string) => {
    const id = rawCode.trim().toLowerCase()
    if (!id) {
      setError('请填写房间号')
      return
    }
    setError('')
    setMode('join')
    const ok = handle.openJsnesNetplay?.({
      mode: 'join',
      roomId: id,
      roomName: gameName,
      playerName: playerName(),
      bufferFrames,
      ...callbacks,
    })
    if (ok) setStarted(true)
    else setError('这局游戏还没准备好，稍后再试')
  }

  const startJoin = () => joinRoom(code)

  useEffect(() => {
    if (!initialRoomId || autoJoinStarted.current) return
    autoJoinStarted.current = true
    // 旧实现由父组件在后台先调用 openJsnesNetplay，随后才打开一张全新的空面板：
    // 实际已经进房，界面却还让玩家再填一次房号；第二次调用又因会话已占用而失败。
    joinRoom(initialRoomId)
    // initialRoomId 是邀请链接在本次挂载时的快照；面板不负责监听地址栏变化。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialRoomId])

  useEffect(() => {
    if (!autoHost || initialRoomId || autoHostStarted.current) return
    autoHostStarted.current = true
    // 通用“创建联机房间”已经表达了开房意图；再让玩家在弹窗里点第二次既多余又容易误解。
    startHost()
    // autoHost 是本次面板挂载的快照；StrictMode 重放靠 ref 防止重复占用一个会话。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoHost, initialRoomId])

  const reset = () => {
    handle.closeNetplay?.()
    setMode(null)
    setStarted(false)
    setRoomId('')
    setPlayers(1)
    setLinkState('idle')
    setError('')
  }

  const leave = () => {
    reset()
    onClose?.()
  }

  const copyLink = async () => {
    if (!inviteLink) return
    try {
      await navigator.clipboard.writeText(inviteLink)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      /* 剪贴板不可用就让用户自己选 */
    }
  }

  const stateLabel: Record<LinkState, string> = {
    idle: '空闲',
    connecting: '连接中…',
    connected: '已连接',
    disconnected: '已断开',
    failed: '失败',
    'new': '连接中…',
    closed: '已关闭',
  }

  // z-[80]：手机游玩模式的舞台是 fixed inset-0 z-[60]，z-50 会被整个压在黑屏下面，邀请链接进来根本看不到面板
  return (
    <div className="fixed inset-0 z-[80] flex items-center justify-center overflow-y-auto bg-black/50 p-4">
      <div className="my-auto w-full max-w-md rounded-lg border border-white/10 bg-neutral-900 p-5 text-sm text-neutral-100 shadow-xl">
        <div className="mb-4 flex items-center justify-between">
          <h3 className="text-base font-semibold">NES 联机（jsnes）</h3>
          <button onClick={leave} className={buttonClasses('ghost', 'sm')}>
            关闭
          </button>
        </div>

        {!started ? (
          <div className="space-y-4">
            <div className="flex items-center gap-3">
              <input
                type="range"
                min={0}
                max={8}
                step={1}
                value={bufferFrames}
                onChange={(e) => setBufferFrames(Number(e.target.value))}
                className="flex-1"
              />
              <span className="w-20 text-right text-neutral-400">
                延迟 {bufferFrames} 帧
              </span>
            </div>
            <p className="text-xs text-neutral-400">
              输入延迟越大越稳、但越不跟手。本地同网建议 0–2，跨网建议 3–5。
            </p>

            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <div className="rounded-md border border-white/10 p-3">
                <p className="mb-2 font-medium">创建房间</p>
                <p className="mb-3 text-xs text-neutral-400">你当房主（1P），把链接发给朋友。</p>
                <Button className="w-full" onClick={startHost}>
                  创建房间
                </Button>
              </div>
              <div className="rounded-md border border-white/10 p-3">
                <p className="mb-2 font-medium">加入房间</p>
                <input
                  value={code}
                  onChange={(e) => setCode(e.target.value.toUpperCase())}
                  placeholder="房间号"
                  className="mb-3 w-full rounded border border-white/10 bg-black/30 px-2 py-1 uppercase outline-none focus:border-white/30"
                />
                <Button className="w-full" variant="secondary" onClick={startJoin}>
                  加入
                </Button>
              </div>
            </div>
          </div>
        ) : (
          <div className="space-y-3">
            <div className="flex justify-between text-neutral-300">
              <span>身份：{mode === 'host' ? '房主（1P）' : '访客（2P）'}</span>
              <span>状态：{stateLabel[linkState] ?? linkState}</span>
            </div>
            <div className="text-neutral-400">在线人数：{players}</div>
            {roomId && (
              <div className="rounded border border-white/10 bg-black/30 p-2">
                <div className="mb-1 text-xs text-neutral-400">房间号：{roomId}</div>
                {inviteLink ? (
                  <div className="flex items-center gap-2">
                    <input
                      readOnly
                      value={inviteLink}
                      className="min-w-0 flex-1 truncate rounded border border-white/10 bg-black/40 px-2 py-1 text-xs"
                    />
                    <Button size="sm" variant="secondary" onClick={copyLink}>
                      {copied ? '已复制' : '复制'}
                    </Button>
                  </div>
                ) : (
                  <div className="text-xs text-neutral-400">把房间号 {roomId} 发给朋友即可</div>
                )}
              </div>
            )}
            <div className="flex justify-end pt-1">
              <Button variant="secondary" onClick={leave}>
                退出联机
              </Button>
            </div>
          </div>
        )}

        {error && <p className="mt-3 text-xs text-red-400">{error}</p>}
      </div>
    </div>
  )
}
