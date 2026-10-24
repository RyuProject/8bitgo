import { useCallback, useState } from 'react'
import type { PlatformId } from '@/types'
import type { Translation } from '@/locales'
import { platforms, platformMap } from '@/data/platforms'
import { cx } from '@/lib/format'
import { useSeo } from '@/services/seo'
import { useT, fmt } from '@/services/i18n'
import { usePlatformBiosUrl } from '@/services/platformBios'
import { platformLabel } from '@/services/i18nData'
import { EmulatorPlayer } from '@/emulator/PlayerChunk'
import { KeymapCards } from '@/components/game/KeymapCards'
import { getRuntime, isPlayable, resolveRuntime, runtimesFor, type RuntimeId } from '@/emulator'
import type { RomDetection } from '@/emulator/detect'

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
 * 页面不再常驻「平台」选择器和「运行时」说明列表 —— 平台优先由 detect.ts 按文件头 /
 * 扩展名自动判断。只有识别不可靠时（例如内含单个 .bin 的 ZIP、CHD / PBP / CISO
 * 这类跨平台容器），才就地弹出一个经过缩小的平台选择；选完把用户确认一并传回播放器，
 * 不让默认 NES 平台吞掉这类文件。
 */
export function PlayLocalPage() {
  const t = useT()
  const STEPS = stepsFor(t)
  useSeo({ title: t.playLocal.title, description: t.seo.playLocal })

  // 自动识别前的默认平台；识别成功后由 onPlatformChange 覆盖
  const [platformId, setPlatformId] = useState<PlatformId>('nes')
  /** 识别失败、等待用户手动指定平台的文件 */
  const [pendingFile, setPendingFile] = useState<File | null>(null)
  /** 容器有合理候选时只给这些候选；完全认不出时才开放所有可用平台。 */
  const [pendingCandidates, setPendingCandidates] = useState<PlatformId[] | null>(null)
  const [pendingReason, setPendingReason] = useState<string | null>(null)
  /** 用户选好平台后递给播放器重跑；每次都是新对象，所以同一个文件也能重试多次 */
  const [retryRequest, setRetryRequest] = useState<{ file: File; confirmedPlatform?: boolean } | null>(null)
  /** 文件头 / mapper / 扩展名最终选出的运行时，不能用平台默认值冒充。 */
  const [activeRuntimeId, setActiveRuntimeId] = useState<RuntimeId | null>(null)
  /**
   * 手写的 FBNeo RomData（.dat）。
   *
   * 已知的改版包播放器会自己认出来并配好（见 emulator/arcadeHack.ts），
   * 这一栏是给**还没进指纹表**的包留的后门 —— 否则玩家手里一个自己找来的汉化版
   * 就只能对着「Romset is unknown」，而这恰恰是本地页最常见的失败。
   * 默认收起：绝大多数人玩的是原版包，不该被一栏看不懂的东西拦住。
   */
  const [romData, setRomData] = useState('')
  const [showRomData, setShowRomData] = useState(false)
  /**
   * 调试模式：在页面上直接展示「解密 → 识别 → 选引擎 → 挂载 → 出首帧」每个阶段的成败，
   * 并把模拟器引擎日志也抓出来。出错时据此判断是 ROM 不行、模拟器不支持还是别的环节出问题。
   * 默认关，避免普通玩家被一堆技术信息吓到。
   */
  const [debug, setDebug] = useState(false)
  /**
   * 这个本地文件需要哪个 BIOS **系统包**（`neogeo` / `pgm`，见 Game.arcadeBios）。
   *
   * 本地文件在库里没有记录，也就没有人替它填过这一格：识别得出平台的只有扩展名和文件头，
   * 而「PGM 板子要 pgm.zip、Neo Geo 要 neogeo.zip」是**核心靠 set 名**找的东西，
   * 猜不出来就只能手填。留空 = 照旧用平台级那一份（也就是加这个功能之前的行为）。
   */
  const [biosSet, setBiosSet] = useState('')

  const platform = platformMap[platformId]

  const biosUrl = usePlatformBiosUrl(platform?.id)
  const playable = platforms.filter((p) => isPlayable(p.id))
  // 显示「这个平台实际会用哪个引擎」：按优先级取，与 resolveRuntime 的选法一致，
  // 否则 NES 会显示成 EmulatorJS，但实际跑的是 jsnes。
  const defaultRuntime = runtimesFor(platformId)[0] ?? resolveRuntime(platformId)
  const runtime = (activeRuntimeId ? getRuntime(activeRuntimeId) : undefined) ?? defaultRuntime

  // 这两个回调会进 EmulatorPlayer 内部 start() 的依赖，用 useCallback 固定住引用，
  // 免得本页每次重渲染都让播放器里的回调重新创建一遍。
  const clearPending = useCallback(() => {
    setPendingFile(null)
    setPendingCandidates(null)
    setPendingReason(null)
    setActiveRuntimeId(null)
  }, [])
  const handlePlatformChange = useCallback((id: PlatformId) => {
    setPlatformId(id)
    clearPending()
  }, [clearPending])
  const handleDetectFailed = useCallback((file: File, detection: RomDetection) => {
    setPendingFile(file)
    setPendingCandidates(detection.candidates?.length ? detection.candidates : null)
    setPendingReason(detection.reason)
    return true
  }, [])
  const handleRuntimeChange = useCallback((next: { id: RuntimeId }) => setActiveRuntimeId(next.id), [])

  const pickPlatform = (id: PlatformId) => {
    if (!pendingFile) return
    setPlatformId(id)
    setRetryRequest({ file: pendingFile, confirmedPlatform: true })
    clearPending()
  }

  const pendingPlatforms = pendingCandidates?.length
    ? playable.filter((candidate) => pendingCandidates.includes(candidate.id))
    : playable

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
          <KeymapCards runtimeId={runtime?.id} platform={platformId} size="sm" />
        </div>

        <div className="lg:col-span-8">
          <h2 className="mb-3 text-base font-bold">
            {t.playLocal.sectionDrop}
            <span className="ml-2 text-xs font-normal text-muted">
              {t.playLocal.autoPlatform} {fmt(t.playLocal.runtimeSuffix, { name: runtime?.name ?? '—' })}
            </span>
          </h2>

          <label className="mb-3 inline-flex cursor-pointer items-center gap-2 text-xs text-muted">
            <input
              type="checkbox"
              checked={debug}
              onChange={(e) => setDebug(e.target.checked)}
              className="h-3.5 w-3.5 accent-brand"
            />
            调试模式（显示启动各阶段诊断与模拟器日志，方便定位是 ROM 不行还是模拟器不支持）
          </label>

          {/* 兜底：没有可靠结论才出现；盘类容器只展示实际可能的平台，避免误选。 */}
          {pendingFile && (
            <div className="mb-3 rounded-xl border border-coin/50 bg-coin-soft p-3">
              <p className="text-sm text-fg">{fmt(t.playLocal.detectFailed, { name: pendingFile.name })}</p>
              {pendingReason && <p className="mt-1 text-xs leading-relaxed text-muted">{pendingReason}</p>}
              <div className="mt-2.5 flex flex-wrap gap-1.5">
                {pendingPlatforms.map((p) => (
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
            onRuntimeChange={handleRuntimeChange}
            onDetectFailed={handleDetectFailed}
            onLocalFileSelected={clearPending}
            retryRequest={retryRequest}
            // 本地页专属：开启后界面展示启动各阶段的诊断与模拟器日志，便于定位故障
            debug={debug}
            // 玩本地 ROM 也要给 BIOS：拖一个 Neo Geo ROM 进来，没有 BIOS 一样起不来。
            // 核心不给覆盖 —— 这里没有具体某一款游戏，只能按平台默认走
            biosUrl={biosUrl || undefined}
            // 手写的 dat 压过播放器自己认出来的那份：人明确填了就听人的
            arcadeRomData={romData.trim() || undefined}
            // 同理：手填的 BIOS 系统名压过「按平台默认那份」
            arcadeBios={biosSet.trim().toLowerCase() || undefined}
          />
          {platformId === 'arcade' && (
            <div className="mt-3">
              <label htmlFor="local-bios-set" className="text-xs text-muted">
                {t.playLocal.biosLabel}
              </label>
              <input
                id="local-bios-set"
                className="mt-1 w-full max-w-xs rounded-lg border border-line bg-surface px-2 py-1.5 font-mono text-xs text-fg"
                value={biosSet}
                onChange={(e) => setBiosSet(e.target.value)}
                spellCheck={false}
                placeholder="pgm / neogeo"
              />
              <p className="mt-1 text-[11px] leading-relaxed text-dim">{t.playLocal.biosHint}</p>
              <button
                type="button"
                onClick={() => setShowRomData((v) => !v)}
                className="text-xs text-muted underline underline-offset-2 hover:text-fg"
              >
                {showRomData ? t.playLocal.romDataHide : t.playLocal.romDataShow}
              </button>
              {showRomData && (
                <div className="mt-2">
                  <textarea
                    className="h-40 w-full resize-y rounded-lg border border-line bg-surface px-2 py-2 font-mono text-xs leading-5 text-fg"
                    value={romData}
                    onChange={(e) => setRomData(e.target.value)}
                    spellCheck={false}
                    placeholder={`ZipName    wofcn
DrvName    wofj
FullName   Tenchi wo Kurau II (Edition Chinese)

tk2j23ccn.bin   0x080000   0xe1dd01d8   BRF_ESS BRF_PRG CPS1_68K_PROGRAM_NO_BYTESWAP`}
                  />
                  <p className="mt-1 text-[11px] leading-relaxed text-dim">{t.playLocal.romDataHint}</p>
                </div>
              )}
            </div>
          )}
          <p className="mt-3 text-xs leading-relaxed text-dim">{t.playLocal.disclaimer}</p>
        </div>
      </div>
    </div>
  )
}
