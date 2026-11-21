/*
  后台上传用的 Worker 短期凭据：登录的管理员不用再手填 Worker 的 ADMIN_TOKEN。

  为什么：2026-11-22 管理员把提示文字里的占位词「ADMIN_TOKEN」原样填进口令框，
  所有上传都是 401，而界面只说「口令错误」。口令本来就是服务端的东西，
  让人去抄一串密钥既容易抄错，又把长期密钥留在浏览器里。

  现在由服务端（/api/admin/rom-upload-credential，site:manage）签一张 12 小时的
  HMAC 凭据，Worker 用同一把 ROM_UPLOAD_SIGNING_SECRET 校验。凭据只存 sessionStorage，
  剩不到 3 小时就换新的。手填口令仍然优先：服务端没配签名密钥（503）时照旧手填。
*/
import { api, ApiError } from './api'
import { getRomAutoCredential, getRomManualToken, notifyRomConfigChanged, ROM_CREDENTIAL_KEY } from './roms'

const RENEW_BEFORE_MS = 3 * 3600_000

let inflight: Promise<void> | null = null
/** 服务端明确说没配签名密钥：本页不再反复请求，留给手填 */
let unavailable = false

export function romCredentialUnavailable() {
  return unavailable
}

export function ensureRomCredential(force = false): Promise<void> {
  if (getRomManualToken() || unavailable) return Promise.resolve()
  const current = getRomAutoCredential()
  if (!force && current && current.expiresAt - Date.now() > RENEW_BEFORE_MS) return Promise.resolve()
  if (inflight) return inflight
  inflight = (async () => {
    try {
      const data = await api.get<{ token?: string; expiresAt?: number }>('/api/admin/rom-upload-credential', true)
      if (typeof data?.token !== 'string' || typeof data.expiresAt !== 'number') return
      try {
        sessionStorage.setItem(ROM_CREDENTIAL_KEY, JSON.stringify({ token: data.token, expiresAt: data.expiresAt }))
      } catch {
        return
      }
      notifyRomConfigChanged()
    } catch (err) {
      // 503 = 服务端没配密钥；401 / 403 = 不是管理员。都安静地退回手填，不打扰界面
      if (err instanceof ApiError && (err.status === 503 || err.status === 403 || err.status === 401)) {
        if (err.status === 503) unavailable = true
        return
      }
      // 网络错误：下次调用再试
    } finally {
      inflight = null
    }
  })()
  return inflight
}
