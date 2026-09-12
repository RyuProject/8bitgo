import { useCallback, useEffect, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { useAuthReady, useCurrentUser } from '@/services/auth'
import { openAuthModal } from '@/services/authModal'
import { useSeo } from '@/services/seo'
import { Button } from '@/components/ui/Button'
import { ApiError } from '@/services/api'
import { decideDeviceAuth, deviceAuthInfo, type DeviceAuthInfo } from '@/services/openApps'

/**
 * `/open/device` —— 设备码流程里**用户确认**那一步。
 *
 * 设备（比如一台 ESP32 做的掌机）上没有浏览器，弹不出授权页也接不住回调，
 * 所以它显示一串码，人到这一页来输。这一页做的就三件事：
 * 认这串码是哪个应用要的、把它要的权限一条条说清楚、让用户点同意或拒绝。
 *
 * ## 这一页刻意是中文的
 *
 * 和 /open、/admin 一样不走 i18n —— 理由见 OpenPlatformPage 的文件头：
 * 它说明的东西（scope 的语义、开放平台的文档）本身只有中文一份，
 * 给这一页翻八种语言而点进去的文档还是中文，是一种更糟的体验。
 *
 * ## ⚠️ 措辞上的一条底线
 *
 * 这一页是整个流程里**唯一**让用户看清「我在把什么交出去」的地方。
 * 所以权限必须逐条列出来、用大白话说，敏感的那几条要单独标出来；
 * 绝不能写成「授权该应用访问你的账号」这种糊弄话 —— 用户点了同意之后，
 * 这台设备就能一直读他的存档，而他以为自己只是让它登录了一下。
 */
export function OpenDevicePage() {
  useSeo({ title: '授权设备 · 8BitGo 开放平台', description: '确认一台设备的授权请求。', noindex: true })
  const [params] = useSearchParams()
  const authReady = useAuthReady()
  const user = useCurrentUser()

  /** 地址里带了码就直接填上（设备显示二维码时走的是这条） */
  const [code, setCode] = useState(params.get('code') ?? '')
  const [info, setInfo] = useState<DeviceAuthInfo | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  /** 'approved' | 'denied'，定了之后这一页就只显示结果 */
  const [done, setDone] = useState<'approved' | 'denied' | ''>('')

  const look = useCallback(async (raw: string) => {
    const clean = raw.trim()
    if (!clean) return
    setBusy(true)
    setError('')
    try {
      setInfo(await deviceAuthInfo(clean))
    } catch (e) {
      setInfo(null)
      setError(e instanceof ApiError ? e.message : '查不到这串码，确认一下有没有输错')
    } finally {
      setBusy(false)
    }
  }, [])

  /*
    带着 ?code= 进来、而且已经登录：自动查一次。
    ⚠️ 依赖里必须有 user —— 没登录时这个接口是 401，等他登录完要自己再查一次，
    否则他登录回来面对的是一句「查不到这串码」，只能手动再点一次。
  */
  useEffect(() => {
    const q = params.get('code')
    if (q && user) void look(q)
  }, [params, user, look])

  const decide = async (approve: boolean) => {
    setBusy(true)
    setError('')
    try {
      await decideDeviceAuth(code.trim(), approve)
      setDone(approve ? 'approved' : 'denied')
    } catch (e) {
      setError(e instanceof ApiError ? e.message : '操作失败，再试一次')
    } finally {
      setBusy(false)
    }
  }

  if (!authReady) return <div className="container-x py-16 text-sm text-muted">加载中…</div>

  if (!user) {
    return (
      <div className="container-x max-w-lg py-16">
        <h1 className="text-xl font-bold">授权设备</h1>
        <p className="mt-3 text-sm text-muted">
          要先登录，我们才知道这台设备是要读**谁**的收藏和存档。
        </p>
        <Button className="mt-5" onClick={() => openAuthModal()}>
          登录
        </Button>
      </div>
    )
  }

  if (done) {
    return (
      <div className="container-x max-w-lg py-16">
        <h1 className="text-xl font-bold">{done === 'approved' ? '已授权' : '已拒绝'}</h1>
        <p className="mt-3 text-sm text-muted">
          {done === 'approved'
            ? '回到那台设备上，它几秒内就会自己继续。这个页面可以关掉了。'
            : '那台设备不会拿到任何权限。'}
        </p>
      </div>
    )
  }

  return (
    <div className="container-x max-w-lg py-12">
      <h1 className="text-xl font-bold">授权设备</h1>
      <p className="mt-2 text-sm text-muted">把设备上显示的那串码输在这里。</p>

      <div className="mt-5 flex gap-2">
        <input
          value={code}
          onChange={(e) => setCode(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void look(code)
          }}
          placeholder="BCDF-GHJK"
          /* 大写 + 等宽 + 字距：用户是照着小屏幕一个字符一个字符核对的 */
          className="w-48 rounded-md border border-line bg-surface px-3 py-2 font-mono text-lg uppercase tracking-widest"
          autoComplete="off"
          spellCheck={false}
          aria-label="设备上显示的码"
        />
        <Button variant="secondary" disabled={busy || !code.trim()} onClick={() => void look(code)}>
          {busy ? '…' : '查一下'}
        </Button>
      </div>

      {error && <p className="mt-3 text-sm text-live">{error}</p>}

      {info && (
        <div className="mt-6 rounded-card border border-line bg-surface p-4">
          <p className="text-sm text-muted">下面这个应用想访问你的账号：</p>
          <p className="mt-1 text-base font-semibold text-fg">{info.app.name}</p>
          {info.app.homepage && (
            <a
              href={info.app.homepage}
              target="_blank"
              rel="noreferrer noopener"
              className="text-xs text-muted underline hover:text-brand"
            >
              {info.app.homepage}
            </a>
          )}

          {/*
            权限逐条列出来，敏感的单独标红。
            这是用户看清「我在交出什么」的唯一机会 —— 见文件头那段。
          */}
          <ul className="mt-4 space-y-2">
            {info.scopes.map((s) => (
              <li key={s.id} className="flex items-start gap-2 text-sm">
                <span aria-hidden className={s.sensitive ? 'text-live' : 'text-muted'}>
                  {s.sensitive ? '⚠️' : '·'}
                </span>
                <span>
                  <span className={s.sensitive ? 'font-semibold text-live' : 'text-fg'}>{s.desc}</span>
                  <span className="ml-2 font-mono text-[11px] text-dim">{s.id}</span>
                </span>
              </li>
            ))}
          </ul>

          {!info.allowed && <p className="mt-4 text-sm text-live">{info.reason}</p>}

          <div className="mt-5 flex gap-2">
            <Button disabled={busy || !info.allowed} onClick={() => void decide(true)}>
              同意
            </Button>
            <Button variant="secondary" disabled={busy} onClick={() => void decide(false)}>
              拒绝
            </Button>
          </div>
          <p className="mt-3 text-xs text-dim">
            只有你确实正在设置那台设备时才点同意。这串码是别人发给你的，就点拒绝。
          </p>
        </div>
      )}
    </div>
  )
}
