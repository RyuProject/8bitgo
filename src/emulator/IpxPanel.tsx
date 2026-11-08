/**
 * DOS IPX 联机面板。
 *
 * js-dos 的 IPX 是局域网数据报隧道，不会替游戏自动按下“开始网络游戏”；两端仍需在游戏内
 * 选择相同的 IPX/LAN 模式。这里负责开主机、按别名加入，以及生成可直接启动同一游戏的链接。
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { Button, buttonClasses } from '@/components/ui/Button'
import { useT } from '@/services/i18n'
import { createIpxAlias } from './ipxAddress'
import type { RuntimeHandle } from './types'

interface Props {
  handle: RuntimeHandle
  gameSlug?: string
  initialAddress?: string
  autoHost?: boolean
  onClose?: () => void
}

export function IpxPanel({ handle, gameSlug, initialAddress = '', autoHost = false, onClose }: Props) {
  const t = useT()
  const [address, setAddress] = useState('')
  const [input, setInput] = useState(initialAddress)
  const [busy, setBusy] = useState(false)
  const [mode, setMode] = useState<'host' | 'join' | null>(null)
  const [status, setStatus] = useState(handle.ipxStatus?.() ?? null)
  const [copied, setCopied] = useState(false)
  const [error, setError] = useState('')
  const autoHostStarted = useRef(false)
  const autoJoinStarted = useRef(false)

  const inviteLink = useMemo(() => {
    if (!address || !gameSlug) return ''
    const url = new URL(window.location.href)
    url.pathname = `/games/${encodeURIComponent(gameSlug)}`
    // 保留语言等页面偏好，但不能把旧房间/直播身份带进新邀请链接。
    for (const key of ['p2p', 'room', 'live', 'watch', 'ipx', 'jsnesp2p']) url.searchParams.delete(key)
    url.searchParams.set('ipx', address)
    return url.toString()
  }, [address, gameSlug])

  useEffect(() => {
    const timer = window.setInterval(() => setStatus(handle.ipxStatus?.() ?? null), 1000)
    return () => window.clearInterval(timer)
  }, [handle])

  const startHost = async () => {
    if (busy || !handle.openIpxHost) return
    setBusy(true)
    setError('')
    try {
      const bytes = new Uint8Array(8)
      window.crypto.getRandomValues(bytes)
      const alias = createIpxAlias(bytes)
      await handle.openIpxHost(alias)
      setAddress(alias)
      setInput(alias)
      setMode('host')
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t.player.ipxFailed)
    } finally {
      setBusy(false)
    }
  }

  const join = async (raw = input) => {
    if (busy || !handle.joinIpx) return
    let target = raw.trim()
    try {
      const url = new URL(target)
      target = url.searchParams.get('ipx') ?? target
    } catch {
      /* 也接受直接输入房间别名或数字 peer id。 */
    }
    if (!target) {
      setError(t.player.ipxAddressPlaceholder)
      return
    }
    setBusy(true)
    setError('')
    try {
      await handle.joinIpx(target)
      setAddress(target.replace(/^ipx=/i, '').toLowerCase())
      setMode('join')
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t.player.ipxFailed)
    } finally {
      setBusy(false)
    }
  }

  useEffect(() => {
    if (!initialAddress || autoJoinStarted.current) return
    autoJoinStarted.current = true
    void join(initialAddress)
    // 邀请地址是面板首次挂载时的快照；变化时由路由重新挂载播放器处理。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialAddress])

  useEffect(() => {
    if (!autoHost || initialAddress || autoHostStarted.current) return
    autoHostStarted.current = true
    void startHost()
    // StrictMode 重放时不重复注册别名或触发第二次 IPX 主机事件。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoHost, initialAddress])

  const leave = async () => {
    setBusy(true)
    try {
      await handle.closeIpx?.()
    } finally {
      setBusy(false)
      setMode(null)
      setAddress('')
      setStatus(handle.ipxStatus?.() ?? null)
      onClose?.()
    }
  }

  const copyLink = async () => {
    if (!inviteLink) return
    try {
      await navigator.clipboard.writeText(inviteLink)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1500)
    } catch {
      setError(t.player.ipxFailed)
    }
  }

  return (
    <div className="fixed inset-0 z-[80] flex items-center justify-center overflow-y-auto bg-black/55 p-4" role="dialog" aria-modal="true" aria-labelledby="jsdos-ipx-title">
      <div className="my-auto w-full max-w-md rounded-lg border border-white/10 bg-neutral-900 p-5 text-sm text-neutral-100 shadow-xl">
        <div className="mb-4 flex items-center justify-between gap-3">
          <h3 id="jsdos-ipx-title" className="text-base font-semibold">{t.player.ipxTitle}</h3>
          <button type="button" onClick={() => void leave()} disabled={busy} className={buttonClasses('ghost', 'sm')}>
            {t.common.close}
          </button>
        </div>

        {!mode ? (
          <div className="space-y-4">
            <p className="text-xs text-neutral-400">{t.player.ipxTip}</p>
            <Button className="w-full" onClick={() => void startHost()} disabled={busy}>
              {busy && autoHost ? t.player.matchOpening : t.player.ipxHost}
            </Button>
            <div className="flex gap-2">
              <input
                value={input}
                onChange={(event) => setInput(event.target.value)}
                onKeyDown={(event) => { if (event.key === 'Enter') void join() }}
                placeholder={t.player.ipxAddressPlaceholder}
                aria-label={t.player.ipxAddressPlaceholder}
                className="min-w-0 flex-1 rounded border border-white/10 bg-black/30 px-2 py-2 outline-none focus:border-white/30"
              />
              <Button variant="secondary" onClick={() => void join()} disabled={busy}>
                {t.player.ipxJoin}
              </Button>
            </div>
          </div>
        ) : (
          <div className="space-y-3">
            <div className="flex items-center justify-between text-neutral-300">
              <span>{mode === 'host' ? t.player.ipxHost : t.player.ipxJoin}</span>
              <span>{status?.peers ? t.player.ipxConnected : t.player.ipxWaiting}</span>
            </div>
            {status && <div className="text-xs text-neutral-400">{t.player.ipxPeerLabel}: {status.peerId || '—'} · {t.player.ipxPeerCount}: {status.peers}</div>}
            {mode === 'host' && inviteLink ? (
              <div className="flex items-center gap-2 rounded border border-white/10 bg-black/30 p-2">
                <input readOnly value={inviteLink} className="min-w-0 flex-1 truncate bg-transparent text-xs outline-none" aria-label={t.player.ipxInviteLink} />
                <Button size="sm" variant="secondary" onClick={() => void copyLink()}>
                  {copied ? t.player.ipxCopied : t.player.ipxCopy}
                </Button>
              </div>
            ) : (
              <p className="break-all rounded border border-white/10 bg-black/30 p-2 text-xs text-neutral-300">{address}</p>
            )}
            <p className="text-xs text-neutral-400">{t.player.ipxTip}</p>
            <div className="flex justify-end">
              <Button variant="secondary" onClick={() => void leave()} disabled={busy}>{t.player.ipxLeave}</Button>
            </div>
          </div>
        )}

        {error && <p role="alert" className="mt-3 text-xs text-red-400">{error}</p>}
      </div>
    </div>
  )
}
