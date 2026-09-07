import { useEffect, useState } from 'react'
import type { PlatformId } from '@/types'
import { getDefaultKeymap } from '@/lib/emulator'
import { comboLabel, getHotkeys, onHotkeysChange } from '@/services/hotkeys'
import { onPadKeysChange } from '@/services/padKeys'
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
  // 玩家在播放器里改了存读档快捷键或红白机键位，这张表得立刻跟上，不能还写着旧的
  useEffect(() => onHotkeysChange(() => bump((n) => n + 1)), [])
  useEffect(() => onPadKeysChange(() => bump((n) => n + 1)), [])

  const keymap = getDefaultKeymap(runtimeId, platform)
  const hotkeys = getHotkeys()

  /*
   * 存 / 读档快捷键是站点自己实现的（emulator/hotkeyBridge.ts 直接监听键盘）。
   *
   * ⚠️ 只在这一档**真的装得上**的时候才摆：EmulatorTools 那边是
   * `if (!caps.has('saveState')) return`，DOS / Java / 第三方 HTML5 / PS2 的运行时
   * 没有 saveState，快捷键根本没挂上去。以前无条件摆这两张卡，结果是那几个平台的
   * 「操作说明」整段只有两张卡、而且两张都按不出任何反应（Java 的 F2 还会被
   * FreeJ2ME 当成右软键按下去）。解绑了的（空串）同样不摆。
   */
  const rows = [
    ...keymap.rows,
    ...(keymap.quickSave && hotkeys['save:local']
      ? [{ button: t.keymap.quickSave, key: comboLabel(hotkeys['save:local']) }]
      : []),
    ...(keymap.quickSave && hotkeys['load:local']
      ? [{ button: t.keymap.quickLoad, key: comboLabel(hotkeys['load:local']) }]
      : []),
  ]

  const hasKeys = keymap.rows.length > 0
  /*
   * 「改键」这句话必须分档。红白机的改键面板是我们自己的（EmulatorTools 里的
   * NesKeyBinder，只在 runtimeId === 'jsnes' 时画）；EmulatorJS 的改键在**引擎自己**
   * 那条工具条上（画面里面的手柄图标 → Control Settings）。两条工具条上各有一个手柄
   * 图标，以前这句话不分档，等于把 GBA / 街机 / PS1 的玩家指到了没用的那一个上。
   */
  const rebindNote =
    keymap.rebind === 'ours'
      ? t.keymap.rebindOurs
      : keymap.rebind === 'engine'
        ? t.keymap.rebindEngine
        : hasKeys
          ? t.keymap.rebindNone
          : ''
  const touchNote =
    keymap.touch === 'all' ? t.keymap.touchButtons : keymap.touch === 'some' ? t.keymap.touchButtonsSome : ''
  const note = [
    hasKeys ? t.game.controlsDesc : '',
    keymap.note,
    rebindNote,
    keymap.pad ? t.keymap.gamepadAuto : '',
    touchNote,
  ]
    .filter(Boolean)
    .join(' ')

  /**
   * 2P 那一组。目前只有 jsnes 有（小键盘那一半是它默认表里本来就带的）。
   * 有第二组时才给第一组加「1P」小标题 —— 只有一组的时候标它反而是噪音。
   */
  const p2 = keymap.player2 ?? []
  const sm = size === 'sm'

  const seatLabel = cx('font-semibold text-muted', sm ? 'mt-3 text-[10px]' : 'mt-4 text-[11px]')
  const grid = cx('grid gap-2', sm ? 'mt-2 grid-cols-3' : 'mt-2 grid-cols-3 sm:grid-cols-5')

  const cards = (list: typeof rows) => (
    <div className={grid}>
      {list.map((k) => (
        <div
          key={k.button}
          className={cx('border border-line bg-surface', sm ? 'rounded-lg px-2.5 py-2' : 'rounded-xl px-3 py-2.5')}
        >
          <p className={cx('text-muted', sm ? 'text-[10px]' : 'text-[11px]')}>{k.button}</p>
          <p className={cx('font-mono font-semibold', sm ? 'text-xs' : 'mt-1 text-sm')}>{k.key}</p>
        </div>
      ))}
    </div>
  )

  return (
    <div className={className}>
      {note && <p className={cx('leading-relaxed text-muted', sm ? 'mt-1 text-xs' : 'mt-1 text-sm')}>{note}</p>}
      {p2.length > 0 && <p className={seatLabel}>1P</p>}
      {cards(rows)}
      {p2.length > 0 && (
        <>
          <p className={seatLabel}>2P</p>
          {cards(p2)}
          {keymap.player2Note && (
            <p className={cx('leading-relaxed text-muted', sm ? 'mt-2 text-xs' : 'mt-2 text-sm')}>
              {keymap.player2Note}
            </p>
          )}
        </>
      )}
    </div>
  )
}
