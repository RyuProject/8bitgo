import { useEffect, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { logout, updateProfile, useAuthReady, useCurrentUser } from '@/services/auth'
import { openAuthModal } from '@/services/authModal'
import { useGamesBySlugs } from '@/services/gameCache'
import { cx } from '@/lib/format'
import { useSeo } from '@/services/seo'
import { useT, fmt } from '@/services/i18n'
import { Button } from '@/components/ui/Button'
import { GameCard } from '@/components/game/GameCard'
import { SectionHeader } from '@/components/ui/SectionHeader'
import { FEATURES } from '@/config/features'
import { GameGridSkeleton, SkeletonBlock } from '@/components/ui/PageSkeleton'

const AVATARS = ['🕹️', '👾', '🎮', '🍄', '⭐', '🐉', '🦔', '🤖', '👻', '🐱', '🔥', '💎']

export function ProfilePage() {
  const t = useT()
  // 个人中心是私人页面，不收录
  useSeo({ title: t.profile.title, noindex: true })
  const user = useCurrentUser()
  const navigate = useNavigate()

  const ready = useAuthReady()
  const [editing, setEditing] = useState(false)
  const [nickname, setNickname] = useState('')
  const [avatar, setAvatar] = useState('🕹️')
  const [error, setError] = useState<string | null>(null)

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

  const favorites = useGamesBySlugs(user.favorites)
  const recent = useGamesBySlugs(user.recent)

  const save = async () => {
    try {
      await updateProfile({ nickname, avatar })
      setEditing(false)
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : t.profile.saveFailed)
    }
  }

  return (
    <div className="container-x space-y-10 py-8 sm:py-10">
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
                <p className="mt-1 text-sm text-muted">
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
          <dl className={cx('grid shrink-0 gap-3 text-center sm:text-left', FEATURES.coins ? 'grid-cols-3' : 'grid-cols-2')}>
            {FEATURES.coins && (
              <div className="rounded-xl border border-coin/30 bg-coin-soft px-4 py-3">
                <dt className="text-[11px] text-muted">{t.profile.coins}</dt>
                <dd className="mt-1 text-xl font-semibold text-coin">🪙 {user.coins}</dd>
              </div>
            )}
            <div className="rounded-xl border border-line bg-surface-2 px-4 py-3">
              <dt className="text-[11px] text-muted">{t.profile.favorites}</dt>
              <dd className="mt-1 text-xl font-semibold">{favorites.length}</dd>
            </div>
            <div className="rounded-xl border border-line bg-surface-2 px-4 py-3">
              <dt className="text-[11px] text-muted">{t.profile.recent}</dt>
              <dd className="mt-1 text-xl font-semibold">{recent.length}</dd>
            </div>
          </dl>
        </div>
      </section>

      <section>
        <SectionHeader title={t.profile.favoritesTitle} subtitle={t.profile.favoritesSubtitle} icon="🕒" />
        {favorites.length ? (
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-6">
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
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-6">
            {recent.map((g) => (
              <GameCard key={g.slug} game={g} />
            ))}
          </div>
        ) : (
          <Empty text={t.profile.recentEmpty} />
        )}
      </section>
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
          <div className="grid grid-cols-2 gap-3">
            <SkeletonBlock className="h-16 w-24 rounded-xl" />
            <SkeletonBlock className="h-16 w-24 rounded-xl" />
          </div>
        </div>
      </section>
      <section aria-hidden>
        <SkeletonBlock className="mb-4 h-5 w-32" />
        <GameGridSkeleton
          count={6}
          coverRatio="landscape"
          className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-6"
        />
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
