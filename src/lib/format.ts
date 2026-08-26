import { getLang } from '@/services/lang'
import { getT, fmt } from '@/services/i18n'
import type { Lang } from '@/config/languages'

/**
 * 数字缩写是「分组习惯」的问题，不能只换单位词：
 *   中文 / 日文按四位分组（万 1e4、亿 1e8）
 *   西方语言按三位分组（K 1e3、M 1e6）
 * 所以除数由语言决定，单位词取自各语言文案里的 format.tenThousand / hundredMillion。
 */
const CJK_LANGS: Lang[] = ['zh-Hans', 'zh-Hant', 'ja']

const trim = (v: number) => v.toFixed(1).replace(/\.0$/, '')

/** 中文 12800 -> 1.3万；英文 12800 -> 12.8K */
export function formatCount(n: number): string {
  const lang = getLang()
  const t = getT().format
  const [big, small] = CJK_LANGS.includes(lang) ? [1_0000_0000, 1_0000] : [1_000_000, 1_000]
  if (n >= big) return fmt(t.hundredMillion, { n: trim(n / big) })
  if (n >= small) return fmt(t.tenThousand, { n: trim(n / small) })
  return n.toLocaleString(lang)
}

export function formatRating(r: number): string {
  return r.toFixed(1)
}

export function formatPlayers(players: number): string {
  const t = getT().format
  return players === 1 ? t.singlePlayer : fmt(t.nPlayers, { n: players })
}

/** 简单的字符串哈希，用于给封面挑选稳定的配色 */
export function hashString(str: string): number {
  let h = 2166136261
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return h >>> 0
}

export function cx(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(' ')
}
