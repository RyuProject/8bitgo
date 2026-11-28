/** GBA 双机电缆房间面板；只在当前运行时明确提供电缆联机能力时显示。 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { Button, buttonClasses } from '@/components/ui/Button'
import type { RuntimeHandle } from './types'

interface Props {
  handle: RuntimeHandle | null
  gameSlug?: string
  gameName: string
  initialRoomId?: string
  autoHost?: boolean
  playerStatus?: string
  onSwitchRuntime?: (mode: 'host' | 'join', roomId: string, bufferFrames: number) => void
  onClose?: () => void
}

type LinkState = RTCPeerConnectionState | 'idle' | 'connecting'

export function GbaLinkNetplayPanel({ handle, gameSlug, gameName, initialRoomId = '', autoHost = false, playerStatus, onSwitchRuntime, onClose }: Props) {
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
  const autoHostSwitchStarted = useRef(false)

  const inviteLink = useMemo(() => {
    if (!roomId || !gameSlug) return ''
    const url = new URL(window.location.href)
    url.pathname = `/games/${gameSlug}`
    url.searchParams.delete('jsnesp2p')
    url.searchParams.delete('gbap2p')
    url.searchParams.set('gbap2p', roomId)
    url.hash = ''
    return url.toString()
  }, [roomId, gameSlug])

  const callbacks = {
    onRoom: (id: string) => setRoomId(id),
    onPlayers: (count: number) => setPlayers(count),
    onLinkState: (state: RTCPeerConnectionState) => setLinkState(state),
    onHostLeft: () => {
      setLinkState('closed')
      setError('对端已离开，联机结束')
    },
    onError: (message: string) => {
      setLinkState('failed')
      setError(message || 'GBA 联机失败，请重试')
    },
  }

  const start = (mode: 'host' | 'join', rawCode = '') => {
    const id = rawCode.trim().toLowerCase()
    if (mode === 'join' && !id) {
      setError('请填写房间号')
      return
    }
    setError('')
    setLinkState('connecting')
    if (!handle?.openGbaLinkNetplay) {
      if (onSwitchRuntime) {
        setStarted(true)
        onSwitchRuntime(mode, id, bufferFrames)
      } else {
        setLinkState('idle')
        setError('请先切换到 IodineGBA 运行时')
      }
      return
    }
    const opened = handle.openGbaLinkNetplay({
      mode,
      roomId: mode === 'join' ? id : undefined,
      bufferFrames,
      ...callbacks,
    })
    if (opened) setStarted(true)
    else {
      setLinkState('idle')
      setError('这局游戏还没准备好，或已经在联机中')
    }
  }

  useEffect(() => {
    if (playerStatus !== 'running' || !initialRoomId || autoJoinStarted.current || !handle?.openGbaLinkNetplay) return
    autoJoinStarted.current = true
    start('join', initialRoomId)
    // 邀请码是面板挂载时的快照；只自动加入一次。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialRoomId, handle, playerStatus])

  useEffect(() => {
    if (playerStatus !== 'running' || !autoHost || initialRoomId || autoHostStarted.current) return
    if (!handle?.openGbaLinkNetplay) {
      // 通用开房请求可能来自 EmulatorJS；先切换到真正接了电缆桥的 IodineGBA，再自动继续开房。
      if (autoHostSwitchStarted.current) return
      autoHostSwitchStarted.current = true
      start('host')
      return
    }
    autoHostSwitchStarted.current = false
    autoHostStarted.current = true
    start('host')
    // 通用“开房”动作只自动执行一次。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoHost, initialRoomId, handle, onSwitchRuntime, playerStatus])

  useEffect(() => {
    if (!started || handle?.openGbaLinkNetplay || playerStatus !== 'error') return
    setStarted(false)
    setLinkState('failed')
    setError('IodineGBA 没有启动成功；请检查 GBA BIOS 配置和 ROM 后重试。')
  }, [started, handle, playerStatus])

  const reset = () => {
    handle?.closeNetplay?.()
    // 玩家手动断开后，即使核心切换仍在途中，也不能等 IodineGBA 就绪时又自动重连。
    autoHostStarted.current = true
    autoHostSwitchStarted.current = true
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
      setError('无法访问剪贴板，请手动复制邀请链接')
    }
  }

  const label: Record<LinkState, string> = {
    idle: '空闲',
    connecting: '连接中…',
    connected: '已连接',
    disconnected: '连接中断',
    failed: '连接失败',
    new: '连接中…',
    closed: '已关闭',
  }

  return (
    <div className="fixed inset-0 z-[80] flex items-center justify-center overflow-y-auto bg-black/50 p-4">
      <div className="my-auto w-full max-w-md rounded-lg border border-white/10 bg-neutral-900 p-5 text-sm text-neutral-100 shadow-xl">
        <div className="mb-4 flex items-center justify-between">
          <h3 className="text-base font-semibold">GBA 双机电缆联机 · {gameName}</h3>
          <button onClick={leave} className={buttonClasses('ghost', 'sm')}>关闭</button>
        </div>

        <p className="mb-4 rounded-md bg-amber-950/50 p-3 text-xs leading-5 text-amber-100">
          联机需要双方使用完全相同的 ROM，并要求管理员已配置有效的 16 KiB GBA BIOS。当前支持 GBA 普通 8/32 位串口和 Multi-Pak；UART、GPIO、JoyBus 与 RFU 无线适配器游戏不支持。连接后会从双方的卡带存档重新启动双机游戏；纯 JavaScript 核心会占用更多手机性能。
        </p>

        {!started ? (
          <div className="space-y-4">
            <div className="flex items-center gap-3">
              <input type="range" min={0} max={8} step={1} value={bufferFrames}
                onChange={(event) => setBufferFrames(Number(event.target.value))} className="flex-1" />
              <span className="w-20 text-right text-neutral-400">延迟 {bufferFrames} 帧</span>
            </div>
            <p className="text-xs text-neutral-400">延迟越大越稳定，但操作会更迟缓；跨网可尝试 3–5 帧。</p>
            <div className="flex gap-2">
              <Button onClick={() => start('host')} className="flex-1">创建房间</Button>
              <input value={code} onChange={(event) => setCode(event.target.value)} placeholder="房间号"
                className="w-28 rounded-md border border-white/15 bg-neutral-800 px-3" />
              <Button variant="secondary" onClick={() => start('join', code)}>加入</Button>
            </div>
          </div>
        ) : (
          <div className="space-y-4">
            <div className="flex items-center justify-between rounded-md bg-neutral-800 p-3">
              <span>连接状态</span><strong>{label[linkState]} · {players}/2</strong>
            </div>
            {roomId && <div className="flex gap-2">
              <input readOnly value={roomId.toUpperCase()} className="min-w-0 flex-1 rounded-md border border-white/15 bg-neutral-800 px-3" />
              <Button variant="secondary" onClick={copyLink}>{copied ? '已复制' : '复制邀请'}</Button>
            </div>}
            {error && <p role="alert" className="text-rose-300">{error}</p>}
            <Button variant="secondary" onClick={reset} className="w-full">断开联机</Button>
          </div>
        )}
        {!started && error && <p role="alert" className="mt-3 text-rose-300">{error}</p>}
      </div>
    </div>
  )
}
