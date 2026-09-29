/** Microsoft Clarity 的本地授权状态；不使用 Cookie 保存这项选择。 */
export type ClarityConsent = 'granted' | 'denied'

type ClarityApi = (typeof import('@microsoft/clarity'))['default']

const PROJECT_ID = (import.meta.env.VITE_CLARITY_PROJECT_ID || '').trim()
export const CLARITY_CONSENT_STORAGE_KEY = '8bit.clarity.consent.v1'

const CONSENT_CHANGED_EVENT = '8bitgo:clarity-consent-changed'
const OPEN_PREFERENCES_EVENT = '8bitgo:clarity-open-preferences'

let started = false
let loadedApi: ClarityApi | null = null
let memoryConsent: ClarityConsent | null = null

export function clarityConfigured() {
  return Boolean(PROJECT_ID)
}

export function readClarityConsent(): ClarityConsent | null {
  if (typeof window === 'undefined') return null
  try {
    const stored = window.localStorage.getItem(CLARITY_CONSENT_STORAGE_KEY)
    if (stored === 'granted' || stored === 'denied') return stored
  } catch {
    // Safari 私密模式等环境可能禁用 localStorage；当前标签页仍可用内存态完成选择。
  }
  return memoryConsent
}

/**
 * 项目 ID 或授权缺席时连 npm 分包都不下载，避免 SSR、开发环境或拒绝分析的访客
 * 意外向第三方发请求。这里也不调用 identify，账号身份不会自动交给第三方。
 */
export function initClarity() {
  if (
    started ||
    !PROJECT_ID ||
    typeof window === 'undefined' ||
    typeof document === 'undefined' ||
    readClarityConsent() !== 'granted'
  ) return

  started = true
  void import('@microsoft/clarity')
    .then(({ default: Clarity }) => {
      loadedApi = Clarity
      Clarity.init(PROJECT_ID)
      // 本站不投放广告；授权只开放站内行为分析所需的存储。
      Clarity.consentV2({ ad_Storage: 'denied', analytics_Storage: 'granted' })
    })
    .catch((error) => {
      // 分析服务不可用不能影响主站；允许同一标签页稍后重试初始化。
      started = false
      console.warn('[clarity] 初始化失败', error)
    })
}

export function setClarityConsent(consent: ClarityConsent) {
  if (typeof window === 'undefined') return
  memoryConsent = consent
  try {
    window.localStorage.setItem(CLARITY_CONSENT_STORAGE_KEY, consent)
  } catch {
    // 无持久化能力时只记当前标签页；不能因为分析授权失败影响主站。
  }

  if (consent === 'granted') {
    initClarity()
  } else if (loadedApi) {
    // 撤回后立即通知已加载的 SDK，并保证下次页面加载不再初始化。
    loadedApi.consentV2({ ad_Storage: 'denied', analytics_Storage: 'denied' })
    loadedApi.consent(false)
  }

  window.dispatchEvent(new CustomEvent(CONSENT_CHANGED_EVENT, { detail: consent }))
}

export function openClarityPreferences() {
  if (typeof window !== 'undefined') window.dispatchEvent(new Event(OPEN_PREFERENCES_EVENT))
}

export function onClarityConsentChanged(listener: () => void) {
  if (typeof window === 'undefined') return () => {}
  window.addEventListener(CONSENT_CHANGED_EVENT, listener)
  return () => window.removeEventListener(CONSENT_CHANGED_EVENT, listener)
}

export function onOpenClarityPreferences(listener: () => void) {
  if (typeof window === 'undefined') return () => {}
  window.addEventListener(OPEN_PREFERENCES_EVENT, listener)
  return () => window.removeEventListener(OPEN_PREFERENCES_EVENT, listener)
}
