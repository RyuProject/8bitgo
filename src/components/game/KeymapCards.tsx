import { useEffect, useState } from 'react'
import type { PlatformId } from '@/types'
import { getDefaultKeymap } from '@/lib/emulator'
import { comboLabel, getHotkeys, onHotkeysChange } from '@/services/hotkeys'
import { useT } from '@/services/i18n'
import { cx } from '@/lib/format'

/**
 * 「操作说明」那张键位表。游戏详情页和「玩本地游戏」页共用。
 *
 * 之所以抽出来，是因为这张表要说的话不止是键位本身：还得说清楚这一档能不能改键、
 * 键盘是不是直通给游戏的。两个页面各写一遍，迟早会有一边忘了改。
 *
 * 键位从 lib/emulator.ts 的 getDefaultKeymap 来（按运行时 + 平台分档），
 * 存 / 读档那两行从 services/hotkeys.ts 来（站点自己的快捷键，玩家能改）。
 */
interface Props {
  runtimeId?: string
  platform?: PlatformId
  /** 'sm' 是给窄栏用的（PlayLocalPage 的侧列） */
  size?: 'md' | 'sm'
  className?: string
}

export function KeymapCards({ runtimeId, platform, size = 'md', className }: Props) {
  const t = useT()
  const [, bump] = useState(0)
  // 玩家在播放器的存档面板里改了快捷键，这张表得立刻跟上，不能还写着旧的
  useEffect(() => onHotkeysChange(() => bump((n) => n + 1)), [])

  const keymap = getDefaultKeymap(runtimeId, platform)
  const hotkeys = getHotkeys()

  /*
   * 存 / 读档快捷键是站点自己实现的（emulator/hotkeyBridge.ts 直接监听键盘），
   * 跟底下跑的是哪个引擎无关 —— 所以键盘直通的那几种运行时也摆得出来，
   * 那种情况下这张表就只剩这两张卡。解绑了的（空串）不摆。
   */
  const rows = [
    ...keymap.rows,
    ...(hotkeys['save:local'] ? [{ button: t.keymap.quickSave, key: comboLabel(hotkeys['save:local']) }] : []),
    ...(hotkeys['load:local'] ? [{ button: t.keymap.quickLoad, key: comboLabel(hotkeys['load:local']) }] : []),
  ]

  const hasPad = keymap.rows.length > 0
  const note = [
    hasPad ? t.game.controlsDesc : '',
    keymap.note,
    hasPad ? (keymap.customizable ? `${t.keymap.customizable} ${t.keymap.gamepad}` : t.keymap.notCustomizable) : '',
  ]
    .filter(Boolean)
    .join(' ')

  const sm = size === 'sm'
  return (
    <div className={className}>
      {note && <p className={cx('leading-relaxed text-muted', sm ? 'mt-1 text-xs' : 'mt-1 text-sm')}>{note}</p>}
      <div className={cx('grid gap-2', sm ? 'mt-3 grid-cols-3' : 'mt-4 grid-cols-3 sm:grid-cols-5')}>
        {rows.map((k) => (
          <div
            key={k.button}
            className={cx('border border-line bg-surface', sm ? 'rounded-lg px-2.5 py-2' : 'rounded-xl px-3 py-2.5')}
          >
            <p className={cx('text-muted', sm ? 'text-[10px]' : 'text-[11px]')}>{k.button}</p>
            <p className={cx('font-mono font-semibold', sm ? 'text-xs' : 'mt-1 text-sm')}>{k.key}</p>
          </div>
        ))}
      </div>
    </div>
  )
}
