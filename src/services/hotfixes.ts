import { useEffect, useState } from 'react'
import { api } from './api'
import { coverCdnHint, onCnSite } from './cnHost'
import { setHotfixFlags, setHotfixSettle } from './hotfixFlags'
import { classifyUserAgent } from '../../shared/user-agent.js'
import { resolveHotfixes, type HotfixNoticeTemplate, type PublicHotfix, type ResolvedHotfixes } from '../../shared/hotfix.js'

/**
 * 浏览器这一头的 AI 临时修补：拉 /api/hotfixes，挑出管这一局的那几条，打开对应的退路。
 *
 * 白名单与匹配规则在 shared/hotfix.js（服务端校验过一次，这里再按白名单校验一次：
 * 缓存里的东西不可信）。每个动作背后都是播放器早就有的退路：
 *   set_core / set_runtime     → 详情页把 core / runtime 覆盖值传给 EmulatorPlayer（和后台逐游戏覆盖同一条路）；
 *   runtime_origin             → paths.ts 不再给运行时拼大陆加速入口；
 *   rom_host                   → romRoute.ts 的 chooseRomHost 直接返回指定线路；
 *   disable_engine_cache       → EmulatorJS 适配器本局关 IndexedDB 核心缓存；
 *   memory_rom                 → EmulatorJS 适配器 ROM 走内存；
 *   player_notice              → 详情页播放器上方显示一条提示（八种语言模板）。
 *
 * ⚠️ 修补要在玩家点「开始」之前定下来：详情页在 ready 之前把 ROM 当成「检查中」，
 * 避免一局开到一半核心 / 运行时被换掉。拉取最多等 LOAD_TIMEOUT_MS，接口挂了就当没有修补。
 */

const LOAD_TIMEOUT_MS = 1500
const REUSE_MS = 60_000

let loading: Promise<PublicHotfix[]> | null = null
let loadedAt = 0

/** 同一页内 60 秒复用一次结果；失败不缓存，下一次进详情页再试 */
export function loadHotfixes(): Promise<PublicHotfix[]> {
  if (typeof window === 'undefined') return Promise.resolve([])
  if (loading && Date.now() - loadedAt < REUSE_MS) return loading
  loadedAt = Date.now()
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), LOAD_TIMEOUT_MS)
  const job = api.get<{ items?: PublicHotfix[] }>('/api/hotfixes', false, controller.signal)
    .then((r) => (Array.isArray(r?.items) ? r.items : []))
    .catch(() => {
      if (loading === job) loadedAt = 0
      return [] as PublicHotfix[]
    })
    .finally(() => clearTimeout(timer))
  loading = job
  return job
}

export interface GameHotfix {
  /** 修补已经定下来（拉到了、超时了、或这一页不需要） */
  ready: boolean
  core?: string
  runtime?: string
  notice?: HotfixNoticeTemplate
  ids: string[]
}

const NONE: GameHotfix = { ready: true, ids: [] }

/** 当前浏览器的匹配上下文：和服务端给诊断包打标签用同一套 UA 归类 */
export function hotfixContext(slug: string, platform: string) {
  const ua = classifyUserAgent(typeof navigator === 'undefined' ? '' : navigator.userAgent)
  return { slug, platform, browser: ua.browser, os: ua.os, cn: coverCdnHint() === 'cn' || onCnSite() }
}

function toFlags(resolved: ResolvedHotfixes) {
  return {
    ids: resolved.ids,
    runtimeOrigin: resolved.runtimeOrigin,
    romHost: resolved.romHost,
    disableEngineCache: resolved.disableEngineCache,
    memoryRom: resolved.memoryRom,
  }
}

/**
 * 详情页用：这款游戏在这个浏览器上有没有生效的修补。SSR 阶段与 hydrate 前返回「未就绪」。
 * enabled=false（本地 ROM、直播观众等）直接返回「就绪、无修补」。
 */
export function useGameHotfix(slug: string | undefined, platform: string | undefined, enabled = true): GameHotfix {
  const key = enabled && slug && platform ? `${slug}|${platform}` : ''
  const [state, setState] = useState<{ key: string; value: GameHotfix }>({ key: '', value: { ready: false, ids: [] } })

  useEffect(() => {
    if (!key || !slug || !platform) return
    let alive = true
    const job = loadHotfixes()
    setHotfixSettle(job)
    void job.then((list) => {
      if (!alive) return
      const resolved = resolveHotfixes(list, hotfixContext(slug, platform))
      setHotfixFlags(toFlags(resolved))
      if (resolved.ids.length) {
        console.info(`[8bitgo/hotfix] 这一局套用 AI 临时修补 #${resolved.ids.join(', #')}`, resolved)
      }
      setState({ key, value: { ready: true, core: resolved.core, runtime: resolved.runtime, notice: resolved.notice, ids: resolved.ids } })
    })
    return () => {
      alive = false
      // 离开这款游戏：别把它的修补带到下一款
      setHotfixFlags(null)
      setHotfixSettle(null)
    }
  }, [key, slug, platform])

  if (!key) return NONE
  return state.key === key ? state.value : { ready: false, ids: [] }
}
