import { useEffect, useRef, useState } from 'react'
import { EKA2L1_BUILD_ID, EKA2L1_RUNTIME_DIR } from '@/emulator/eka2l1Runtime'
import { useT } from '@/services/i18n'
import { fetchPlatformBios, platformBiosUrlSync, usePlatformBiosUrl } from '@/services/platformBios'
import { romIntegrityManifestUrl } from '@/services/romIntegrity'
import { useSeo } from '@/services/seo'

const EKA2L1_WEB_SOURCE = 'https://github.com/zixing131/EKA2L1-WEB'

/**
 * EKA2L1-WEB 自托管在 /eka2l1/v<构建哈希>/（scripts/build-eka2l1-web.mjs）。
 *
 * 必须整页跳转、不能 SPA 内嵌：模拟器是 pthread 构建，要 SharedArrayBuffer，只有带 COOP/COEP
 * 的顶层文档才有；服务端只给 /eka2l1/ 发这两个头，整站加会拦掉跨源封面和字体。
 */
export function SymbianPage() {
  const t = useT()
  useSeo({ title: t.browse.symbianPageTitle, description: t.browse.symbianPageIntro })
  const defaultFirmwareUrl = usePlatformBiosUrl('symbian')
  // SSR 时不知道浏览器能力，水合后再判断，避免服务端和客户端渲染不一致
  const [environment, setEnvironment] = useState<'checking' | 'ready' | 'unsupported'>('checking')
  const runtimeReady = Boolean(EKA2L1_BUILD_ID && EKA2L1_RUNTIME_DIR)
  const autoLaunchStarted = useRef(false)

  async function openEmulator() {
    // 刷新一次平台 BIOS 表，避免用户刚打开说明页时请求尚未完成就错过预置固件。
    await fetchPlatformBios(true)
    const firmwareUrl = platformBiosUrlSync('symbian') || defaultFirmwareUrl
    try {
      if (firmwareUrl) sessionStorage.setItem('8bitgo.eka2l1.defaultFirmwareUrl', firmwareUrl)
      else sessionStorage.removeItem('8bitgo.eka2l1.defaultFirmwareUrl')
      const integrityUrl = firmwareUrl ? romIntegrityManifestUrl(firmwareUrl) : null
      if (integrityUrl) sessionStorage.setItem('8bitgo.eka2l1.defaultFirmwareIntegrityUrl', integrityUrl)
      else sessionStorage.removeItem('8bitgo.eka2l1.defaultFirmwareIntegrityUrl')
    } catch {
      // 浏览器禁用 sessionStorage 时仍可手动在模拟器中选择固件。
    }
    // 整页导航才能让模拟器文档拿到 COOP/COEP；本站说明页本身不启用隔离。
    window.location.assign(`${EKA2L1_RUNTIME_DIR}index.html`)
  }

  useEffect(() => {
    if (!runtimeReady || environment !== 'ready' || autoLaunchStarted.current) return
    if (new URLSearchParams(window.location.search).get('launch') !== '1') return
    autoLaunchStarted.current = true
    void openEmulator()
  }, [environment, runtimeReady])

  useEffect(() => {
    let ok = window.isSecureContext && typeof WebAssembly === 'object' && typeof indexedDB !== 'undefined'
    let gl: WebGL2RenderingContext | null = null
    if (ok) {
      try {
        gl = document.createElement('canvas').getContext('webgl2')
        ok = Boolean(gl)
      } catch {
        ok = false
      }
    }
    // 能力探测只为显示提示；立即释放临时上下文，免得占着浏览器的 WebGL 配额。
    gl?.getExtension('WEBGL_lose_context')?.loseContext()
    setEnvironment(ok ? 'ready' : 'unsupported')
  }, [])

  return (
    <div className="container-x py-8 sm:py-10">
      <header className="max-w-3xl">
        <span className="text-pixel text-[11px] text-brand-hover">SYMBIAN · EKA2L1</span>
        <h1 className="mt-2 text-3xl font-extrabold tracking-tight">{t.browse.symbianPageTitle}</h1>
        <p className="mt-3 leading-relaxed text-muted">{t.browse.symbianPageIntro}</p>
      </header>

      <div className="mt-8 grid max-w-4xl gap-4 md:grid-cols-2">
        <section className="rounded-card border border-line bg-surface p-5">
          <h2 className="text-lg font-bold">{t.browse.symbianRequirementsTitle}</h2>
          <p className="mt-2 leading-relaxed text-muted">{t.browse.symbianRequirements}</p>
        </section>
        <section className="rounded-card border border-line bg-surface p-5">
          <h2 className="text-lg font-bold">{t.browse.symbianStepsTitle}</h2>
          <p className="mt-2 leading-relaxed text-muted">{t.browse.symbianSteps}</p>
        </section>
      </div>

      <p role="status" className="mt-4 max-w-4xl rounded-card border border-line bg-surface p-4 text-sm leading-relaxed text-muted">
        {defaultFirmwareUrl ? t.browse.symbianDefaultFirmwareReady : t.browse.symbianDefaultFirmwareMissing}
      </p>

      {environment === 'unsupported' && (
        <p role="alert" className="mt-6 max-w-4xl rounded-card border border-line bg-surface p-4 text-sm leading-relaxed">
          {t.browse.symbianUnsupported}
        </p>
      )}
      {!runtimeReady && (
        <p role="status" className="mt-4 max-w-4xl rounded-card border border-line bg-surface p-4 text-sm leading-relaxed text-muted">
          {t.browse.symbianNotReady}
        </p>
      )}

      <div className="mt-6 flex flex-wrap items-center gap-4">
        {/* 整页导航才能让模拟器文档拿到 COOP/COEP；本站说明页本身不启用隔离。 */}
        <button
          type="button"
          disabled={!runtimeReady || environment !== 'ready'}
          onClick={() => void openEmulator()}
          className="green-action inline-flex items-center justify-center px-5 py-3 font-semibold disabled:cursor-not-allowed disabled:opacity-50"
        >
          {t.browse.symbianOpen}
        </button>
        <a
          href={EKA2L1_WEB_SOURCE}
          target="_blank"
          rel="noopener noreferrer"
          className="text-sm font-semibold text-brand-hover underline underline-offset-4"
        >
          {t.browse.symbianSource}
        </a>
        {runtimeReady && (
          <a
            href={`${EKA2L1_RUNTIME_DIR}SOURCE.md`}
            target="_blank"
            rel="noopener noreferrer"
            className="text-sm text-muted underline underline-offset-4"
          >
            {t.browse.symbianChanges}
          </a>
        )}
      </div>
    </div>
  )
}
