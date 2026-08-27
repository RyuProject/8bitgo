import { useCallback, useState } from 'react'
import type { PlatformId } from '@/types'
import type { Translation } from '@/locales'
import { platforms, platformMap } from '@/data/platforms'
import { cx } from '@/lib/format'
import { useSeo } from '@/services/seo'
import { useT, fmt } from '@/services/i18n'
import { usePlatformBiosUrl } from '@/services/platformBios'
import { platformLabel } from '@/services/i18nData'
import { EmulatorPlayer } from '@/emulator'
import { getDefaultKeymap } from '@/lib/emulator'
import { isPlayable, resolveRuntime, runtimesFor } from '@/emulator'

function stepsFor(t: Translation) {
  return [
    { n: '01', title: t.playLocal.step1Title, desc: t.playLocal.step1Desc },
    { n: '02', title: t.playLocal.step2Title, desc: t.playLocal.step2Desc },
    { n: '03', title: t.playLocal.step3Title, desc: t.playLocal.step3Desc },
  ]
}

/**
 * 玩本地 ROM。
 *
 * 页面不再常驻「平台」选择器和「运行时」说明列表 —— 平台一律由 detect.ts 按文件头 /
 * 扩展名自动判断。只有在**识别不出平台**（比如内含单个 .bin 的 zip，detect 只会给
 * confidence: 'low' 且不给平台）时，才就地弹出一个平台选择让用户指定，选完立刻用
 * 同一个文件重跑。这样界面干净，又不会把这类文件卡死。
 */
export function PlayLocalPage() {
  const t = useT()
  const STEPS = stepsFor(t)
  useSeo({ title: t.playLocal.title, description: t.seo.playLocal })

  // 自动识别前的默认平台；识别成功后由 onPlatformChange 覆盖
  const [platformId, setPlatformId] = useState<PlatformId>('nes')
  /** 识别失败、等待用户手动指定平台的文件 */
  const [pendingFile, setPendingFile] = useState<File | null>(null)
  /** 用户选好平台后递给播放器重跑；每次都是新对象，所以同一个文件也能重试多次 */
  const [retryRequest, setRetryRequest] = useState<{ file: File } | null>(null)

  const platform = platformMap[platformId]

  const biosUrl = usePlatformBiosUrl(platform?.id)
  const playable = platforms.filter((p) => isPlayable(p.id))
  // 显示「这个平台实际会用哪个引擎」：按优先级取，与 resolveRuntime 的选法一致，
  // 否则 NES 会显示成 EmulatorJS，但实际跑的是 jsnes。
  const runtime = runtimesFor(platformId)[0] ?? resolveRuntime(platformId)

  // 这两个回调会进 EmulatorPlayer 内部 start() 的依赖，用 useCallback 固定住引用，
  // 免得本页每次重渲染都让播放器里的回调重新创建一遍。
  const handlePlatformChange = useCallback((id: PlatformId) => setPlatformId(id), [])
  const handleDetectFailed = useCallback((file: File) => {
    setPendingFile(file)
    return true
  }, [])

  const pickPlatform = (id: PlatformId) => {
    if (!pendingFile) return
    setPlatformId(id)
    setRetryRequest({ file: pendingFile })
    setPendingFile(null)
  }

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
          <h2 className="text-base font-bold">{t.playLocal.sectionKeymap}</h2>
          <div className="mt-3 grid grid-cols-3 gap-2">
            {getDefaultKeymap(runtime?.id).map((k) => (
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
              {t.playLocal.autoPlatform} {fmt(t.playLocal.runtimeSuffix, { name: runtime?.name ?? '—' })}
            </span>
          </h2>

          {/* 兜底：自动识别不出平台时才出现，选完立刻用同一个文件重跑 */}
          {pendingFile && (
            <div className="mb-3 rounded-xl border border-coin/50 bg-coin-soft p-3">
              <p className="text-sm text-fg">{fmt(t.playLocal.detectFailed, { name: pendingFile.name })}</p>
              <div className="mt-2.5 flex flex-wrap gap-1.5">
                {playable.map((p) => (
                  <button
                    key={p.id}
                    type="button"
                    onClick={() => pickPlatform(p.id)}
                    className={cx(
                      'inline-flex items-center gap-1.5 rounded-lg border border-line bg-surface px-2.5 py-1.5',
                      'text-xs transition hover:border-brand hover:bg-brand-soft hover:text-fg',
                    )}
                  >
                    <span aria-hidden>{p.icon}</span>
                    <span className="font-semibold">{p.shortName}</span>
                  </button>
                ))}
              </div>
            </div>
          )}

          <EmulatorPlayer
            platform={platform}
            gameName={`${platformLabel(t, platform.id, platform.name)} ROM`}
            icon="🔍"
            onDetectMismatch="switch"
            onPlatformChange={handlePlatformChange}
            onDetectFailed={handleDetectFailed}
            retryRequest={retryRequest}
            // 玩本地 ROM 也要给 BIOS：拖一个 Neo Geo ROM 进来，没有 BIOS 一样起不来。
            // 核心不给覆盖 —— 这里没有具体某一款游戏，只能按平台默认走
            biosUrl={biosUrl || undefined}
          />
          <p className="mt-3 text-xs leading-relaxed text-dim">{t.playLocal.disclaimer}</p>
        </div>
      </div>
    </div>
  )
}
