import type { ReactNode } from 'react'
import { flagEmoji } from '@/services/presence'

/**
 * 国家码 -> 国旗展示节点。
 *
 * 绝大多数国家走 emoji 国旗（见 flagEmoji，零额外体积）。但 Apple 的 emoji 字体
 * 刻意不收录香港（HK）、澳门（MO）的国旗，这些码点在 macOS 上会回退成两位字母
 * 「HK / MO」，纯 emoji 救不了。这里给这类码点准备内联 SVG 兜底，让 Mac 上也能
 * 看到真正的旗帜。要加别的「emoji 字体不收」的码点，往 SVG_FLAGS 里补一项即可。
 */
const SVG_FLAGS: Record<string, ReactNode> = {
  HK: <HkFlag />,
  MO: <MoFlag />,
}

export function flagOrSvg(country: string | null | undefined): ReactNode {
  const cc = (country || '').toUpperCase()
  const svg = SVG_FLAGS[cc]
  if (svg) return svg
  return flagEmoji(country)
}

/** 香港特别行政区区旗：红底 + 白色洋紫荆（简化五瓣）。 */
function HkFlag() {
  const petals = [0, 72, 144, 216, 288].map((deg) => (
    <ellipse key={deg} cx="15" cy="7" rx="2.2" ry="5" fill="#fff" transform={`rotate(${deg} 15 10)`} />
  ))
  return (
    <svg viewBox="0 0 30 20" width="1.3em" height="0.9em" style={{ verticalAlign: '-0.1em' }} aria-hidden>
      <rect width="30" height="20" fill="#DE2910" />
      {petals}
      <circle cx="15" cy="10" r="1.4" fill="#DE2910" />
    </svg>
  )
}

/** 澳门特别行政区区旗：绿底 + 白色莲花（简化五瓣）+ 桥与水波。 */
function MoFlag() {
  const petals = [0, 72, 144, 216, 288].map((deg) => (
    <ellipse key={deg} cx="15" cy="8" rx="1.7" ry="3.6" fill="#fff" transform={`rotate(${deg} 15 11)`} />
  ))
  return (
    <svg viewBox="0 0 30 20" width="1.3em" height="0.9em" style={{ verticalAlign: '-0.1em' }} aria-hidden>
      <rect width="30" height="20" fill="#009B3A" />
      {petals}
      <rect x="10" y="15" width="10" height="1.2" fill="#fff" opacity="0.85" />
      <rect x="8" y="17" width="14" height="0.9" fill="#fff" opacity="0.6" />
    </svg>
  )
}
