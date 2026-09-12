import type { PlatformId } from '@/types'
import { getDefaultKeymap, type KeymapRow, type KeySlot } from '@/lib/emulator'
import { cx } from '@/lib/format'

/**
 * 开局前那一屏的按键图。
 *
 * ## 它替掉了什么
 *
 * 原来这里是一行文字摘要（`⌨️ 方向键 ↑↓←→ · 按键 1 X · … · 投币 V · Start Enter`）。
 * 那一行有个绕不开的毛病：**长到必须截断**。街机是九行，截断之后「投币」和「Start」
 * 很容易被切掉，而这两个恰恰是唯一「不知道就开不了始」的键 —— 街机不投币按 Start
 * 什么都不会发生，玩家会以为站坏了。（那一行当初的取法是「头三行 + 末两行」，
 * 就是为了保住这两个。）画成图之后没有截断，这个取舍连同它的风险一起没了。
 *
 * ## 两种画法，按键位表自己选
 *
 *   1. **手柄轮廓** —— 十字键 + 面键 + 肩键 + Select/Start。红白机 / GB / SNES / GBA /
 *      MD 这些按键和手柄一一对应的，画出来一眼就知道手放哪儿。
 *   2. **键帽列** —— 一排「键帽 + 功能名」。街机（方向键 + 按键 1~6 + 投币 + Start）、
 *      J2ME（0–9 和两颗软键）这些**在手柄上没有固定位置**的，硬塞进轮廓只会画错。
 *
 * 判据是 `slot`（见 lib/emulator.ts 的 KeySlot）：认得出位置的行有槽位，认不出的没有。
 * 没槽位的行超过 LOOSE_MAX 条就整张退回键帽列 —— 一张大半是「散装键帽」的手柄图，
 * 还不如老老实实列一排。
 *
 * ⚠️ 这个组件只画在**开局前那块深色遮罩**上，所以配色是写死的 white/ 系列。
 * 要在浅色背景上用，得先把颜色抽出去，别直接搬。
 */

/** 没槽位的行最多几条还肯画手柄图。超过就整张退回键帽列 */
const LOOSE_MAX = 2

interface Props {
  runtimeId?: string
  platform?: PlatformId
  className?: string
}

/** 一颗键帽。`k` 是键盘上那颗键，`label` 是它在游戏里是什么 */
function Cap({ k, label, shape = 'square' }: { k: string; label?: string; shape?: 'square' | 'round' | 'pill' }) {
  return (
    <span className="flex flex-col items-center gap-1">
      <kbd
        className={cx(
          'flex items-center justify-center border border-white/25 bg-white/10 font-mono font-semibold text-white shadow-[0_1px_0_rgba(255,255,255,0.15)_inset] backdrop-blur',
          // 键名可能是「Shift」「小键盘 8」这种长的：方块和圆形给最小尺寸而不是固定尺寸，
          // 让它自己撑开，否则长键名会溢出到键帽外面
          shape === 'round'
            ? 'min-h-9 min-w-9 rounded-full px-2 text-sm'
            : shape === 'pill'
              ? 'min-h-8 rounded-full px-3 text-xs'
              : 'min-h-8 min-w-8 rounded-md px-1.5 text-sm',
        )}
      >
        {k}
      </kbd>
      {label && <span className="text-[10px] leading-none text-white/55">{label}</span>}
    </span>
  )
}

export function PadDiagram({ runtimeId, platform, className }: Props) {
  const { rows } = getDefaultKeymap(runtimeId, platform)
  if (!rows.length) return null

  const bySlot = new Map<KeySlot, KeymapRow>()
  const loose: KeymapRow[] = []
  for (const r of rows) {
    // 同一个槽位只认第一行。真出现重复是数据错了，画两颗不如画一颗
    if (r.slot && !bySlot.has(r.slot)) bySlot.set(r.slot, r)
    else loose.push(r)
  }

  const dpad = bySlot.get('dpad')
  /*
    画得成手柄图的条件：十字键有、Start 有、而且散装的行不多。
    少了十字键就没有「手柄」可言（J2ME 的数字键那种）；少了 Start 玩家开不了始。
  */
  const asPad = Boolean(dpad?.parts?.length === 4) && bySlot.has('start') && loose.length <= LOOSE_MAX

  if (!asPad) {
    return (
      <ul className={cx('flex max-w-lg flex-wrap items-start justify-center gap-x-3 gap-y-2', className)}>
        {rows.map((r) => (
          <li key={r.button}>
            <Cap k={r.key} label={r.button} />
          </li>
        ))}
      </ul>
    )
  }

  const [up, down, left, right] = dpad!.parts!
  const shoulderL = bySlot.get('l')
  const shoulderR = bySlot.get('r')
  /*
    面键的摆法分两种：
      四颗（SNES / NDS）-> 菱形，X 上 / Y 左 / A 右 / B 下，和真机一致。
      两颗（红白机 / GB / GBA）-> **并排**，B 左 A 右。
    两颗也走菱形的话，它们会落在「右」和「下」两格，看着是一条对角线，
    而真机上这两颗是并排的 —— 图和手感对不上，还不如不画图。
  */
  const diamond = bySlot.has('x') || bySlot.has('y')
  const facePos: Record<string, string> = {
    x: 'col-start-2 row-start-1',
    y: 'col-start-1 row-start-2',
    a: 'col-start-3 row-start-2',
    b: 'col-start-2 row-start-3',
  }
  const faceSlots = (['x', 'y', 'a', 'b'] as const).filter((sl) => bySlot.has(sl))

  return (
    <div className={cx('flex flex-col items-stretch gap-2', className)}>
      {/*
        肩键单独占一行，摆在两个簇**上面**。
        ⚠️ 别把它塞进各自的簇里：两个簇一个有肩键一个没有时，两边的十字键和面键
        会被顶得一高一低（肩键那一格把簇整个往下推），看着像画歪了。
        这一行的宽度由下面那行撑开，所以 L 正好在十字键上方、R 在面键上方。
      */}
      {(shoulderL || shoulderR) && (
        <div className="flex items-start justify-between px-1">
          {shoulderL ? <Cap k={shoulderL.key} label={shoulderL.button} shape="pill" /> : <span />}
          {shoulderR ? <Cap k={shoulderR.key} label={shoulderR.button} shape="pill" /> : <span />}
        </div>
      )}

      {/* items-start：两个簇按**顶边**对齐。十字键下面还有一行说明，按底边对齐就会错位 */}
      <div className="flex items-start justify-center gap-6 sm:gap-10">
        <div className="flex flex-col items-center gap-1.5">
          <div className="grid grid-cols-3 grid-rows-3 place-items-center gap-1">
            <span className="col-start-2 row-start-1">
              <Cap k={up} />
            </span>
            <span className="col-start-1 row-start-2">
              <Cap k={left} />
            </span>
            <span aria-hidden className="col-start-2 row-start-2 size-3 rounded-full bg-white/20" />
            <span className="col-start-3 row-start-2">
              <Cap k={right} />
            </span>
            <span className="col-start-2 row-start-3">
              <Cap k={down} />
            </span>
          </div>
          <span className="text-[10px] leading-none text-white/55">{dpad!.button}</span>
        </div>

        {faceSlots.length > 0 &&
          (diamond ? (
            <div className="grid grid-cols-3 grid-rows-3 place-items-center gap-1">
              {faceSlots.map((sl) => (
                <span key={sl} className={facePos[sl]}>
                  <Cap k={bySlot.get(sl)!.key} label={bySlot.get(sl)!.button} shape="round" />
                </span>
              ))}
            </div>
          ) : (
            // 并排时把 B 放左边、A 放右边 —— 真机上就是这个顺序
            <div className="flex items-center gap-2 self-center">
              {(['b', 'a'] as const)
                .filter((sl) => bySlot.has(sl))
                .map((sl) => (
                  <Cap key={sl} k={bySlot.get(sl)!.key} label={bySlot.get(sl)!.button} shape="round" />
                ))}
            </div>
          ))}
      </div>

      {/* 下面一排：Select（街机上是「投币」）、Start，再跟上塞不进轮廓的那一两条（红白机的连发） */}
      <div className="flex flex-wrap items-start justify-center gap-3">
        {(['select', 'start'] as const).map((sl) => {
          const r = bySlot.get(sl)
          return r ? <Cap key={sl} k={r.key} label={r.button} shape="pill" /> : null
        })}
        {loose.map((r) => (
          <Cap key={r.button} k={r.key} label={r.button} shape="pill" />
        ))}
      </div>
    </div>
  )
}
