import { useState } from 'react'
import type { PlatformId } from '@/types'
import type { Translation } from '@/locales'
import { platformMap } from '@/data/platforms'
import { cx } from '@/lib/format'
import { useSeo } from '@/services/seo'
import { useT, fmt } from '@/services/i18n'
import { platformLabel } from '@/services/i18nData'
import { EmulatorPlayer } from '@/emulator'
import { defaultKeymap } from '@/lib/emulator'
import { resolveRuntime, runtimes, runtimesFor } from '@/emulator'

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
  // 平台完全由拖入的文件自动识别；这里的 platformId 只是识别结果的落点。
  const [platformId, setPlatformId] = useState<PlatformId>('nes')
  const [detected, setDetected] = useState(false)
  const platform = platformMap[platformId]
  // 显示「这个平台实际会用哪个引擎」：按优先级取，与 resolveRuntime 的选法一致，
  // 否则 NES 会显示成 EmulatorJS，但实际跑的是 jsnes。识别出平台之前不高亮任何一个。
  const runtime = detected ? (runtimesFor(platformId)[0] ?? resolveRuntime(platformId)) : null

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
          <h2 className="text-base font-bold">{t.playLocal.sectionRuntime}</h2>
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
              {detected
                ? fmt(t.playLocal.currentPlatform, { name: platformLabel(t, platform.id, platform.name) })
                : t.playLocal.autoPlatform}
              {runtime && ` ${fmt(t.playLocal.runtimeSuffix, { name: runtime.name })}`}
            </span>
          </h2>
          <EmulatorPlayer
            key="auto"
            platform={platform}
            gameName={`${platformLabel(t, platform.id, platform.name)} ROM`}
            icon="🔍"
            onDetectMismatch="switch"
            onPlatformChange={(id) => {
              setPlatformId(id)
              setDetected(true)
            }}
          />
          <p className="mt-3 text-xs leading-relaxed text-dim">{t.playLocal.disclaimer}</p>
        </div>
      </div>
    </div>
  )
}
