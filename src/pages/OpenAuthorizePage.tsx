import { useCallback, useEffect, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { useAuthReady, useCurrentUser } from '@/services/auth'
import { openAuthModal } from '@/services/authModal'
import { useSeo } from '@/services/seo'
import { Button } from '@/components/ui/Button'
import { ApiError } from '@/services/api'
import { authorizeInfo, decideAuthorize, statusLabel, type AuthorizeInfo } from '@/services/openApps'

/**
 * `/open/authorize` —— 授权码流程里**用户同意**那一步（给有浏览器的 Web 应用用）。
 *
 * 第三方的网站把用户浏览器重定向到这里，带上 client_id / redirect_uri / scope /
 * state / code_challenge 这些标准参数；这一页做的和 /open/device 是同一件事：
 * 认是哪个应用、把要的权限一条条说清楚、让用户点同意或拒绝，然后带着 code 跳回
 * 第三方的 redirect_uri。
 *
 * ## 这一页刻意是中文的
 *
 * 和 /open/device 一样不走 i18n —— 理由见 OpenDevicePage 的文件头：
 * scope 的语义、开放平台的文档本身只有中文一份。
 *
 * ## ⚠️ 措辞上的一条底线
 *
 * 这是整个流程里**唯一**让用户看清「我在把什么交出去」的地方。权限必须逐条列出来、
 * 用大白话说，敏感的那几条单独标出来；绝不能写成「授权该应用访问你的账号」这种糊弄话。
 */
export function OpenAuthorizePage() {
  useSeo({ title: '授权应用 · 8BitGo 开放平台', description: '确认一个应用的授权请求。', noindex: true })
  const [params] = useSearchParams()
  const authReady = useAuthReady()
  const user = useCurrentUser()

  const [info, setInfo] = useState<AuthorizeInfo | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  /** 'approved' | 'denied'，定了之后这一页就只显示结果 */
  const [done, setDone] = useState<'approved' | 'denied' | ''>('')

  /** 地址里的 OAuth 参数，POST 同意时要原样带回去给服务端再校验一遍 */
  const oauthParams = Object.fromEntries(params.entries())

  const load = useCallback(async () => {
    setBusy(true)
    setError('')
    try {
      setInfo(await authorizeInfo(oauthParams))
    } catch (e) {
      setInfo(null)
      setError(e instanceof ApiError ? e.message : '无法加载这个授权请求')
    } finally {
      setBusy(false)
    }
  }, [oauthParams])

  /*
    登录完才去取信息：没登录时这个接口是 401，等他登录回来要自己再取一次，
    否则面对的是一句「加载失败」，只能手动刷新。
  */
  useEffect(() => {
    if (user) void load()
  }, [user, load])

  /** 把回包里的 code / error / state 拼回第三方的 redirect_uri，整体跳走 */
  const finish = (r: { redirect_uri: string; state: string | null; code?: string | null; error?: string | null }) => {
    const u = new URL(r.redirect_uri)
    if (r.code) u.searchParams.set('code', r.code)
    if (r.error) u.searchParams.set('error', r.error)
    if (r.state) u.searchParams.set('state', r.state)
    window.location.assign(u.href)
  }

  const decide = async (approve: boolean) => {
    setBusy(true)
    setError('')
    try {
      const r = await decideAuthorize(oauthParams, approve)
      setDone(approve ? 'approved' : 'denied')
      finish(r)
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
        <h1 className="text-xl font-bold">授权应用</h1>
        <p className="mt-3 text-sm text-muted">
          要先登录，我们才知道这个应用是要读**谁**的收藏和存档。
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
        <p className="mt-3 text-sm text-muted">正在跳回那个应用…</p>
      </div>
    )
  }

  return (
    <div className="container-x max-w-lg py-12">
      <h1 className="text-xl font-bold">授权应用</h1>
      <p className="mt-2 text-sm text-muted">下面这个应用想访问你的 8BitGo 账号。</p>

      {error && <p className="mt-3 text-sm text-live">{error}</p>}

      {info && (
        <div className="mt-6 rounded-card border border-line bg-surface p-4">
          <p className="text-base font-semibold text-fg">{info.app.name}</p>
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
          {info.app.status !== 'live' && (
            <span className="ml-2 inline-block rounded bg-dim px-2 py-0.5 text-xs text-muted">
              {statusLabel({ status: info.app.status, reviewState: 'none' }).text}应用
            </span>
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

          {/*
            沙箱应用只能授权给开发者本人和测试账号（canAuthorize）。
            服务端在 GET 时就给出 allowed/reason，这里把同意按钮灰掉并说明原因，
            而不是甩一句报错 —— 用户才知道自己该去哪登记测试账号。
          */}
          {!info.allowed && <p className="mt-4 text-sm text-live">{info.reason}</p>}

          <div className="mt-5 flex gap-2">
            <Button disabled={busy || !info.allowed} onClick={() => void decide(true)}>
              {busy ? '…' : '同意'}
            </Button>
            <Button variant="secondary" disabled={busy} onClick={() => void decide(false)}>
              拒绝
            </Button>
          </div>
          <p className="mt-3 text-xs text-dim">
            只有你确实正在使用那个应用、且信任它时才点同意。
          </p>
        </div>
      )}
    </div>
  )
}
