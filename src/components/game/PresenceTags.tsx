import { useT, fmt } from '@/services/i18n'
import { useLang } from '@/services/lang'
import { cx } from '@/lib/format'
import {
  countryName,
  deviceEmoji,
  flagEmoji,
  netEmoji,
  presenceEmpty,
  type Presence,
} from '@/services/presence'

/**
 * 房主 / 成员名片上的三个小格子：用什么设备玩 💻📱、人在哪 🇨🇳、网络好不好 👌🀄️👎。
 *
 * 数据全部来自服务端（见 services/presence.ts 开头的说明），这里只管画。
 *
 * 两种用法：
 *   房主那一行  —— 三个格子都画，不知道就是 ❓。「不知道」本身是个有用的信息，
 *                  尤其是网络：房间刚开出来还没量到延迟，显示 ❓ 比显示 👌 诚实。
 *   手柄位小标签 —— skipUnknown，只画知道的那几个。四个位子各挂三个 ❓
 *                  会把那一排彻底糊住，而且什么也没告诉人。
 */
export function PresenceTags({
  presence,
  skipUnknown = false,
  className,
}: {
  presence: Presence | undefined
  /** 只画知道的那几格（给空间紧张的地方用） */
  skipUnknown?: boolean
  className?: string
}) {
  const t = useT()
  const lang = useLang()
  if (!presence) return null
  if (skipUnknown && presenceEmpty(presence)) return null

  const tr = t.rooms
  const deviceLabel =
    presence.device === 'desktop' ? tr.deviceDesktop : presence.device === 'mobile' ? tr.deviceMobile : tr.deviceUnknown
  const netLabel =
    presence.net === 'good'
      ? tr.netGood
      : presence.net === 'fair'
        ? tr.netFair
        : presence.net === 'poor'
          ? tr.netPoor
          : tr.netUnknown
  // 延迟是「房主到本站服务器」的，不是「你到房主」的 —— 画面走 WebRTC 直连，
  // 那条路服务器量不到。title 里把这句写清楚，别让人拿它当端到端延迟。
  const netTitle = presence.rtt === null ? netLabel : `${netLabel} · ${fmt(tr.netRtt, { ms: String(presence.rtt) })}`
  const flag = flagEmoji(presence.country)
  const regionTitle = presence.country ? countryName(presence.country, lang) : tr.regionUnknown

  const showDevice = !skipUnknown || presence.device !== 'unknown'
  const showRegion = !skipUnknown || Boolean(flag)
  const showNet = !skipUnknown || presence.net !== 'unknown'

  return (
    <span className={cx('inline-flex shrink-0 items-center gap-0.5 leading-none', className)}>
      {showDevice && (
        <span role="img" aria-label={deviceLabel} title={deviceLabel}>
          {deviceEmoji[presence.device]}
        </span>
      )}
      {showRegion && (
        <span role="img" aria-label={regionTitle} title={regionTitle}>
          {/* 国旗字形在 Windows 上会退化成「CN」两个字母，是有意接受的（见 flagEmoji） */}
          {flag || '❓'}
        </span>
      )}
      {showNet && (
        <span role="img" aria-label={netTitle} title={netTitle}>
          {netEmoji[presence.net]}
        </span>
      )}
    </span>
  )
}
