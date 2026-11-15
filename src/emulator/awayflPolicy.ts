/**
 * Flash 什么时候改用 AwayFL。
 *
 * 无 WebAssembly 时只自动接管单独在 AwayFL 上验证过的游戏；地址带 `?awayfl=1` 可供兼容性排查。
 * 判断放在 effect 里，避免 SSR 的 Node 环境与浏览器选出不同运行时。
 */
import { useEffect, useState } from 'react'
import type { PlatformId } from '@/types'
import { awayflVerifiedGame } from '../../shared/awayfl-games.js'
import { webAssemblyAvailable } from './browserSupport'

export const AWAYFL_QUERY = 'awayfl'

export function awayflForcedByUrl(search?: string): boolean {
  let query = search
  if (query === undefined) {
    try {
      query = typeof location === 'undefined' ? '' : location.search
    } catch {
      query = ''
    }
  }
  try {
    const value = new URLSearchParams(query).get(AWAYFL_QUERY)
    return value === '1' || value === 'true'
  } catch {
    return false
  }
}

export interface AwayflDecisionInput {
  platform: PlatformId | string
  slug?: string | null
  wasm: boolean
  forced?: boolean
}

export function shouldUseAwayfl({ platform, slug, wasm, forced }: AwayflDecisionInput): boolean {
  if (platform !== 'flash') return false
  if (forced) return true
  return !wasm && awayflVerifiedGame(slug)
}

export interface AwayflChoice {
  ready: boolean
  use: boolean
}

/** 游戏开局前确认运行时，避免自动开局先挂载仍依赖 WebAssembly 的 Ruffle。 */
export function useAwayflChoice(platform: PlatformId, slug: string | undefined): AwayflChoice {
  const isFlash = platform === 'flash'
  const [choice, setChoice] = useState<{ key: string; use: boolean } | null>(null)
  const key = `${platform}|${slug ?? ''}`
  useEffect(() => {
    if (!isFlash) return
    const forced = awayflForcedByUrl()
    const use = shouldUseAwayfl({ platform, slug, wasm: webAssemblyAvailable(), forced })
    if (use) console.warn(`[8bitgo/runtime] ${forced ? '地址带 ?awayfl=1' : '浏览器没有 WebAssembly'}，Flash 改用 AwayFL`)
    setChoice({ key, use })
  }, [isFlash, key, platform, slug])
  if (!isFlash) return { ready: true, use: false }
  return choice?.key === key ? { ready: true, use: choice.use } : { ready: false, use: false }
}
