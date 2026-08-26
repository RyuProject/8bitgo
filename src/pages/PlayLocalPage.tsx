import { useState } from 'react'
import type { PlatformId } from '@/types'
import type { Translation } from '@/locales'
import { platforms, platformMap } from '@/data/platforms'
import { cx } from '@/lib/format'
import { useSeo } from '@/services/seo'
import { useT, fmt } from '@/services/i18n'
import { platformLabel } from '@/services/i18nData'
import { EmulatorPlayer } from '@/components/player/EmulatorPlayer'
import { defaultKeymap } from '@/lib/emulator'
import { isPlayable, resolveRuntime, runtimes } from '@/runtimes/registry'

function stepsFor(t: Translation) {
  return [
    { n: '01', title: t.playLocal.step1Title, desc: t.playLocal.step1Desc },
    { n: '02', title: t.playLocal.step2Title, desc: t.playLocal.step2Desc },
    { n: '03', title: t.playLocal.step3Title, desc: t.playLocal.step3Desc },
  ]
}

export function PlayLocalPage() {
  const t = useT()
  const STEPS = stepsFor(t)
  useSeo({ title: t.playLocal.title, description: t.seo.playLocal })
  const [platformId, setPlatformId] = useState<PlatformId>('nes')
  const [auto, setAuto] = useState(true)
  const platform = platformMap[platformId]
  const supported = platforms.filter((p) => isPlayable(p.id))
  const unsupported = platforms.filter((p) => !isPlayable(p.id))
  const runtime = resolveRuntime(platformId)

  return (
    <div className="container-x py-8 sm:py-10">
      <div className="max-w-2xl">
        <span className="text-pixel text-[11px] text-brand-hover">LOCAL ROM</span>
        <h1 className="mt-2 text-3xl font-extrabold tracking-tight">{t.playLocal.h1}</h1>
        <p className="mt-3 leading-relaxed text-muted">{t.playLocal.intro}</p>
      </div>

      <ol className="mt-8 grid gap-4 sm:grid-cols-3">
        {STEPS.map((s) => (
          <li key={s.n} className="rounded-2xl border border-line bg-surface p-5">
            <span className="text-pixel text-[10px] text-coin">{s.n}</span>
            <p className="mt-2 font-bold">{s.title}</p>
            <p className="mt-1 text-sm leading-relaxed text-muted">{s.desc}</p>
          </li>
        ))}
      </ol>

      <div className="mt-10 grid gap-8 lg:grid-cols-12">
        <div className="lg:col-span-4">
          <h2 className="text-base font-bold">{t.playLocal.sectionPlatform}</h2>
          <button
            type="button"
            aria-pressed={auto}
            onClick={() => setAuto(true)}
            className={cx(
              'mt-3 flex w-full items-center gap-2 rounded-xl border px-3 py-2.5 text-left text-sm transition',
              auto ? 'border-brand bg-brand-soft text-fg' : 'border-line bg-surface text-muted hover:border-line-strong hover:text-fg',
            )}
          >
            <span aria-hidden>🔍</span>
            <span className="min-w-0">
              <span className="block font-semibold">{t.playLocal.autoDetect}</span>
              <span className="block text-[11px] opacity-70">{t.playLocal.autoDetectDesc}</span>
            </span>
          </button>
          <div className="mt-2 grid grid-cols-2 gap-2">
            {supported.map((p) => (
              <button
                key={p.id}
                type="button"
                aria-pressed={!auto && platformId === p.id}
                onClick={() => {
                  setAuto(false)
                  setPlatformId(p.id)
                }}
                className={cx(
                  'flex items-center gap-2 rounded-xl border px-3 py-2.5 text-left text-sm transition',
                  !auto && platformId === p.id
                    ? 'border-brand bg-brand-soft text-fg'
                    : 'border-line bg-surface text-muted hover:border-line-strong hover:text-fg',
                )}
              >
                <span aria-hidden>{p.icon}</span>
                <span className="min-w-0">
                  <span className="block truncate font-semibold">{p.shortName}</span>
                  <span className="block truncate text-[11px] opacity-70">
                    {resolveRuntime(p.id)?.name} · {p.romExtensions.slice(0, 3).join(' ')}
                  </span>
                </span>
              </button>
            ))}
          </div>
          {unsupported.length > 0 && (
            <p className="mt-3 text-xs text-dim">
              {fmt(t.playLocal.unsupportedList, {
                list: unsupported.map((p) => platformLabel(t, p.id, p.name)).join(t.player.extSep),
              })}
            </p>
          )}

          <h2 className="mt-8 text-base font-bold">{t.playLocal.sectionRuntime}</h2>
          <ul className="mt-3 space-y-2">
            {Object.values(runtimes).map((rt) => (
              <li key={rt.id} className={cx('rounded-lg border px-3 py-2 text-xs', runtime?.id === rt.id ? 'border-brand/60 bg-brand-soft' : 'border-line bg-surface')}>
                <span className="font-semibold text-fg">{rt.name}</span>
                <span className="mt-0.5 block text-muted">{rt.description}</span>
              </li>
            ))}
          </ul>

          <h2 className="mt-8 text-base font-bold">{t.playLocal.sectionKeymap}</h2>
          <div className="mt-3 grid grid-cols-3 gap-2">
            {defaultKeymap.map((k) => (
              <div key={k.button} className="rounded-lg border border-line bg-surface px-2.5 py-2">
                <p className="text-[10px] text-muted">{k.button}</p>
                <p className="font-mono text-xs font-semibold">{k.key}</p>
              </div>
            ))}
          </div>
        </div>

        <div className="lg:col-span-8">
          <h2 className="mb-3 text-base font-bold">
            {t.playLocal.sectionDrop}
            <span className="ml-2 text-xs font-normal text-muted">
              {auto
                ? t.playLocal.autoPlatform
                : fmt(t.playLocal.currentPlatform, { name: platformLabel(t, platform.id, platform.name) })}{' '}
              {fmt(t.playLocal.runtimeSuffix, { name: runtime?.name ?? '—' })}
            </span>
          </h2>
          <EmulatorPlayer
            key={auto ? 'auto' : platform.id}
            platform={platform}
            gameName={`${platformLabel(t, platform.id, platform.name)} ROM`}
            icon={auto ? '🔍' : platform.icon}
            onDetectMismatch={auto ? 'switch' : 'warn'}
            onPlatformChange={(id) => setPlatformId(id)}
          />
          <p className="mt-3 text-xs leading-relaxed text-dim">{t.playLocal.disclaimer}</p>
        </div>
      </div>
    </div>
  )
}
