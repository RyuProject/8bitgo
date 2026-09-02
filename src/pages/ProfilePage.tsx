import { useEffect, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { fetchMyStats, logout, updateProfile, useAuthReady, useCurrentUser, type MeStats } from '@/services/auth'
import { openAuthModal } from '@/services/authModal'
import { useGamesBySlugs } from '@/services/gameCache'
import { cx } from '@/lib/format'
import { formatBytes } from '@/lib/emulator'
import { useSeo } from '@/services/seo'
import { useT, fmt } from '@/services/i18n'
import { platformLabel } from '@/services/i18nData'
import { useLang } from '@/services/lang'
import { Button } from '@/components/ui/Button'
import { GameCard } from '@/components/game/GameCard'
import { SectionHeader } from '@/components/ui/SectionHeader'
import { FEATURES } from '@/config/features'
import { GameGridSkeleton, SkeletonBlock } from '@/components/ui/PageSkeleton'
import { AccountSection } from '@/components/profile/AccountSection'
import { CloudSaves } from '@/components/profile/CloudSaves'
import { DangerZone } from '@/components/profile/DangerZone'

const AVATARS = ['🕹️', '👾', '🎮', '🍄', '⭐', '🐉', '🦔', '🤖', '👻', '🐱', '🔥', '💎']

const GRID = 'grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-6'

type Tab = 'games' | 'saves' | 'account'

export function ProfilePage() {
  const t = useT()
  const lang = useLang()
  // 个人中心是私人页面，不收录
  useSeo({ title: t.profile.title, noindex: true })
  const user = useCurrentUser()
  const navigate = useNavigate()

  const ready = useAuthReady()
  const [tab, setTab] = useState<Tab>('games')
  const [editing, setEditing] = useState(false)
  const [nickname, setNickname] = useState('')
  const [avatar, setAvatar] = useState('🕹️')
  const [error, setError] = useState<string | null>(null)
  const [stats, setStats] = useState<MeStats | null>(null)

  /**
   * ⚠️ 所有 hook 都必须在下面那两个提前 return 之前调用。
   *
   * 这里以前把 useGamesBySlugs 写在 `if (!user) return …` 后面 —— 登录态一确定下来，
   * 这一帧的 hook 数量就比上一帧多两个，React 直接抛
   * 「Rendered more hooks than during the previous render」，整页白屏。
   * 用户列表为空时传空数组是安全的，所以无条件调用它，不要「优化」回去。
   */
  const favorites = useGamesBySlugs(user?.favorites ?? [])
  const recent = useGamesBySlugs(user?.recent ?? [])

  // 等登录态确定后再弹登录框：hydration 首帧的 user 恒为 null（服务端不知道访客是谁），
  // 不等的话已登录用户刷新 /me 会先被弹一次登录框再自动关掉，页面明显闪一下。
  useEffect(() => {
    if (ready && !user) openAuthModal()
  }, [ready, user])

  useEffect(() => {
    if (user) {
      setNickname(user.nickname)
      setAvatar(user.avatar)
    }
  }, [user])

  // 统计跟着用户走：换绑邮箱、删存档之后 user 对象会变，顺手重算一次
  useEffect(() => {
    if (!user) {
      setStats(null)
      return
    }
    let alive = true
    void fetchMyStats().then((s) => {
      if (alive) setStats(s)
    })
    return () => {
      alive = false
    }
  }, [user])

  if (!ready) return <ProfileSkeleton />

  if (!user)
    return (
      <div className="container-x flex min-h-[60vh] flex-col items-center justify-center py-16 text-center">
        <div className="text-5xl" aria-hidden>
          🎮
        </div>
        <h1 className="mt-4 text-xl font-extrabold">{t.profile.guestTitle}</h1>
        <p className="mt-1.5 text-sm text-muted">{t.profile.guestSubtitle}</p>
        <Button size="lg" className="mt-5" onClick={openAuthModal}>
          {t.common.loginOrRegister}
        </Button>
      </div>
    )

  const save = async () => {
    try {
      await updateProfile({ nickname, avatar })
      setEditing(false)
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : t.profile.saveFailed)
    }
  }

  const TABS: Array<{ id: Tab; label: string }> = [
    { id: 'games', label: t.profile.title },
    { id: 'saves', label: t.account.savesTitle },
    { id: 'account', label: t.account.title },
  ]

  return (
    <div className="container-x space-y-8 py-8 sm:py-10">
      {/* 用户卡片 */}
      <section className="relative overflow-hidden rounded-card border border-line bg-surface p-6">
        <div className="pixel-grid absolute inset-0 opacity-30 [mask-image:linear-gradient(to_right,black,transparent)]" aria-hidden />
        <div className="relative flex flex-col gap-5 sm:flex-row sm:items-center">
          <span className="grid h-20 w-20 shrink-0 place-items-center rounded-2xl bg-brand-soft text-4xl" aria-hidden>
            {editing ? avatar : user.avatar}
          </span>
          <div className="min-w-0 flex-1">
            {editing ? (
              <div className="space-y-3">
                <input
                  value={nickname}
                  onChange={(e) => setNickname(e.target.value)}
                  maxLength={16}
                  className="h-10 w-full max-w-xs rounded-lg border border-line bg-surface-2 px-3 text-sm focus:border-brand focus:outline-none"
                  aria-label={t.profile.nickname}
                />
                <div className="flex flex-wrap gap-1.5">
                  {AVATARS.map((a) => (
                    <button
                      key={a}
                      type="button"
                      onClick={() => setAvatar(a)}
                      aria-pressed={avatar === a}
                      className={cx('grid h-9 w-9 place-items-center rounded-lg border text-lg transition', avatar === a ? 'border-brand bg-brand-soft' : 'border-line hover:border-line-strong')}
                    >
                      {a}
                    </button>
                  ))}
                </div>
                {error && <p className="text-xs text-live">{error}</p>}
                <div className="flex gap-2">
                  <Button size="sm" onClick={save}>
                    {t.common.save}
                  </Button>
                  <Button size="sm" variant="secondary" onClick={() => setEditing(false)}>
                    {t.common.cancel}
                  </Button>
                </div>
              </div>
            ) : (
              <>
                <h1 className="text-2xl font-extrabold">{user.nickname}</h1>
                <p className="mt-1 break-all text-sm text-muted">
                  {user.email} · {fmt(t.profile.joined, { date: user.createdAt })}
                </p>
                <div className="mt-3 flex flex-wrap gap-2">
                  <Button size="sm" variant="secondary" onClick={() => setEditing(true)}>
                    {t.profile.edit}
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => {
                      logout()
                      navigate('/')
                    }}
                  >
                    {t.common.logout}
                  </Button>
                </div>
              </>
            )}
          </div>
          {FEATURES.coins && (
            <div className="shrink-0 rounded-xl border border-coin/30 bg-coin-soft px-4 py-3 text-center sm:text-left">
              <p className="text-[11px] text-muted">{t.profile.coins}</p>
              <p className="mt-1 text-xl font-semibold text-coin">🪙 {user.coins}</p>
            </div>
          )}
        </div>
      </section>

      {/* 统计小卡片 */}
      <dl className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Stat label={t.profile.statsDays} value={stats ? String(stats.days) : '—'} />
        <Stat label={t.profile.favorites} value={String(stats?.favorites ?? favorites.length)} />
        <Stat label={t.profile.recent} value={String(stats?.recent ?? recent.length)} />
        {stats?.saves ? (
          <Stat label={t.profile.statsSaves} value={String(stats.saves.count)} sub={formatBytes(stats.saves.bytes)} />
        ) : (
          <Stat
            label={t.profile.statsTopPlatform}
            value={stats?.topPlatform ? platformLabel(t, stats.topPlatform, stats.topPlatform) : t.profile.statsNone}
          />
        )}
      </dl>

      {/* 分栏。个人中心装的东西越来越多，一路铺下去要滚很久才能到「账号与安全」 */}
      <div role="tablist" aria-label={t.profile.title} className="flex gap-1.5 overflow-x-auto">
        {TABS.map((x) => (
          <button
            key={x.id}
            role="tab"
            type="button"
            aria-selected={tab === x.id}
            onClick={() => setTab(x.id)}
            className={cx(
              'h-10 shrink-0 rounded-2xl border-2 px-4 text-sm font-bold transition',
              tab === x.id
                ? 'border-brand bg-brand text-white'
                : 'border-line-strong bg-surface text-fg hover:bg-surface-2',
            )}
          >
            {x.label}
          </button>
        ))}
      </div>

      {tab === 'games' && (
        <div className="space-y-10">
          <section>
            <SectionHeader title={t.profile.favoritesTitle} subtitle={t.profile.favoritesSubtitle} icon="🕒" />
            {favorites.length ? (
              <div className={GRID}>
                {favorites.map((g) => (
                  <GameCard key={g.slug} game={g} />
                ))}
              </div>
            ) : (
              <Empty text={t.profile.favoritesEmpty} />
            )}
          </section>

          <section>
            <SectionHeader title={t.profile.recentTitle} subtitle={t.profile.recentSubtitle} icon="🕘" />
            {recent.length ? (
              <div className={GRID}>
                {recent.map((g) => (
                  <GameCard key={g.slug} game={g} />
                ))}
              </div>
            ) : (
              <Empty text={t.profile.recentEmpty} />
            )}
          </section>
        </div>
      )}

      {/* 两个分栏都只在选中时挂载：云存档一挂载就会去拉列表，
          账号那块也没必要在用户压根没点开的时候先渲染出一堆表单 */}
      {tab === 'saves' && <CloudSaves />}

      {tab === 'account' && (
        <div className="space-y-4">
          <AccountSection user={user} />
          {/* 管理员不能自助注销（服务端也会拒），所以对他们直接不显示这块 */}
          {user.role !== 'admin' && <DangerZone email={user.email} />}
        </div>
      )}

      {stats?.lastPlayedAt && (
        <p className="text-xs text-dim">
          {t.profile.statsLastPlayed}
          {' · '}
          {new Intl.DateTimeFormat(lang, { dateStyle: 'medium' }).format(new Date(stats.lastPlayedAt))}
        </p>
      )}
    </div>
  )
}

function Stat({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="rounded-xl border border-line bg-surface-2 px-4 py-3">
      <dt className="text-[11px] text-muted">{label}</dt>
      <dd className="mt-1 truncate text-xl font-semibold" title={value}>
        {value}
      </dd>
      {sub && <dd className="text-[11px] text-dim">{sub}</dd>}
    </div>
  )
}

/** 登录态从本地恢复前先占住个人卡和游戏列表，避免已登录用户先看到一帧访客页。 */
function ProfileSkeleton() {
  return (
    <div className="container-x space-y-10 py-8 sm:py-10" aria-busy="true">
      <section className="rounded-card border border-line bg-surface p-6" aria-hidden>
        <div className="flex flex-col gap-5 sm:flex-row sm:items-center">
          <SkeletonBlock className="h-20 w-20 shrink-0 rounded-2xl" />
          <div className="min-w-0 flex-1">
            <SkeletonBlock className="h-7 w-40" />
            <SkeletonBlock className="mt-3 h-3 w-64 max-w-full" />
            <SkeletonBlock className="mt-4 h-8 w-20" />
          </div>
        </div>
      </section>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4" aria-hidden>
        {[0, 1, 2, 3].map((i) => (
          <SkeletonBlock key={i} className="h-[68px] rounded-xl" />
        ))}
      </div>
      <section aria-hidden>
        <SkeletonBlock className="mb-4 h-5 w-32" />
        <GameGridSkeleton count={6} coverRatio="landscape" className={GRID} />
      </section>
    </div>
  )
}

function Empty({ text }: { text: string }) {
  const t = useT()
  return (
    <div className="rounded-2xl border border-dashed border-line py-10 text-center text-sm text-muted">
      {text}，
      <Link to="/games" className="text-brand-hover hover:underline">
        {t.profile.goLibrary}
      </Link>
    </div>
  )
}
